import type { SessionEvent } from "@lcode/contracts";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import type {
  ConversationRowTarget,
  QueueItem,
  WorkspaceConfigState,
} from "@lcode/shared/lcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { type V4GatewayHost, type ConversationV4GatewayOptions } from "./v4-gateway-contract.js";
import { type V4GatewayState } from "./v4-gateway-state.js";
import { DETACHED_CHILD_PUBLISHER_GRACE_MS } from "./v4-gateway-lifecycle.js";

import { createGatewayState } from "./v4-gateway-state.js";
import * as ingest from "./v4-gateway-ingest.js";
import * as connectionFlow from "./v4-gateway-connection-flow.js";
import * as eventCommit from "./v4-gateway-event-commit.js";
import * as lifecycle from "./v4-gateway-lifecycle.js";
import * as sessionsIndex from "./v4-gateway-sessions-index.js";
import * as workspaceConfig from "./v4-gateway-workspace-config.js";
import * as subscriptions from "./v4-gateway-subscriptions.js";
import * as recovery from "./v4-gateway-recovery.js";
import * as queries from "./v4-gateway-queries.js";
import * as workflowQueries from "./v4-gateway-workflow-queries.js";
import * as attachments from "./v4-gateway-attachments.js";
import * as commands from "./v4-gateway-commands.js";
import * as projectionQueries from "./v4-gateway-projection-queries.js";
import * as delivery from "./v4-gateway-delivery.js";
export type { V4GatewayHost } from "./v4-gateway-contract.js";
export { V4CommandNotImplementedError, V4CommandNoopError } from "./v4-gateway-errors.js";

// 唯一 gateway owner：公开方法只把本实例 state 借给对应职责，不转移订阅/命令真值。
export class ConversationV4Gateway {
  private readonly state: V4GatewayState;

  constructor(host: V4GatewayHost, options: ConversationV4GatewayOptions = {}) {
    this.state = createGatewayState(host, options);
  }

  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ) {
    return ingest.updateSharedContextImport(this.state, sessionId, source);
  }

  setConnectionFlowState(rawParams: unknown) {
    return connectionFlow.setConnectionFlowState(this.state, rawParams);
  }

  ingest(sessionId: string, event: SessionEvent) {
    return ingest.ingest(this.state, sessionId, event);
  }

  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return eventCommit.waitForProjectionEventCommit(this.state, sessionId, eventId, options);
  }

  waitForPermissionGrantCommit(sessionId: string, eventId: string) {
    return eventCommit.waitForPermissionGrantCommit(this.state, sessionId, eventId);
  }

  ingestDetachedLiveSession(sessionId: string, event: SessionEvent, parentSessionId?: string) {
    return lifecycle.ingestDetachedLiveSession(this.state, sessionId, event, parentSessionId);
  }

  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ) {
    return lifecycle.pruneDetachedChildPublishers(this.state, nowMs, graceMs);
  }

  subscribeSessionsIndex(rawParams: unknown) {
    return sessionsIndex.subscribeSessionsIndex(this.state, rawParams);
  }

  subscribeSessionsIndexReserved(rawParams: unknown) {
    return sessionsIndex.subscribeSessionsIndexReserved(this.state, rawParams);
  }

  subscribeWorkspaceConfig(rawParams: unknown) {
    return workspaceConfig.subscribeWorkspaceConfig(this.state, rawParams);
  }

  subscribeWorkspaceConfigReserved(rawParams: unknown) {
    return workspaceConfig.subscribeWorkspaceConfigReserved(this.state, rawParams);
  }

  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState) {
    return workspaceConfig.publishWorkspaceConfig(this.state, workspaceId, state);
  }

  subscribe(rawParams: unknown) {
    return subscriptions.subscribe(this.state, rawParams);
  }

  subscribeReserved(rawParams: unknown) {
    return subscriptions.subscribeReserved(this.state, rawParams);
  }

  resyncReserved(rawParams: unknown) {
    return recovery.resyncReserved(this.state, rawParams);
  }

  rowsRange(rawParams: unknown) {
    return queries.rowsRange(this.state, rawParams);
  }

  plans(rawParams: unknown) {
    return queries.plans(this.state, rawParams);
  }

  workflowRunEvents(rawParams: unknown) {
    return workflowQueries.workflowRunEvents(this.state, rawParams);
  }

  workflowRuns(rawParams: unknown) {
    return workflowQueries.workflowRuns(this.state, rawParams);
  }

  workflowRunArtifacts(rawParams: unknown) {
    return workflowQueries.workflowRunArtifacts(this.state, rawParams);
  }

  workflowRunArtifactData(rawParams: unknown) {
    return workflowQueries.workflowRunArtifactData(this.state, rawParams);
  }

  workflowRunArtifactRead(rawParams: unknown) {
    return workflowQueries.workflowRunArtifactRead(this.state, rawParams);
  }

  workflowRunWorkspace(rawParams: unknown) {
    return workflowQueries.workflowRunWorkspace(this.state, rawParams);
  }

  workflowRunNodeResult(rawParams: unknown) {
    return workflowQueries.workflowRunNodeResult(this.state, rawParams);
  }

  fileChanges(rawParams: unknown) {
    return queries.fileChanges(this.state, rawParams);
  }

  backgroundBashOutput(rawParams: unknown) {
    return queries.backgroundBashOutput(this.state, rawParams);
  }

  fileRewindPreview(rawParams: unknown) {
    return queries.fileRewindPreview(this.state, rawParams);
  }

  attachmentBegin(rawParams: unknown) {
    return attachments.attachmentBegin(this.state, rawParams);
  }

  attachmentChunk(rawParams: unknown) {
    return attachments.attachmentChunk(this.state, rawParams);
  }

  attachmentCommit(rawParams: unknown) {
    return attachments.attachmentCommit(this.state, rawParams);
  }

  attachmentAbort(rawParams: unknown) {
    return attachments.attachmentAbort(this.state, rawParams);
  }

  attachmentRead(rawParams: unknown) {
    return attachments.attachmentRead(this.state, rawParams);
  }

  conversationAttachmentRead(rawParams: unknown) {
    return attachments.conversationAttachmentRead(this.state, rawParams);
  }

  conversationAttachmentStat(rawParams: unknown) {
    return attachments.conversationAttachmentStat(this.state, rawParams);
  }

  attachmentPreviewSource(rawParams: unknown) {
    return attachments.attachmentPreviewSource(this.state, rawParams);
  }

  unsubscribe(rawParams: unknown) {
    return subscriptions.unsubscribe(this.state, rawParams);
  }

  handleCommand(rawParams: unknown) {
    return commands.handleCommand(this.state, rawParams);
  }

  queryCommands(rawParams: unknown) {
    return commands.queryCommands(this.state, rawParams);
  }

  getQueueItem(sessionId: string, queueItemId: string) {
    return projectionQueries.getQueueItem(this.state, sessionId, queueItemId);
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]) {
    return projectionQueries.hasQueueItemKind(this.state, sessionId, kind);
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue") {
    return projectionQueries.hasQueuedDelivery(this.state, sessionId, delivery);
  }

  getQueueLength(sessionId: string) {
    return projectionQueries.getQueueLength(this.state, sessionId);
  }

  hasResidencyBlockingCommands(sessionId: string) {
    return projectionQueries.hasResidencyBlockingCommands(this.state, sessionId);
  }

  getQueueHead(sessionId: string) {
    return projectionQueries.getQueueHead(this.state, sessionId);
  }

  getInputRoutingMode(sessionId: string) {
    return projectionQueries.getInputRoutingMode(this.state, sessionId);
  }

  getSessionFollowupMode(sessionId: string) {
    return projectionQueries.getSessionFollowupMode(this.state, sessionId);
  }

  getMessageIdForRow(sessionId: string, rowId: number) {
    return projectionQueries.getMessageIdForRow(this.state, sessionId, rowId);
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return projectionQueries.resolveRowActionTarget(this.state, sessionId, target, action);
  }

  getMessageIdsForTurnRow(sessionId: string, rowId: number) {
    return projectionQueries.getMessageIdsForTurnRow(this.state, sessionId, rowId);
  }

  isLatestAssistantSegmentRow(sessionId: string, rowId: number) {
    return projectionQueries.isLatestAssistantSegmentRow(this.state, sessionId, rowId);
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return projectionQueries.resolveStableForkCandidate(this.state, sessionId, rowId);
  }

  isLatestRetryAssistantRow(sessionId: string, rowId: number) {
    return projectionQueries.isLatestRetryAssistantRow(this.state, sessionId, rowId);
  }

  isLatestEditableUserRow(sessionId: string, rowId: number) {
    return projectionQueries.isLatestEditableUserRow(this.state, sessionId, rowId);
  }

  getTurnIdForRow(sessionId: string, rowId: number) {
    return projectionQueries.getTurnIdForRow(this.state, sessionId, rowId);
  }

  getTurnRewindAnchor(sessionId: string, rowId: number) {
    return projectionQueries.getTurnRewindAnchor(this.state, sessionId, rowId);
  }

  disposeSession(sessionId: string) {
    return lifecycle.disposeSession(this.state, sessionId);
  }

  deactivateSession(sessionId: string) {
    return lifecycle.deactivateSession(this.state, sessionId);
  }

  assertSessionRuntimeDeactivatable(sessionId: string) {
    return lifecycle.assertSessionRuntimeDeactivatable(this.state, sessionId);
  }

  hasConversationSubscribers(sessionId: string) {
    return lifecycle.hasConversationSubscribers(this.state, sessionId);
  }

  collectMemoryDiagnostics() {
    return lifecycle.collectMemoryDiagnostics(this.state);
  }

  dispose() {
    return lifecycle.dispose(this.state);
  }

  flushNow(subscriptionId: string) {
    return delivery.flushNow(this.state, subscriptionId);
  }
}
