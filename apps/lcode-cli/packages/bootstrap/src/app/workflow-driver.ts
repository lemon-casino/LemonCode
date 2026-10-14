// WorkflowDriver 拥有 sessions、交互索引与 dispose/创建计数。
// 创建、turn、关闭 seam 只借用同一 owner；accept/reject/nudge/escalate 保持既有事件顺序。
import type { SessionId, WorkflowEscalatePort, WorkflowSubmitPort } from "@lcode/contracts";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@lcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { createSessionSubmitPort } from "./workflow-driver-submit-port.js";
import { executeWorkflowWorldWithEvidence } from "./workflow-world-evidence.js";
import {
  closeActorRuntimeAfterTurn,
  prepareActorRuntimeForDispose,
  type ActorRuntimeCleanupHost,
} from "./workflow-driver-cleanup.js";
import { createRunStallClock, type RunStallClock } from "./workflow-driver-concurrency.js";
import { runWorkflowTurn, type WorkflowTurnHost } from "./workflow-driver-turn.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  defer,
  mapViolations,
  sameAskAttempt,
  schemaEpilogue,
} from "./workflow-driver-helpers.js";
import { createOwnedActorSession } from "./workflow-driver-creation.js";
import type {
  AgentRuntimeWorkflowDriverDeps,
  Deferred,
  SessionState,
} from "./workflow-driver-types.js";

/**
 * WorkflowDriver 的真实实现。构造经 {@link createAgentRuntimeWorkflowDriver}（绑定 deps，回填 sink）。
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → 其所属会话，供 respondToSubmit / cancelAsk 反查。 */
  private readonly instanceToSession = new Map<string, SessionState>();
  /** qid → 停驻它的会话，供 respondToEscalation 反查（与 instanceToSession 同族）。 */
  private readonly qidToSession = new Map<string, SessionState>();
  /** per-run 单调的升级序号；qid 的第二段。与 runId 一起构成无碰撞的 id。 */
  private escalationSeq = 0;
  /** dispose 的一次性资源门；重复调用只用于立即重试仍由 sessions 持有的失败关闭项。 */
  private disposed = false;
  /** 所有 actor runtime 真正关闭后才完成；父 runtime 用它覆盖 settlement 后的异步清理窗口。 */
  private disposeCompletion?: Deferred<void>;
  /** runtimeFactory / seed 尚未移交 sessions map 的创建也属于 dispose owner。 */
  private actorSessionCreations = 0;
  /** 本 run 对治理器 cap 变化的订阅（run 级一次，dispose 时退订）。 */
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * 交给升级桥接（workflow-driver-escalation.ts）的宿主面：两张表按引用共享，序号与 record
   * 经闭包回到本类——私有状态不外露，桥接函数也不需要知道类的形状。
   */
  private readonly escalationHost: EscalationHost;
  /** turn 执行、收尾与模型失败收容借用同一 SessionState，不能另起状态 owner。 */
  private readonly turnHost: WorkflowTurnHost;
  /** close/retry 只借用会话状态；删除 sessions 与判定 dispose 完成仍回到本类。 */
  private readonly cleanupHost: ActorRuntimeCleanupHost;
  /** run 级 stall 时钟：所有 actor 的成功 / 重试节拍汇到这一只表。 */
  private readonly stallClock: RunStallClock;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    this.emit = deps.emit;
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.turnHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        runWorkflowTurn(this.turnHost, state, instance, input, epilogueStart),
      withdrawEscalations: (state) => this.withdrawEscalations(state),
    };
    this.cleanupHost = {
      deps,
      ownsSession: (state) => this.sessions.get(state.sessionId) === state,
      completeActorRuntimeClose: (state) => this.completeActorRuntimeClose(state),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    if (deps.concurrency !== undefined) {
      // 扇出只到在该 key 上有在飞/排队请求的 run，所以订阅本身可以在构造时一次做完。
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  async createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    return createOwnedActorSession(
      {
        deps: this.deps,
        sink: this.sink,
        sessions: this.sessions,
        cleanupHost: this.cleanupHost,
        stallClock: this.stallClock,
        isDisposed: () => this.disposed,
        beginCreation: () => {
          this.actorSessionCreations += 1;
        },
        endCreation: () => {
          this.actorSessionCreations = Math.max(0, this.actorSessionCreations - 1);
          this.resolveDisposeCompletionIfClosed();
        },
        makeSubmitPort: (sessionId) => this.makeSubmitPort(sessionId),
        makeEscalatePort: (sessionId, actor, persona) =>
          this.makeEscalatePort(sessionId, actor, persona),
      },
      actor,
      persona,
      seed,
    );
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      // 理论不会发生（引擎先建会话再 ask）；归一成 DriverError 上报而非静默。
      this.sink.askFailed(
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // 上一个 ask 若在异常路径上留下了停驻项（turn 被 abort 之外的方式打断），在这里一并撤下：
    // 新的 ask 一旦开跑，那些问题就再也不会有人读答案了，留在注册表里只会让快照说谎。
    this.withdrawEscalations(state);
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // per-ask 预算归零（nudge 走的是 runWorkflowTurn，不经这里——nudge 仍在同一个 ask 里）。
    state.escalationsUsed = 0;
    state.abortController = new AbortController();
    // 上一个 ask 的 waiting / executing 相位、工具计数都不能带到这个 ask 上；瞬态重驱计数同理。
    state.modelActivity.reset();
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // 质量尾注对 typed / untyped 一视同仁；schema 尾注只有 typed 有。两段都在 scheduler 算完
    // inputHash 之后追加，所以不进缓存身份。
    // typed ask 的 schema 尾注按 submit profile 分叉：mono 子代理的 schema 已在工具声明里，尾注只剩
    // 一句；generic 子代理照旧把整份 schema 写进尾注。守卫先跑：静态 profile 与这次 ask 不符时它会
    // 把会话降成 generic（或让 ask 失败），下面读到的就是修正后的形态。
    if (message.typed && !ensureSubmitProfileFits(this.deps, this.sink, state, instance, message)) {
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // 尾注边界：GUI 据此把尾注折进披露。指令正文
    // 之后全是引擎文本，边界就是正文长度；模型收到的仍是全文，持久 text part 也是。
    // fire-and-forget：绝不在 startAsk 内 await turn 完成（Boundary B 契约）。
    runWorkflowTurn(
      this.turnHost,
      state,
      instance,
      input,
      message.instructions.length,
      message.attachments,
    );
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined || !sameAskAttempt(state.currentInstance, instance) || state.cancelled)
      return;
    switch (verdict.kind) {
      case "accept": {
        state.modelActivity.flush();
        state.modelActivity.suspend();
        // 标记 accept：该 ask 的 turn resolve 时不再上报 askTurnEnded（引擎已 settleOk）。
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        state.modelActivity.flush();
        // 同 turn 内修复：handler 收到 {accept:false} 会抛错 → error tool_result → 模型重试。
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // turn 已结束、无 parked deferred：在同一持久 runtime 上发起一次全新 turn 促其提交。
        // nudge 整条都是引擎文本：边界 0。
        runWorkflowTurn(this.turnHost, state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined || !sameAskAttempt(state.currentInstance, instance) || state.cancelled)
      return;
    // 引擎主动取消（repair/nudge 预算耗尽、run 取消/失败）：中止在飞 turn，并解开可能挂起的 submit
    // deferred，避免 handler 永久阻塞；标记 cancelled 使 turn reject 不再上报 askFailed。
    state.cancelled = true;
    state.modelActivity.suspend();
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // 停驻中的升级问答与 submit deferred **同待遇**：一并拒绝，否则 `escalate` handler 会在一个
    // 已被取消的 ask 里永久阻塞。这条正是「无答案 = 无限期阻塞」的逃生舱（按设计不设超时）：
    // run cancel 与 CLI 进程亡故的行为因此与今天逐字节一致——ask 拒 Cancelled、run 转
    // Interrupted，resume 后该 ask 重跑、actor 重新提问并得到新 qid。
    this.withdrawEscalations(state);
    // 退避等待中的重驱一并撤下：ask 已被引擎结算，再起一轮只会对着一个没人听的节点烧 token。
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * run 结算后的资源释放（引擎在 run-settled 之后恰好调一次，见 WorkflowDriver.dispose）。
   *
   * 对每个 actor runtime 跑 app 关会话的**同一条**链——`closeBrowserSession` 内部依次
   * beginShutdown、node_repl 会话释放、浏览器会话关闭；不另造一套子代理关闭链，那会漂移。
   * 不关 execution / MCP / session store：子代理不拥有它们。有在飞 turn 的会话等它落地再关
   * （见 SessionState.turn）。成功项从 sessions 删除；失败项保留句柄并按确定性时钟重试，直到
   * runtime 的 release 与其余关闭步骤完成。交互反查表在首次 dispose 时立即清空。
   */
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.stallClock.dispose();
      this.disposeCompletion = defer<void>();
      this.deps.registerResidencyBlockingWork?.(this.disposeCompletion.promise);
      for (const state of this.sessions.values()) {
        prepareActorRuntimeForDispose(state);
      }
      this.concurrencyUnsubscribe?.();
      this.instanceToSession.clear();
      this.qidToSession.clear();
    }
    for (const state of this.sessions.values()) closeActorRuntimeAfterTurn(this.cleanupHost, state);
    this.resolveDisposeCompletionIfClosed();
  }

  private completeActorRuntimeClose(state: SessionState): void {
    state.cancelRuntimeCloseRetry?.();
    state.cancelRuntimeCloseRetry = undefined;
    if (this.sessions.get(state.sessionId) === state) this.sessions.delete(state.sessionId);
    state.runtimeCloseCompletion?.resolve();
    this.resolveDisposeCompletionIfClosed();
  }

  private resolveDisposeCompletionIfClosed(): void {
    if (this.disposed && this.sessions.size === 0 && this.actorSessionCreations === 0) {
      this.disposeCompletion?.resolve();
    }
  }

  /**
   * 结算一个停驻中的升级问答（run service 经注册表调进来）。实现体在
   * workflow-driver-escalation.ts（{@link respondToParkedEscalation}），这里只做委托。
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /** 撤下某会话上所有停驻中的升级问答；实现体见 {@link withdrawSessionEscalations}。 */
  private withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * 世界读取：整段委托给 {@link executeWorldRead}（workflow-world-read.ts）。
   *
   * 这里只做转发，是因为世界读取与本文件的其余部分**没有共同状态**：它不碰 actor 会话、
   * 不碰 turn、不碰 submit 桥接，只需要三样东西（两个端口加一个 cwd）。分出去之后本文件
   * 只剩"会话与 turn 的编排"这一件事，而 op 元数、上限执行、git 的固定 argv 集中在一处。
   */
  async executeWorldRead(
    op: WorldReadOp,
    args: unknown[],
    execution?: { runId: string; instance: InstanceRef },
  ): Promise<unknown> {
    return await executeWorkflowWorldWithEvidence(this.deps, op, args, execution);
  }

  /**
   * 用户面产物的发布：整段委托给 {@link executeArtifactPublish}（workflow-artifact-publish.ts），
   * 理由与上面的世界读取逐字相同——它与本文件没有共同状态，只需要两个端口、一个 cwd 与
   * 一个会话 id。
   *
   * 方法在 Boundary B 上是**可选**的（`executeArtifactPublish?`），而本 driver 恒实现它：
   * 「有没有存储」是装配事实，由 deps 里的 `artifactStore` 表达并在那一侧大声失败，不该由
   * 「方法在不在」这条第二条通道再表达一次（两条通道会给同一件事两种失败形态）。
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    return await executeArtifactPublish(this.deps, request);
  }

  // ——————————————————————————————— 内部：submit 桥接 ———————————————————————————————

  /** 造一个会话级 submit 端口：submit_result handler mid-turn 调用它并阻塞等裁决。 */
  private makeSubmitPort(sessionId: SessionId): WorkflowSubmitPort {
    return createSessionSubmitPort(sessionId, this.sessions, this.sink);
  }

  // ——————————————————————————————— 内部：升级问答桥接 ———————————————————————————————

  /**
   * 造一个会话级升级端口；实现体在 workflow-driver-escalation.ts（{@link makeSessionEscalatePort}），
   * 与 {@link makeSubmitPort} 逐条对称的论证也写在那边。
   */
  private makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   * 一条 driver 侧事件的双轨落地：durable 进 `dwf_event`，实时经 emit 扇出。
   *
   * 与引擎的 `record()`（engine.ts）逐字节同形，且顺序不可换：launch 侧的 sequence 截取靠
   * 「appendEvent 之后同步紧接着 emit、同一个事件对象引用」这个前提把刚分配到的 sequence 交给
   * emit（dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * 造一个绑定了 deps 的 driver 工厂，直接充当 harness 的 makeDriver。journal 与 emit 由 deps 提供，
 * 调用方（测试/生产）持有其引用以做断言与 Boundary C 扇出。
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { createActorRuntimeCloseRetryTimer } from "./workflow-driver-cleanup.js";
export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
