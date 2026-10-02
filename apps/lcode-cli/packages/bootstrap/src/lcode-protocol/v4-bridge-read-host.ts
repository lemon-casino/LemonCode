import type { V4GatewayHost } from "../lcode-protocol-v4/v4-gateway.js";

import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";

import {
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
} from "@lcode/shared/lcode-protocol-v4";

import { V4CapabilityUnsupportedError } from "../lcode-protocol-v4/commands/handlers/interaction-background.js";

import { readConversationFileChangesFromEvents } from "../lcode-protocol-v4/cold-file-change-summaries.js";

import type { MessageId, SessionId, TurnId } from "@lcode/contracts";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

import { resolveConversationBackingRecord } from "./v4-bridge-backing-record.js";

async function readConversationFileChanges(
  record: LCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

async function previewConversationFileRewind(
  record: LCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

export function createV4ReadHost(
  context: LCodeProtocolAgentServerContext,
): Pick<
  V4GatewayHost,
  | "putSessionAttachment"
  | "readBackgroundBashOutput"
  | "readSessionAttachment"
  | "statSessionAttachment"
  | "resolveSessionAttachmentPreviewSource"
  | "getConversationFileChanges"
  | "listDynamicWorkflowRunEvents"
  | "listDynamicWorkflowRuns"
  | "listDynamicWorkflowRunArtifacts"
  | "listDynamicWorkflowRunArtifactItems"
  | "readDynamicWorkflowRunArtifact"
  | "listDynamicWorkflowRunWorkspaceNodes"
  | "readDynamicWorkflowRunNodeResult"
  | "previewConversationFileRewind"
> {
  return {
    // gateway 已完成逐片总量/checksum 校验，只把完整 bytes 原子写 artifact。
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },

    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),

    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },

    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },

    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },

    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },

    // dwf 事件日志：能力在 app 上（run service 构造成功才有），缺席时不在这里兜底成空页——
    // gateway 会回结构化的能力不支持错误，让 renderer 能区分"没有事件"与"没有这个能力"。
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRunEvents(input);
    },

    // workflow run 枚举：能力条件同上（run service 构造成功才有）。
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRuns(input);
    },

    // dwf 用户面产物的三个读面：能力条件同上。
    // ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },

    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },

    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },

    // dwf 工作区 transcript 的两个读面：能力条件同上。
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },

    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },

    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
  };
}
