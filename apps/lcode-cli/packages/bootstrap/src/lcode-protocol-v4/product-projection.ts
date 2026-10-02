// ProductProjection 是唯一可变状态 owner；公开 API 与原实例字段保持不变。
// SessionEvent → narrow helper → delta/revision → snapshot（拒绝候选时不提交）。
// desktop: continuous ─ live delta ─┐
// mobile: replayable ─ snapshot ────┴─ 同一投影、同一序列与行身份。
import type {
  ProductProjectionState,
  SessionConfigSeed,
  SessionUsageSeed,
  SessionSubagentsSeed,
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection-state.js";
import { createInitialConversationSnapshot } from "./projection-state.js";
import type {
  ConversationSnapshot,
  ConversationRowTarget,
  ConversationDelta,
} from "@lcode/shared/lcode-protocol-v4";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import { establishedStreamingAppend } from "./product-projection-model-stream.js";
import type { SessionEvent } from "@lcode/contracts";
import { seedConfig, seedUsage } from "./product-projection-model-config.js";
import { seedSharedContextImport } from "./product-projection-session.js";
import { seedSubagents } from "./product-projection-subagent-manifest.js";
import {
  resolveEditTarget,
  resolveEditTargetByEntityId,
  resolveRowActionTarget,
  getMessageIdsForTurnRow,
  isLatestAssistantSegmentRow,
  resolveStableForkCandidate,
  isLatestRetryAssistantRow,
  isLatestEditableUserRow,
  getTurnIdForRow,
  getTurnRewindAnchor,
} from "./product-projection-targets.js";
import {
  applyEventInternal,
  beginHydrationReplay,
  applyHydrationEvent,
  completeHydrationReplay,
  cloneProjectionState,
  adoptProjectionState,
} from "./product-projection-transaction.js";

export type {
  SessionConfigSeed,
  SessionUsageSeed,
  SessionSubagentsSeed,
  StableForkCandidate,
  StableForkCandidateResolution,
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "./product-projection-state.js";

export class ProductProjection {
  private snapshot: ProductProjectionState["snapshot"];
  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  private rowIndexById: ProductProjectionState["rowIndexById"] = new Map();
  private hydrationAccumulator: ProductProjectionState["hydrationAccumulator"] = null;
  private nextRowId: ProductProjectionState["nextRowId"] = 1;
  private streamingTextRowId: ProductProjectionState["streamingTextRowId"] = null;
  private streamingReasoningRowId: ProductProjectionState["streamingReasoningRowId"] = null;
  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  private outputContinuationTextRowId: ProductProjectionState["outputContinuationTextRowId"] = null;
  private toolRowIdByCallId: ProductProjectionState["toolRowIdByCallId"] = new Map();
  private latestListAppsSnapshot: ProductProjectionState["latestListAppsSnapshot"] = new Map();
  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  private openForegroundToolCallIds: ProductProjectionState["openForegroundToolCallIds"] =
    new Set();
  private fileToolInputPreviewByCallId: ProductProjectionState["fileToolInputPreviewByCallId"] =
    new Map();
  private subagentRowIdByAgentId: ProductProjectionState["subagentRowIdByAgentId"] = new Map();
  private backgroundLifecycleByWorkId: ProductProjectionState["backgroundLifecycleByWorkId"] =
    new Map();
  private consumedBackgroundLifecycles: ProductProjectionState["consumedBackgroundLifecycles"] =
    new Set();
  private hookRowIdByInvocationId: ProductProjectionState["hookRowIdByInvocationId"] = new Map();
  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  private pendingSessionHookInvocations: ProductProjectionState["pendingSessionHookInvocations"] =
    new Map();
  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  private rewoundHookInvocationIds: ProductProjectionState["rewoundHookInvocationIds"] = new Set();
  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  private invalidSubagentChildSessionIds: ProductProjectionState["invalidSubagentChildSessionIds"] =
    new Set();
  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  private messageIdByRowId: ProductProjectionState["messageIdByRowId"] = new Map();
  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  private outputContinuationRowIdByMessageId: ProductProjectionState["outputContinuationRowIdByMessageId"] =
    new Map();
  private entityIdByRowId: ProductProjectionState["entityIdByRowId"] = new Map();
  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  private editTargetByEntityId: ProductProjectionState["editTargetByEntityId"] = new Map();
  private currentEditableEntityId: ProductProjectionState["currentEditableEntityId"] = null;
  private stableCompactCoverageBoundaryRowId: ProductProjectionState["stableCompactCoverageBoundaryRowId"] =
    null;
  private turnHeaderRowIdByTurnId: ProductProjectionState["turnHeaderRowIdByTurnId"] = new Map();
  private compactMarkerRowIdByOperationId: ProductProjectionState["compactMarkerRowIdByOperationId"] =
    new Map();
  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  private goalVerifyMarkerRowIdByLifecycleKey: ProductProjectionState["goalVerifyMarkerRowIdByLifecycleKey"] =
    new Map();
  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  private productTurnIdByRuntimeTurnId: ProductProjectionState["productTurnIdByRuntimeTurnId"] =
    new Map();
  private runtimeTurnIdByProductTurnId: ProductProjectionState["runtimeTurnIdByProductTurnId"] =
    new Map();
  private productTurnSplitOrdinalByRuntimeTurnId: ProductProjectionState["productTurnSplitOrdinalByRuntimeTurnId"] =
    new Map();
  private currentProductTurnStartedAtMs: ProductProjectionState["currentProductTurnStartedAtMs"] =
    null;
  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  private deliveryByPendingInputId: ProductProjectionState["deliveryByPendingInputId"] = new Map();
  private currentTurnId: ProductProjectionState["currentTurnId"] = null;
  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  private currentTurnStartedModelOnly: ProductProjectionState["currentTurnStartedModelOnly"] = false;
  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  private contextWindowState: ProductProjectionState["contextWindowState"] = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };
  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  private lastTurnModel: ProductProjectionState["lastTurnModel"] = { kind: "silentInitial" };
  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent: ProductProjectionState["configModelTouchedByEvent"] = false;
  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent: ProductProjectionState["configThoughtLevelsTouchedByEvent"] = false;
  private configModeTouchedByEvent: ProductProjectionState["configModeTouchedByEvent"] = false;
  // snapshot 清空后仍需拒绝迟到的旧 policy 事件，故 revision 不能只从 nullable 字段读取。
  private executionFailoverRevision: ProductProjectionState["executionFailoverRevision"] = 0;
  // revision 只在 Runtime epoch 内单调；resume 的 event sequence 是跨 epoch 的迟到事件栅栏。
  private executionFailoverEpochStartSequence: ProductProjectionState["executionFailoverEpochStartSequence"] =
    -1;
  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  private droppedContentStreamEventCount: ProductProjectionState["droppedContentStreamEventCount"] = 0;
  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  private normalizationDiagnostics: ProductProjectionState["normalizationDiagnostics"] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  /**
   * TypeScript private 只约束对外 API；helper 借用的仍是当前实例本身。
   * 字段逐一以 ProductProjectionState[K] 标注，避免接口与实际字段类型漂移。
   * 不缓存 facade，Object.create 产生的原子候选也会借用它自己的同名字段。
   */
  private get projectionState(): ProductProjectionState {
    return this as unknown as ProductProjectionState;
  }

  getSnapshot(): ConversationSnapshot {
    return this.snapshot;
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  getDroppedContentStreamEventCount(): number {
    return this.droppedContentStreamEventCount;
  }

  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.normalizationDiagnostics;
  }

  establishedStreamingAppend(event: SessionEvent): string | null {
    return establishedStreamingAppend(this.projectionState, event);
  }

  seedConfig(seed: SessionConfigSeed): void {
    seedConfig(this.projectionState, seed);
  }

  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    seedSharedContextImport(this.projectionState, source);
  }

  seedUsage(seed: SessionUsageSeed): void {
    seedUsage(this.projectionState, seed);
  }

  seedSubagents(seed: SessionSubagentsSeed): void {
    seedSubagents(this.projectionState, seed);
  }

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  getMessageIdForRow(rowId: number): string | null {
    return this.messageIdByRowId.get(rowId) ?? null;
  }

  getEntityIdForRow(rowId: number): string | null {
    return this.entityIdByRowId.get(rowId) ?? null;
  }

  resolveEditTarget(rowId: number): ConversationEditTarget | null {
    return resolveEditTarget(this.projectionState, rowId);
  }

  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null {
    return resolveEditTargetByEntityId(this.projectionState, entityId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return resolveRowActionTarget(this.projectionState, target, action);
  }

  getMessageIdsForTurnRow(rowId: number): string[] {
    return getMessageIdsForTurnRow(this.projectionState, rowId);
  }

  isLatestAssistantSegmentRow(rowId: number): boolean {
    return isLatestAssistantSegmentRow(this.projectionState, rowId);
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return resolveStableForkCandidate(this.projectionState, rowId);
  }

  isLatestRetryAssistantRow(rowId: number): boolean {
    return isLatestRetryAssistantRow(this.projectionState, rowId);
  }

  isLatestEditableUserRow(rowId: number): boolean {
    return isLatestEditableUserRow(this.projectionState, rowId);
  }

  getTurnIdForRow(rowId: number): string | null {
    return getTurnIdForRow(this.projectionState, rowId);
  }

  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
  applyEvent(event: SessionEvent): ConversationDelta[] {
    return applyEventInternal(this.projectionState, event, true);
  }

  beginHydrationReplay(): void {
    beginHydrationReplay(this.projectionState);
  }

  applyHydrationEvent(event: SessionEvent): ConversationDelta[] {
    return applyHydrationEvent(this.projectionState, event);
  }

  completeHydrationReplay(): ConversationDelta[] {
    return completeHydrationReplay(this.projectionState);
  }

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   */
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot) => boolean,
  ): ConversationDelta[] | null {
    const candidate = this.cloneProjection();
    const deltas = candidate.applyEvent(event);
    if (!accept(candidate.snapshot)) return null;
    this.adoptProjection(candidate);
    return deltas;
  }

  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    cloneProjectionState(this.projectionState, clone.projectionState);
    return clone;
  }

  private adoptProjection(candidate: ProductProjection): void {
    adoptProjectionState(this.projectionState, candidate.projectionState);
  }

  getTurnRewindAnchor(rowId: number): string | null {
    return getTurnRewindAnchor(this.projectionState, rowId);
  }
}
