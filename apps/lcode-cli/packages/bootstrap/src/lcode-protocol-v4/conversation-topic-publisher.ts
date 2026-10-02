import { type SessionEvent } from "@lcode/contracts";
import type {
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfileName,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@lcode/shared/lcode-protocol-v4";
import {
  type StableForkCandidateResolution,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  type ConversationSubscribeParams,
  type ConversationSubscribeResult,
  type ConversationResyncRequest,
  type ConversationTopicPublisherOptions,
  type ConversationTopicState,
  createConversationTopicState,
} from "./conversation-topic-state.js";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-buffer.js";

import * as queries from "./conversation-topic-queries.js";
import * as ingest from "./conversation-topic-ingest.js";
import * as hydration from "./conversation-topic-hydration.js";
import * as subscriptions from "./conversation-topic-subscriptions.js";
import * as delivery from "./conversation-topic-delivery.js";
import * as recovery from "./conversation-topic-recovery.js";
export { ProjectionPayloadTooLargeError } from "./conversation-topic-buffer.js";

// publisher 唯一拥有 projection/log/subscription；执行助手只借用同一份 state。
export class ConversationTopicPublisher {
  readonly topic: string;
  private readonly state: ConversationTopicState;
  constructor(
    sessionId: string,
    logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.state = createConversationTopicState(sessionId, logEpoch, options);
    this.topic = this.state.topic;
  }

  getSnapshot(): ConversationSnapshot {
    return queries.getSnapshot(this.state);
  }

  getWireSnapshotLogicalBytes(): number {
    return queries.getWireSnapshotLogicalBytes(this.state);
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return queries.resolveStableForkCandidate(this.state, rowId);
  }

  seedConfig(seed: SessionConfigSeed): void {
    return queries.seedConfig(this.state, seed);
  }

  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    return queries.seedSharedContextImport(this.state, source);
  }

  seedUsage(seed: SessionUsageSeed): void {
    return queries.seedUsage(this.state, seed);
  }

  seedSubagents(seed: SessionSubagentsSeed): void {
    return queries.seedSubagents(this.state, seed);
  }

  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    return queries.measureInputAdmissionProjectionBytes(this.state, envelope, admission);
  }

  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): V4ConversationRowsRangeResult {
    return queries.getRowsRange(this.state, params, deliveryProfile);
  }

  getPlans(): V4ConversationPlansResult {
    return queries.getPlans(this.state);
  }

  getMessageIdForRow(rowId: number): string | null {
    return queries.getMessageIdForRow(this.state, rowId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return queries.resolveRowActionTarget(this.state, target, action);
  }

  getMessageIdsForTurnRow(rowId: number): string[] {
    return queries.getMessageIdsForTurnRow(this.state, rowId);
  }

  isLatestAssistantSegmentRow(rowId: number): boolean {
    return queries.isLatestAssistantSegmentRow(this.state, rowId);
  }

  isLatestRetryAssistantRow(rowId: number): boolean {
    return queries.isLatestRetryAssistantRow(this.state, rowId);
  }

  isLatestEditableUserRow(rowId: number): boolean {
    return queries.isLatestEditableUserRow(this.state, rowId);
  }

  getTurnIdForRow(rowId: number): string | null {
    return queries.getTurnIdForRow(this.state, rowId);
  }

  getDroppedContentStreamEventCount(): number {
    return queries.getDroppedContentStreamEventCount(this.state);
  }

  getTurnRewindAnchor(rowId: number): string | null {
    return queries.getTurnRewindAnchor(this.state, rowId);
  }

  ingest(event: SessionEvent): void {
    return ingest.ingest(this.state, event);
  }

  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    return hydration.rehydrate(this.state, events, options);
  }

  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    return subscriptions.subscribe(this.state, params);
  }

  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    return subscriptions.subscribeReserved(this.state, params);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    return subscriptions.unsubscribe(this.state, subscriptionId, connectionId);
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    return subscriptions.hasSubscription(this.state, subscriptionId, connectionId);
  }

  hasSubscribers(): boolean {
    return subscriptions.hasSubscribers(this.state);
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return subscriptions.connectionIdForSubscription(this.state, subscriptionId);
  }

  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    return delivery.reserveFlush(this.state, subscriptionId);
  }

  flush(subscriptionId: string): ConversationTopicFrame | null {
    return delivery.flush(this.state, subscriptionId);
  }

  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    return recovery.resyncReserved(this.state, subscriptionId, request);
  }

  resync(subscriptionId: string): ConversationTopicFrame | null {
    return recovery.resync(this.state, subscriptionId);
  }
}
