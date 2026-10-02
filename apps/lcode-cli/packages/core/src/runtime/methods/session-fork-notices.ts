import { type ExecutionState } from "@lcode/shared";
import { readRuntimeExecutionState } from "../execution-state.js";
import { createModelId, createModelProviderId } from "@lcode/contracts";
import { systemReminderRuntimeMetadata } from "../../agent/message-history.js";
import { createMessageId, createPartId, createTurnId } from "../deps.js";
import type { MessageId, MessageWithParts, SessionId } from "../deps.js";
import { emptyTokenUsageInfo, formatConversationForkNoticeBody } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildSyntheticUserNoticePartMetadata } from "./synthetic-notice-metadata.js";
import { cloneModelSelection } from "../model-selection.js";
import type { ModelSelection } from "@lcode/contracts";
import type { ForkIdentityMap } from "./session-fork-identities.js";

export function buildAtomicForkNotice(
  runtime: AgentRuntimeInternal,
  options: {
    identities: ForkIdentityMap;
    modelSelection?: ModelSelection;
    executionState?: ExecutionState;
    sourceCommandId: string;
    targetMessageId: MessageId;
  },
): MessageWithParts[] {
  const created = Date.now();
  const {
    hiddenMessageId: hiddenId,
    hiddenPartId,
    messageId: noticeId,
    partId: noticePartId,
    turnId: noticeTurnId,
    productTurnId,
  } = options.identities.notice;
  const anchorMessageId = options.identities.messageIds.get(options.targetMessageId) ?? hiddenId;
  const anchor = {
    turnId: noticeTurnId,
    productTurnId,
    orderedMessageIds: [hiddenId, noticeId],
    boundaryMessageId: noticeId,
  };
  const forkOrigin = {
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
  };
  const runtimeSelection = runtime.getSessionModelSelection();
  const modelSelection = options.modelSelection ?? runtimeSelection;
  return [
    {
      info: {
        id: hiddenId,
        sessionID: options.identities.childSessionId,
        role: "user",
        time: { created },
        agent: runtime.config.agentName ?? "lcode-agent",
        modelSelection: modelSelection && cloneModelSelection(modelSelection),
        synthetic: true,
        source: "fork",
        visibility: "model-only",
        semantics: {
          origin: "system",
          kind: "fork_notice",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: hiddenPartId,
          sessionID: options.identities.childSessionId,
          messageID: hiddenId,
          type: "text",
          text: formatConversationForkNoticeBody(forkOrigin),
          synthetic: true,
          time: { start: created, end: created },
          // hydrate 只读 part metadata；独立 source 保留 fork 边界且不改变 checkpoint 的 MCS 行为。
          metadata: buildSyntheticUserNoticePartMetadata("fork", "model-only", {
            forkOrigin,
            runtimeMessage: systemReminderRuntimeMetadata("conversation_fork"),
          }),
        },
      ],
    },
    {
      info: {
        id: noticeId,
        sessionID: options.identities.childSessionId,
        role: "assistant",
        time: { created, completed: created },
        parentID: hiddenId,
        modelId: modelSelection && createModelId(modelSelection.modelId),
        providerId: modelSelection && createModelProviderId(modelSelection.providerId),
        ...(modelSelection?.options?.reasoningLevel
          ? { reasoningLevel: modelSelection.options.reasoningLevel }
          : {}),
        // 分支提示本身也属于新分支历史，必须与分支的持久化状态保持一致。
        ...(options.executionState ?? readRuntimeExecutionState(runtime)),
        agent: runtime.config.agentName ?? "lcode-agent",
        path: { cwd: runtime.workingDirectory, root: runtime.workspaceRoot },
        cost: 0,
        tokens: emptyTokenUsageInfo(),
        finish: "completed",
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: noticePartId,
          sessionID: options.identities.childSessionId,
          messageID: noticeId,
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId,
          anchorTurnId: noticeTurnId,
          sourceCommandId: options.sourceCommandId,
          parentSessionId: runtime.sessionId,
          targetMessageId: options.targetMessageId,
          restoredFileCount: 0,
          time: { start: created, end: created },
        },
      ],
    },
  ];
}

const SELECTION_SIDE_CHAT_BOUNDARY = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

export function buildSelectionSideChatBoundary(
  runtime: AgentRuntimeInternal,
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): MessageWithParts {
  const created = Date.now();
  const messageId = createMessageId();
  const turnId = createTurnId();
  return {
    info: {
      id: messageId,
      sessionID: childSessionId,
      role: "user",
      time: { created },
      agent: runtime.config.agentName ?? "lcode-agent",
      modelSelection: modelSelection && cloneModelSelection(modelSelection),
      synthetic: true,
      source: "selection_side_chat",
      visibility: "model-only",
      semantics: {
        origin: "system",
        kind: "system_reminder",
        source: "selection_side_chat",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      anchor: {
        turnId,
        productTurnId: String(messageId),
        orderedMessageIds: [messageId],
        boundaryMessageId: messageId,
        origin: "synthetic",
      },
    },
    parts: [
      {
        id: createPartId(),
        sessionID: childSessionId,
        messageID: messageId,
        type: "text",
        text: SELECTION_SIDE_CHAT_BOUNDARY,
        synthetic: true,
        time: { start: created, end: created },
        // hydrate 读取 part metadata；只写 info.source 会退化为普通 user 文本。
        metadata: buildSyntheticUserNoticePartMetadata(
          "selection_side_chat",
          "model-only",
          undefined,
        ),
      },
    ],
  };
}

export function withoutSelectionSideChatGoalBoundary(message: MessageWithParts): MessageWithParts {
  const anchor = message.info.anchor;
  if (!anchor?.goalBoundary) return message;
  const anchorWithoutGoalBoundary = { ...anchor };
  delete anchorWithoutGoalBoundary.goalBoundary;
  return {
    ...message,
    info: {
      ...message.info,
      anchor: anchorWithoutGoalBoundary,
    },
  };
}
