// 真实用户或 model-only turn 的起点与既有 canonical target 登记。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { CanonicalUserIntentFact } from "./event-normalizer.js";
import type {
  ConversationDelta,
  TurnHeaderRow,
  UserInputRow,
} from "@lcode/shared/lcode-protocol-v4";
import { ms, rowBase, registerCanonicalUserRowTarget } from "./product-projection-rows.js";
import {
  applyBackgroundTaskNotification,
  removeConsumedBackgroundWorks,
} from "./product-projection-background.js";
import { controlPatch } from "./product-projection-session.js";

type TurnStartedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "outputContinuationTextRowId"
  | "toolRowIdByCallId"
  | "backgroundLifecycleByWorkId"
  | "consumedBackgroundLifecycles"
  | "messageIdByRowId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "runtimeTurnIdByProductTurnId"
  | "productTurnSplitOrdinalByRuntimeTurnId"
  | "currentProductTurnStartedAtMs"
  | "currentTurnId"
  | "currentTurnStartedModelOnly"
  | "lastTurnModel"
>;

export function onTurnStarted(
  host: TurnStartedHost,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const event = fact.event;
  const runtimeTurnId = fact.runtimeTurnId;
  const turnId = fact.productTurnId;
  host.currentTurnId = runtimeTurnId;
  host.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
  // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
  host.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
  if (turnId !== runtimeTurnId) host.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
  host.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
  host.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
  host.currentProductTurnStartedAtMs = ms(event);
  host.streamingTextRowId = null;
  host.streamingReasoningRowId = null;
  host.outputContinuationTextRowId = null;

  // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
  // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
  // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
  const deltas: ConversationDelta[] = [
    ...applyBackgroundTaskNotification(host, fact),
    ...removeConsumedBackgroundWorks(host),
  ];
  const sharedContextRef = fact.sharedContextRefs?.[0];
  if (
    sharedContextRef &&
    host.snapshot.sharedContextImport &&
    "contextId" in host.snapshot.sharedContextImport &&
    host.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
    (host.snapshot.sharedContextImport.status === "pending" ||
      host.snapshot.sharedContextImport.status === "reserved")
  ) {
    const sharedContextImport = {
      ...host.snapshot.sharedContextImport,
      status: "attached" as const,
    };
    host.snapshot = { ...host.snapshot, sharedContextImport };
    deltas.push({ op: "state.updated", patch: { sharedContextImport } });
  }
  // marker 时机：只有当
  // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
  // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
  // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
  // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
  // 切一次模型就会在首条消息上方挂出 [modelChange]。
  const config = host.snapshot.config;
  const hasModel = config.provider !== "" && config.model !== "";
  if (hasModel && host.lastTurnModel.kind === "sourceLess") {
    deltas.push({
      op: "row.appended",
      row: {
        ...rowBase(
          host,
          event,
          turnId,
          `model-initial:${turnId}:${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  } else if (
    hasModel &&
    host.lastTurnModel.kind === "known" &&
    (host.lastTurnModel.provider !== config.provider || host.lastTurnModel.model !== config.model)
  ) {
    deltas.push({
      op: "row.appended",
      row: {
        ...rowBase(
          host,
          event,
          turnId,
          `model-change:${turnId}:${host.lastTurnModel.provider}/${host.lastTurnModel.model}->${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          fromProvider: host.lastTurnModel.provider,
          fromModel: host.lastTurnModel.model,
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  }
  if (hasModel) {
    host.lastTurnModel = {
      kind: "known",
      provider: config.provider,
      model: config.model,
      thought: config.thought,
    };
  }
  const headerBase = rowBase(host, event, turnId, turnId);
  const header: TurnHeaderRow = {
    ...headerBase,
    kind: "turnHeader",
    origin: fact.turnHeaderOrigin,
    executionKind: fact.executionKind,
    ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
    ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
    ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
    state: "running",
    startedAt: headerBase.createdAt,
  };
  host.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });

  // model-only 输入（goal continuation 等）不产生可见 userInput row。
  if (fact.visibility === "visible") {
    const base = rowBase(host, event, turnId, fact.entityId);
    const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
    const attachments = fact.attachments?.map((attachment, index) => ({
      ...attachment,
      ref: attachment.ref ?? `turn-attachment/${base.rowId}/${index}`,
    }));
    const row: UserInputRow = {
      ...base,
      kind: "userInput",
      text: fact.input,
      origin: fact.origin,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(fact.clientId ? { clientId: fact.clientId } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    // workspace checkpoint 以 user messageId 为 targetMessageId。
    // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
    // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
    registerCanonicalUserRowTarget(
      host,
      row.rowId,
      fact.entityId,
      fact.transcriptMessageId
        ? {
            entityId: fact.entityId,
            productTurnId: fact.productTurnId,
            transcriptMessageId: fact.transcriptMessageId,
            coveredByStableCompact: false,
            intent: {
              kind: fact.intentKind,
              text: fact.intentText,
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              ...(fact.clientId ? { clientId: fact.clientId } : {}),
              ...(fact.attachments ? { attachments: fact.attachments } : {}),
              ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
              ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
              ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
              ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
              ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
              ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
              ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
              ...(fact.mode ? { mode: fact.mode } : {}),
              ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
              ...(fact.goalAcceptance ? { goalAcceptance: fact.goalAcceptance } : {}),
              ...(fact.contextCapsuleRefs
                ? { contextCapsuleRefs: [...fact.contextCapsuleRefs] }
                : {}),
              ...(fact.provenance ? { provenance: fact.provenance } : {}),
            },
          }
        : undefined,
    );
    deltas.push({
      op: "row.appended",
      row,
    });
  }

  if (fact.executionKind === "agent") {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(host, {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [
          {
            kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
            ...(fact.foregroundExecutionId
              ? { foregroundExecutionId: fact.foregroundExecutionId }
              : {}),
            startedAt: ms(event),
          },
        ],
        // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
        lastError: null,
        apiRetry: null,
      }),
    });
  }
  // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
  // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
  // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
  return deltas;
}
