import type { SessionId, WorkflowEscalatePort, WorkflowSubmitPort } from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type InstanceRef,
  type PersonaSpec,
  type SessionRef,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import {
  closeActorRuntimeAfterTurn,
  prepareActorRuntimeForDispose,
  type ActorRuntimeCleanupHost,
} from "./workflow-driver-cleanup.js";
import { createActorModelActivity, type RunStallClock } from "./workflow-driver-concurrency.js";
import { defer, effectiveActorName, resolveActorSessionId } from "./workflow-driver-helpers.js";
import { seedActorSession } from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

export interface WorkflowActorCreationHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly sink: WorkflowReportSink;
  readonly sessions: Map<string, SessionState>;
  readonly cleanupHost: ActorRuntimeCleanupHost;
  readonly stallClock: RunStallClock;
  isDisposed(): boolean;
  beginCreation(): void;
  endCreation(): void;
  makeSubmitPort(sessionId: SessionId): WorkflowSubmitPort;
  makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort;
}

/** 创建 seam 借用 driver 的同一 sessions 表与 dispose 计数，不新增资源状态 owner。 */
export async function createOwnedActorSession(
  host: WorkflowActorCreationHost,
  actor: ActorRef,
  persona: PersonaSpec,
  seed?: ActorSessionSeed,
): Promise<SessionRef> {
  if (host.isDisposed()) {
    throw new WorkflowError("DriverError", "Cannot create an actor session after driver dispose.");
  }
  const journaled = host.deps.journal.getActor(
    host.deps.runId ?? "run",
    actor.siteId,
    actor.ordinal,
  )?.sessionId;
  const sessionId = resolveActorSessionId(host.deps.runId ?? "run", actor, journaled);
  const ref: SessionRef = { id: sessionId };
  // 会话级 submit 端口：closure 绑定本会话，模型无法覆盖路由身份（instance 取自 currentInstance）。
  const submitPort = host.makeSubmitPort(sessionId);
  // 升级端口同构：同样按会话 closure 绑定，同样恒注入（见 ActorRuntimeFactory 的字段注释）。
  // persona 一并入 closure：有效名是**冻结**的（引擎在 createActor 时定下，此后不变），
  // 所以在这里算一次比每次 escalate 现查便宜，也不会中途换名。
  const escalatePort = host.makeEscalatePort(sessionId, actor, persona);
  // 模型活动面：准入端口随 runtime deps 下传（runner 每次尝试先过闸门），
  // waiting / executing 观察只在有在飞 ask、且它还没被引擎结算/取消时上报——迟到的观察对一个
  // 已完结的 ask 没有意义，引擎侧也会再挡一次。state 在下面才建，所以经 closure 晚绑定。
  let state: SessionState | undefined;
  const live = (): InstanceRef | undefined =>
    state === undefined || state.currentInstance === undefined || state.accepted || state.cancelled
      ? undefined
      : state.currentInstance;
  const modelActivity = createActorModelActivity({
    port: host.deps.concurrency,
    runId: host.deps.runId ?? "run",
    live,
    clock: host.deps.clock,
    handlers: {
      onActivity: (instance, activity) => host.sink.askActivity(instance, activity),
      // 子代理的第一笔工作区写入 ⇒ 引擎关导入缓存。
      onMutating: (instance) => host.sink.askMutating(instance),
      onWaiting: (info) => {
        const instance = live();
        if (instance !== undefined) host.sink.askWaiting(instance, info);
      },
      onExecuting: () => {
        const instance = live();
        if (instance !== undefined) host.sink.askExecuting(instance);
      },
      // run 级 stall 时钟的两个节拍：任一 actor 的成功归零、任一重试上膛。
      onRequestCompleted: () => host.stallClock.noteSuccess(),
      onRetryScheduled: (reason) => host.stallClock.noteRetryScheduled(reason),
    },
  });
  // submit profile：按 actor **站点**查——同一站点
  // 的每个 ordinal（fan-out 的每条 lane）跑的是同一组 ask 站点，profile 自然相同。缺席 = generic。
  const submitProfile = host.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
  // await：生产工厂在返回前把会话落库并建 task link（FK 要求 session 行先存在）。
  // 引擎的 ensureSession 会 await 本方法，所以第一次 ask 派发前持久化已完成。
  host.beginCreation();
  let runtime: AgentRuntime | undefined;
  const createState = (createdRuntime: AgentRuntime): SessionState => ({
    ref,
    sessionId,
    runtime: createdRuntime,
    submitProfile,
    currentTyped: false,
    accepted: false,
    cancelled: false,
    turnGeneration: 0,
    pendingEscalations: new Map(),
    escalationsUsed: 0,
    modelActivity,
    actor,
    actorName: effectiveActorName(persona),
    transientAttempts: 0,
  });
  try {
    const construction = host.deps.runtimeFactory({
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    runtime = construction.construct();
    // 工厂内部初始化抛错曾使 await 赋值失效，runtime/scope 无人关闭；首次 await 前接管。
    state = createState(runtime);
    host.sessions.set(sessionId, state);
    modelActivity.observe(runtime, sessionId);
    const createdRuntime = runtime;
    state.initialization = Promise.resolve().then(async () => {
      await construction.initialize(createdRuntime);
      if (seed !== undefined)
        await seedActorSession(host.deps, {
          journaledSessionId: journaled,
          runtime: createdRuntime,
          seed,
          sessionId,
        });
    });
    await state.initialization;
    state.initialization = undefined;
    if (host.isDisposed()) {
      // dispose 可能在 runtimeFactory/seed 的 await 中完成第一轮扫描；迟到 runtime
      // 必须先移交 sessions owner，再走同一 close/retry 链，不能成为无主资源。
      prepareActorRuntimeForDispose(state);
      closeActorRuntimeAfterTurn(host.cleanupHost, state);
    }
    return ref;
  } catch (error) {
    if (runtime !== undefined && state !== undefined) {
      // 工厂已创建 runtime 后 seed 仍可能失败；若只在 finally 递减 creation，dispose 会
      // 观察 sessions 为空并提前完成。失败 runtime 也要移交同一 map/retry 关闭链。
      if (!state.runtimeCloseCompletion) {
        state.runtimeCloseCompletion = defer<void>();
        host.deps.registerResidencyBlockingWork?.(state.runtimeCloseCompletion.promise);
      }
      prepareActorRuntimeForDispose(state);
      closeActorRuntimeAfterTurn(host.cleanupHost, state);
    }
    throw error;
  } finally {
    host.endCreation();
  }
}
