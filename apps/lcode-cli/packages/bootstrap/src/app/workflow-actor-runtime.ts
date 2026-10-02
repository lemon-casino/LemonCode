// ============================================================
// Workflow actor runtime：模型绑定与会话接入
// ============================================================
// launch 已取得 run-level lease 并读取启动快照；这里只消费同一份冻结配置，不重新采样父模型或 lineage。
// 读取旧绑定 → 构造 runtime（构造期接 event sink）→ 写完整模型绑定 → 重水化，或先落会话再建 link。
// sessions 与 runtime 关闭仍归 driver，run 注册表与 lineage lease 仍归原 lifecycle owner。

import { randomUUID } from "node:crypto";
import { CoreErrorType, type CreateSessionTaskLinkInput, type SessionId } from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";
import {
  refToString,
  type ActorRef,
  type JournalStorePort,
  type WorkflowActorModelOverride,
} from "@lcode/dynamic-workflow";
import type { ModelSelection } from "@lcode/shared/model-selection";
import type { RunActorModelConfiguration } from "./dynamic-workflow-run-launch-anchor.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";
import {
  workflowActorModelPolicy,
  type WorkflowActorModelBinding,
} from "./workflow-actor-model.js";
import type { ActorRuntimeFactory } from "./workflow-driver-types.js";

type ActorRuntimeDeps = Pick<
  DynamicWorkflowRunServiceDeps,
  "journal" | "createActorRuntime" | "taskLinkStore" | "logger"
>;

export function createWorkflowActorRuntimeFactory(input: {
  deps: ActorRuntimeDeps;
  runId: string;
  parentSessionId?: string;
  executionFailoverLineageId?: string;
  recordedActorModels: RunActorModelConfiguration;
  runSubagentModel?: ModelSelection;
}): ActorRuntimeFactory {
  const {
    deps,
    runId,
    parentSessionId,
    executionFailoverLineageId,
    recordedActorModels,
    runSubagentModel,
  } = input;
  return async ({
    sessionId,
    actor,
    persona,
    escalatePort,
    seed,
    submitPort,
    submitProfile,
    modelRequestAdmission,
  }) => {
    const approvedActorModel = matchActorModelOverride(
      recordedActorModels.overrides,
      actor,
      persona.name,
    );
    const modelPolicy = workflowActorModelPolicy(
      {
        ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
        ...(recordedActorModels.defaultProvenance === undefined
          ? {}
          : { runProvenance: recordedActorModels.defaultProvenance }),
        ...(persona.model === undefined ? {} : { scriptSelection: persona.model }),
        ...(approvedActorModel === undefined ? {} : { approvedSelection: approvedActorModel }),
      },
      persistedActorModelBinding({ actor, journal: deps.journal, runId }),
      seedActorModelBinding(seed),
    );
    const runtime = deps.createActorRuntime({
      runId,
      sessionId,
      actor,
      persona,
      submitPort,
      // 工厂据 profile 决定端口是否注入、声明是否 typed（create-app.ts 的 createActorRuntime）。
      submitProfile,
      ...(executionFailoverLineageId ? { executionFailoverLineageId } : {}),
      // 请求级准入端口与两个工具端口同路下传到 runtime deps。
      ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
      // 升级端口与 submit 端口同路下传：core 侧的注册门以端口存在为准，所以恒传。
      escalatePort,
      ...(modelPolicy.configOverrides.modelSelection === undefined
        ? {}
        : { actorModelSelection: modelPolicy.configOverrides.modelSelection }),
      actorModelProvenance: modelPolicy.provenance,
      onExecutionFailoverSelection: (selection) =>
        journalActorResolvedModel({
          actor,
          journal: deps.journal,
          selection,
          modelProvenance: modelPolicy.provenance,
          runId,
        }),
    });
    // runtime selection 与 policy provenance 共同构成 actor 的持久模型绑定。先落库再接入会话：
    // 一次失败的会话持久化会让这次 ask 失败，但当时采用的完整绑定仍留在 journal 里。
    // rehydrate 路径也要写，旧行的 NULL provenance 已由 modelPolicy 按兼容规则解释。
    journalActorResolvedModel({
      actor,
      journal: deps.journal,
      selection: requireActorModelSelection(runtime, actor),
      modelProvenance: modelPolicy.provenance,
      runId,
    });
    const attached = await attachActorSession({ actor, deps, runId, runtime, sessionId });
    if (attached === "rehydrated") return runtime;
    await persistActorSession({ actor, deps, parentSessionId, runId, runtime, sessionId });
    return runtime;
  };
}

/**
 * resume 重水化：journal 已记录该 actor 的会话 id ⇒ 这是一次重挂（会话行与消息早已落库，
 * `mintActorSessionId` 纯确定所以 sessionId 就是当年那一个，driver 侧另有互证）。
 * `resumeFromStore` 从落库的 message/part 行重建 messageHistory——被打断的 tool call 会被
 * hydrator 钉成 "[Tool execution was interrupted before resume]"，正是被杀 ask 的正确语义。
 *
 * `SessionNotFound`（会话行被清理）不是错误而是记录在案的例外：退回全新持久化路径，actor 从空上下文重来——比让整个 run 卡死诚实。
 * 其余异常原样上抛（低层不吞错，house rule）。
 */
async function attachActorSession(input: {
  actor: ActorRef;
  deps: ActorRuntimeDeps;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<"fresh" | "rehydrated"> {
  const { actor, deps, runId, runtime } = input;
  const journaledSessionId = deps.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId;
  if (journaledSessionId === undefined) return "fresh";
  try {
    await runtime.resumeFromStore();
    // 会话行、task link 都在上一世落库过（两者皆 upsert），重挂不再重建。
    return "rehydrated";
  } catch (error) {
    if (!isSessionNotFound(error)) throw error;
    deps.logger?.warn?.("Dynamic workflow actor session pruned; starting fresh", {
      actor: refToString(actor),
      event: "dynamic_workflow.actor.rehydrate_fallback",
      module: "bootstrap.app",
      runId,
      sessionId: input.sessionId,
    });
    return "fresh";
  }
}

/** 结构化判定 core 的 SessionNotFound（不依赖错误文本做流程判断）。 */
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.SessionNotFound
  );
}

/**
 * actor 会话真实化：落会话行 + 建 task link（legacy 路径的示范在
 * script-workflow-runtime.ts）。
 *
 * 顺序是**载荷性**的：`session_task_link.child_session_id` 对 `session(id)` 有 FK，
 * 所以必须先落会话行再建 link。这也是 ActorRuntimeFactory 允许返回 Promise 的原因。
 *
 * 这里**不再**订阅 actor runtime 的事件：直播通道在 child runtime 的**构造期**就装好了
 * （script-workflow-child-runtime.ts 的 eventSink → 父 runtime 的外部 sink 集）。旧的
 * `subscribeEvents` 通道装在下面这行 `ensureSessionPersistedForExternalActivity` 之后，
 * 而它会把 SessionTitleUpdated 写成 sequenceNumber 1——v4 网关只排水连续 seq，
 * 于是订阅从 seq 2 起永远等一个再也不会来的 seq 1，transcript 永久空白。
 */
async function persistActorSession(input: {
  actor: ActorRef;
  deps: ActorRuntimeDeps;
  parentSessionId?: string;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<void> {
  const { actor, deps, parentSessionId, runId, runtime, sessionId } = input;
  const title = `workflow subagent ${refToString(actor)}`;

  await runtime.ensureSessionPersistedForExternalActivity(title);

  if (deps.taskLinkStore) {
    await deps.taskLinkStore.createSessionTaskLink({
      childSessionId: sessionId,
      id: `tasklink_${randomUUID()}`,
      // rootWorkflowRunId 刻意留空。**经验证的事实**（不是猜测）：该列声明为
      // `root_workflow_run_id text references workflow_run(id)`（migration 0007，
      // 见 session_task_link 建表），指向 **legacy** workflow_run 表，而 workflow run 的记录在
      // dwf_run；migration runner 开着 pragma foreign_keys = on。对着真实 store 探测过：
      // 带 workflow runId 调用得到 `FOREIGN KEY constraint failed`，省略则成功。所以 run 身份走
      // 下面这个无 FK 的 path 列。别把它"修"回来。
      //
      // path 是一个迷你契约：`dwf/<runId>/<siteId>@<ordinal>`。runId 已字符集安全；siteId 段
      // 保留原始 `#`/`@`（自由文本列，且已 sanitize 的形态就在会话 id 里）。**今天没有任何代码
      // 解析它**——它服务于人阅读与将来可能的前缀扫描（"这个 run 的所有 actor 会话"）。
      // 若将来要按 run id 建索引查询，需要一条重建
      // session_task_link 的 migration 把 FK 改指或去掉。
      path: `dwf/${runId}/${refToString(actor)}`,
      ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
      // 与 legacy 的 "workflow_agent"（script-workflow-runtime.ts）刻意区分，而不是复用：
      // 两者是不同的人群。legacy 行的 root_workflow_run_id 指向 workflow_run 且非空，dwf 行
      // 该列恒为空、run 身份在 path 里。共用一个 role 值会让"按 role 取行再解引用
      // root_workflow_run_id"的消费者从 dwf 行拿到 null。列是 `text not null`，无 CHECK、
      // 无 enum、契约侧也无 zod（已核对），所以新值合法。
      role: "workflow_actor",
      status: "running",
    } satisfies CreateSessionTaskLinkInput);
  }
}

/**
 * 把 actor 实际模型与来源作为一个绑定写进 journal（dwf_actor 的 resolved_model /
 * model_provenance 两列）。
 *
 * 为什么必须**读改写**：`putActor` 是整条记录的替换，而这条记录的另外几个字段（name /
 * persona / sessionId）不是本函数的；直接写一条只有模型绑定的记录会把引擎刚写下的
 * 冻结 persona 抹掉。
 *
 * 为什么是 driver 侧写：子代理跑在哪个模型上是宿主事实（父会话当时的选择），引擎在 createActor
 * 时同步落 persona 的那一刻看不见它。引擎那一侧的两处 putActor 会把本字段原样带过去，见
 * dynamic-workflow 的 engine.ts / scheduler.ts。
 */
export function journalActorResolvedModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  selection: ModelSelection;
  modelProvenance: NonNullable<WorkflowActorModelBinding["modelProvenance"]>;
  runId: string;
}): void {
  const { actor, journal, selection, modelProvenance, runId } = input;
  const existing = journal.getActor(runId, actor.siteId, actor.ordinal);
  journal.putActor({
    ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
    resolvedModel: formatActorResolvedModel(selection),
    modelProvenance,
  });
}

/** journal 以带前缀的 JSON 保存完整选择；解析端同时兼容旧 `providerId/modelId` 记录。 */
function formatActorResolvedModel(selection: ModelSelection): string {
  return `selection:${JSON.stringify(selection)}`;
}

/** Most-specific approved target wins: concrete instance, then call site, then actor name. */
function matchActorModelOverride(
  overrides: readonly WorkflowActorModelOverride[],
  actor: ActorRef,
  name: string | undefined,
): ModelSelection | undefined {
  let winner: { score: number; selection: ModelSelection } | undefined;
  for (const override of overrides) {
    if (override.siteId !== undefined && override.siteId !== actor.siteId) continue;
    if (override.ordinal !== undefined && override.ordinal !== actor.ordinal) continue;
    if (override.name !== undefined && override.name !== name) continue;
    const score =
      (override.ordinal === undefined ? 0 : 4) +
      (override.siteId === undefined ? 0 : 2) +
      (override.name === undefined ? 0 : 1);
    if (winner === undefined || score > winner.score) {
      winner = { score, selection: override.selection };
    }
  }
  return winner?.selection;
}

/**
 * 造好的 actor runtime 必须已经有模型选择：child 继承父会话当前的选择（script-workflow-child-runtime.ts），
 * 父会话没有选择时它连第一次模型请求都发不出去。这里大声失败，而不是把「没选模型」落成一条空 pin。
 */
function requireActorModelSelection(runtime: AgentRuntime, actor: ActorRef): ModelSelection {
  const selection = runtime.getSessionModelSelection();
  if (selection === undefined) {
    throw new Error(
      `actor 会话没有模型选择，无法记录 resolvedModel: ${actor.siteId}#${actor.ordinal}`,
    );
  }
  return selection;
}

/**
 * 读取同 run 的已持久化模型绑定；旧行可能只有 resolvedModel、没有 provenance。
 *
 * 只有 resume 才会读到值：引擎 replay `createActor` 时把两个字段 carry-forward 保了下来；
 * 全新 run 在 runtime 工厂运行的这一刻还没有解析结果，天然缺席。**必须在造 runtime 之前读**，
 * 因为 `journalActorResolvedModel` 随后就会把本轮的解析写回同一字段——读晚了会把本轮结果
 * 误当成上一轮的绑定。显式配置与旧 NULL 的解释统一由 workflow-actor-model.ts 裁决。
 */
function persistedActorModelBinding(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): WorkflowActorModelBinding | undefined {
  const record = input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal);
  if (record?.resolvedModel === undefined) return undefined;
  return {
    resolvedModel: record.resolvedModel,
    ...(record.modelProvenance === undefined ? {} : { modelProvenance: record.modelProvenance }),
  };
}

function seedActorModelBinding(
  seed:
    | { resolvedModel?: string; modelProvenance?: WorkflowActorModelBinding["modelProvenance"] }
    | undefined,
): WorkflowActorModelBinding | undefined {
  if (seed?.resolvedModel === undefined) return undefined;
  return {
    resolvedModel: seed.resolvedModel,
    ...(seed.modelProvenance === undefined ? {} : { modelProvenance: seed.modelProvenance }),
  };
}
