import type {
  SessionCreatedPayload,
  SessionCompactedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  ModelCompletePayload,
  SessionModeChangedPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import { SessionEventType as EventTypes } from "./session.events.js";
import { getModelUsageContextTokens } from "../model/usage.js";
import { parseCheckpointCreatedPayload, parseRewindTriggeredPayload } from "../rewind/index.js";
import {
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  parseGoalCompletionVerificationText,
} from "../tools/target.js";
import type { SessionStatus } from "../interfaces/session.port.js";
import {
  applyCompactBoundary,
  applyStreamRecoveryAnchorCreated,
  applyStreamingToolLedgerUpdate,
} from "./event-reducer-helpers.js";
import type { EventProjectionHandlers } from "./event-reducer-types.js";

function shouldModelCompleteUpdateContextUsed(payload: ModelCompletePayload): boolean {
  if (payload.querySource !== undefined) {
    return payload.querySource === "main_turn";
  }

  // 兼容旧版主会话事件没有 querySource 的历史数据；工具/子任务内部模型调用
  // 过去也可能缺这个字段，但 stopReason 会标成 tool_internal，不能拿来覆盖主 session。
  return payload.stopReason !== "tool_internal";
}

export const lifecycleProjectionHandlers: EventProjectionHandlers = {
  [EventTypes.SessionCreated]: (p, e) => {
    const payload = e.payload as SessionCreatedPayload;
    return {
      ...p,
      id: e.sessionId,
      mode: payload.mode,
      planEnabled: payload.planEnabled ?? payload.mode === "plan",
      contextWindow: payload.contextWindow,
      createdAt: e.timestamp,
      updatedAt: e.timestamp,
      status: "idle" as SessionStatus,
    };
  },

  [EventTypes.TurnStarted]: (p, e) => {
    return {
      ...p,
      currentTurnId: e.turnId,
      // 上一轮 provider 失败会写入 projection.lastError；新一轮消息被接受后，
      // 旧错误不再是当前任务事实。必须在源头清理，避免 readSession/getTaskSnapshot 反复恢复旧横幅。
      lastError: undefined,
      turnCount: p.turnCount + 1,
      status: "running" as SessionStatus,
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.SessionCompacted]: (p, e) => {
    const payload = e.payload as SessionCompactedPayload;
    return applyCompactBoundary(p, payload.compactBoundary, e.timestamp);
  },

  [EventTypes.SessionModeChanged]: (p, e) => {
    const payload = e.payload as SessionModeChangedPayload;
    return {
      ...p,
      ...(payload.permissionGrant
        ? {
            pendingSteerInputs: p.pendingSteerInputs.map((item) =>
              payload.permissionGrant!.queueItemIds.includes(item.pendingInputId) && item.intent
                ? { ...item, intent: { ...item.intent, mode: "yolo" as const } }
                : item,
            ),
          }
        : {}),
      mode: payload.mode,
      planEnabled: payload.planEnabled ?? payload.mode === "plan",
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.CompactBoundary]: (p, e) => {
    return applyCompactBoundary(p, e.payload, e.timestamp);
  },

  [EventTypes.CheckpointCreated]: (p, e) => {
    const payload = parseCheckpointCreatedPayload(e.payload);
    return {
      ...p,
      lastCheckpoint: {
        checkpointId: payload.checkpointId,
        compactBoundaryId: payload.compactBoundaryId,
        coveredByCompact: payload.coveredByCompact,
        createdAt: e.timestamp,
        fileCount: payload.fileCount,
        messageId: payload.messageId,
        targetMessageId: payload.targetMessageId,
        toolMessageId: payload.toolMessageId,
        scope: payload.scope,
        snapshotRef: payload.snapshotRef,
      },
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.RewindTriggered]: (p, e) => {
    const payload = parseRewindTriggeredPayload(e.payload);
    return {
      ...p,
      lastRewind: {
        compactBoundaryId: payload.compactBoundaryId,
        reason: payload.reason,
        rewindId: payload.rewindId,
        scope: payload.scope,
        strategy: payload.strategy,
        targetCheckpointId: payload.targetCheckpointId,
        targetMessageId: payload.targetMessageId,
        triggeredAt: e.timestamp,
      },
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnComplete]: (p, e) => {
    const payload = e.payload as TurnCompletePayload;
    return {
      ...p,
      status: "idle" as SessionStatus,
      totalTokenCount: p.totalTokenCount + payload.tokenCount,
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.ModelComplete]: (p, e) => {
    const payload = e.payload as ModelCompletePayload;
    if (payload.querySource === GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE) {
      return {
        ...p,
        targetCompletionVerifications: [
          ...p.targetCompletionVerifications,
          parseGoalCompletionVerificationText(payload.content),
        ],
        updatedAt: e.timestamp,
      };
    }
    // 输入栏 context usage 只代表主会话发给 provider 的最新上下文。
    // 标题生成、压缩摘要、子代理和工具内部模型调用都不是当前主 session 的可见上下文，
    // 如果用它们的 usage 覆盖 projection，UI 会显示成 89/1m 这类 sidecar 小请求。
    if (!shouldModelCompleteUpdateContextUsed(payload)) {
      return {
        ...p,
        updatedAt: e.timestamp,
      };
    }
    // AI SDK v6 的 provider input 已经是 total input（含 cache read/write）；
    // 这里通过统一 helper 计算 context used，避免各处重复理解 cache breakdown。
    const contextUsed = getModelUsageContextTokens(payload.usage);
    return {
      ...p,
      ...(contextUsed !== undefined ? { contextUsed } : {}),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.StreamingToolLedgerUpdated]: (p, e) => {
    return applyStreamingToolLedgerUpdate(p, e.payload as StreamingToolLedgerPayload, e.timestamp);
  },

  [EventTypes.StreamRecoveryAnchorCreated]: (p, e) => {
    return applyStreamRecoveryAnchorCreated(
      p,
      e.payload as StreamRecoveryAnchorPayload,
      e.timestamp,
    );
  },

  [EventTypes.TurnError]: (p, e) => {
    const payload = e.payload as TurnErrorPayload;
    return {
      ...p,
      status: "error" as SessionStatus,
      // projection 是重启/恢复链路的数据来源，必须保留真实 provider/subagent 根因。
      lastError: {
        type: payload.error.type,
        ...(payload.error.code ? { code: payload.error.code } : {}),
        message: payload.error.message,
        ...(payload.error.detail ? { detail: payload.error.detail } : {}),
        // TurnError 的 provider/network 归因是 live 与 cold projection 的共同事实；
        // 旧 reducer 只保留文案和 code，导致后续 task meta/telemetry 无法区分 provider 拒绝。
        ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
      },
      updatedAt: e.timestamp,
    };
  },
};
