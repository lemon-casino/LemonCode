import type { ModelStreamEvent } from "@lcode/contracts";
import type { TextStreamPart, ToolSet } from "ai";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";
import { isRetrySafePreludeStreamEvent } from "./stream-retry-boundary.js";

import type { StreamChunkResult } from "./runner-stream-chunk-state.js";

export function applyStreamEventsToRetryBoundary(input: {
  emittedRetryBoundaryEvent: boolean;
  events: ModelStreamEvent[];
  pendingRetrySafeEvents: ModelStreamEvent[];
  providerEventObserved?: boolean;
  preserveProviderStreamBoundaries?: boolean;
}): ReturnType<typeof streamChunkResult> {
  let emittedEvent = false;
  let emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent;
  const visibleEvents: ModelStreamEvent[] = [];

  if (input.providerEventObserved && !emittedRetryBoundaryEvent) {
    visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    emittedRetryBoundaryEvent = true;
  }

  for (const event of input.events) {
    emittedEvent = true;
    // AI SDK 的 start 在读取 provider stream 前本地合成，不能冒充首个 provider event；
    // compact 一旦收到其余真实事件就停止 SSE retry，再由 Core 的 block commit 决定能否 HTTP fallback。
    const retrySafePrelude =
      isRetrySafePreludeStreamEvent(event) &&
      (!input.preserveProviderStreamBoundaries || event.type === "start");
    if (retrySafePrelude && !emittedRetryBoundaryEvent) {
      input.pendingRetrySafeEvents.push(event);
      continue;
    }

    if (!emittedRetryBoundaryEvent) {
      visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    }
    visibleEvents.push(event);
    emittedRetryBoundaryEvent = true;
  }

  return streamChunkResult({
    emittedEvent,
    emittedRetryBoundaryEvent,
    visibleEvents,
  });
}

export function isRawProviderRetryBoundaryEvent(chunk: TextStreamPart<ToolSet>): boolean {
  if (chunk.type !== "raw") {
    return false;
  }
  const rawValue = chunk.rawValue;
  return !(
    rawValue !== null &&
    typeof rawValue === "object" &&
    (rawValue as { type?: unknown }).type === "ping"
  );
}

export function toProviderStreamBoundaryEvent(
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (chunk.type !== "raw" || chunk.rawValue === null || typeof chunk.rawValue !== "object") {
    return undefined;
  }
  const rawEvent = chunk.rawValue as {
    content_block?: { type?: unknown };
    delta?: { stop_reason?: unknown; type?: unknown };
    index?: unknown;
    type?: unknown;
  };
  if (rawEvent.type === "message_start") {
    return {
      boundary: "provider_response_start",
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_start") {
    return {
      blockType:
        typeof rawEvent.content_block?.type === "string" ? rawEvent.content_block.type : null,
      boundary: "provider_content_block_start",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_delta") {
    return {
      boundary: "provider_content_block_delta",
      deltaType: typeof rawEvent.delta?.type === "string" ? rawEvent.delta.type : null,
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_stop") {
    return {
      boundary: "provider_content_block_stop",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "message_delta") {
    const stopReason = rawEvent.delta?.stop_reason;
    return {
      boundary: "provider_stop_reason",
      present: Boolean(stopReason),
      type: "compact_stream_boundary",
    };
  }
  return undefined;
}

export function compactDirectToolCallCommitEvent(
  request: AiSdkModelTextRequest,
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (!request.preserveProviderStreamBoundaries || chunk.type !== "tool-call") {
    return undefined;
  }
  return {
    boundary: "inferred_content_block_stop",
    type: "compact_stream_boundary",
  };
}

export function streamChunkResult(overrides: Partial<StreamChunkResult> = {}): StreamChunkResult {
  return {
    emittedError: false,
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    retryScheduled: false,
    offPeakQueueHold: false,
    visibleEvents: [],
    ...overrides,
  };
}
