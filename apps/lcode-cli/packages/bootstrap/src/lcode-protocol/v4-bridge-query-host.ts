// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（lcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
import { isConversationRealUserTurnStarter } from "@lcode/shared";

import type { V4CommandCoreHost } from "../lcode-protocol-v4/commands/types.js";

import { resolveStableForkTargetFromTranscript } from "../lcode-protocol-v4/stable-fork-target.js";

import { persistAssistantFeedback } from "../lcode-protocol-v4/assistant-feedback-persistence.js";

import type { SessionId } from "@lcode/contracts";

import type { LCodeProtocolAgentServerContext } from "./server-types.js";

export function createV4QueryHost(
  context: LCodeProtocolAgentServerContext,
): Pick<
  V4CommandCoreHost,
  | "getQueueItem"
  | "hasQueueItemKind"
  | "hasQueuedDelivery"
  | "getQueueLength"
  | "waitForProjectionEventCommit"
  | "getInputRoutingMode"
  | "getMessageIdForRow"
  | "resolveRowActionTarget"
  | "getMessageIdsForTurnRow"
  | "isLatestAssistantSegmentRow"
  | "resolveStableForkTarget"
  | "isLatestRetryAssistantRow"
  | "isLatestEditableUserRow"
  | "getTurnIdForRow"
  | "hasUsableRuntimeModelTarget"
  | "getTurnRewindAnchor"
  | "resolveUserMessageIdForRow"
  | "resolveTurnUserPrompt"
  | "setAssistantFeedback"
> {
  return {
    // v4 原生能力（非过渡钩子）：sendQueuedNow 必须读取 v4 投影里的完整 intent。
    // 命令执行时 context.v4Gateway 已由 server 注入（createConversationV4Gateway
    // 返回值回填），这里惰性取用避免构造期自引用。
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,

    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,

    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,

    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,

    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },

    // held choice 裁决（heldQueueInputRequiresChoice）：读投影 inputRouting.mode。
    getInputRoutingMode: (sessionId) => context.v4Gateway?.getInputRoutingMode(sessionId) ?? null,

    // rowId→messageId 翻译面（fork/edit/retry 的定位决策，数据源 = v4 投影）：
    // 惰性走 gateway 的投影查表。
    getMessageIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdForRow(sessionId, rowId) ?? null,

    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,

    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],

    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,

    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },

    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,

    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,

    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,

    // restoreWarning 时序自愈探针：App 的模型视图直接来自进程 Registry。
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,

    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,

    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        .at(-1);
      return user ? String(user.info.id) : null;
    },

    // retryTurn 原 prompt 解析：assistant messageId → parentID（user 消息）→ 文本。
    // 数据源 = core sessionStore（transcript 权威）；实现放 binder 只因 deps 注入点
    // 在宿主（随 host 原生持有）。找不到返回 null → handler 只截断不重发。
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : null;
    },

    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // 原因：反馈必须先落 transcript，CLI 重启后才能从 cold hydration 恢复；
      // eventStore/投影随后推进，失败重试仍可从同一持久事实幂等补齐。
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
  };
}
