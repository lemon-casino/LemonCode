import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { logIgnoredStreamChunk, recordStreamChunkDiagnostic } from "./runner-diagnostics.js";
import { toModelStreamEvent } from "./runner-normalization.js";

import {
  applyStreamEventsToRetryBoundary,
  isRawProviderRetryBoundaryEvent,
  streamChunkResult,
  toProviderStreamBoundaryEvent,
} from "./runner-stream-boundary.js";
import { handleStreamErrorEvent } from "./runner-stream-chunk-error.js";
import type { StreamChunkInput, StreamChunkResult } from "./runner-stream-chunk-state.js";

export async function handleStreamChunk(input: StreamChunkInput): Promise<StreamChunkResult> {
  recordStreamChunkDiagnostic(input.diagnostics, input.chunk);
  const providerEventObserved =
    input.input.request.preserveProviderStreamBoundaries === true &&
    isRawProviderRetryBoundaryEvent(input.chunk);
  const providerBoundaryEvent = input.input.request.preserveProviderStreamBoundaries
    ? toProviderStreamBoundaryEvent(input.chunk)
    : undefined;
  const emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent || providerEventObserved;
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.statusContext.providerId),
    providerKind: input.statusContext.providerKind,
    source: input.chunk,
  });
  if (providerBusinessFinishError) {
    return handleStreamErrorEvent(
      { ...input, emittedRetryBoundaryEvent },
      providerBusinessFinishError,
    );
  }
  const event = toModelStreamEvent(input.chunk);
  if (event?.type === "error") {
    return handleStreamErrorEvent({ ...input, emittedRetryBoundaryEvent }, event.error);
  }
  if (!event) {
    if (providerEventObserved) {
      // raw provider event 只用于结束 compact SSE retry；它本身不属于
      // 可见正文；只投影 response/block/stop 的语义边界，并立即刷出已暂存的 synthetic start。
      return applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        events: providerBoundaryEvent ? [providerBoundaryEvent] : [],
        pendingRetrySafeEvents: input.pendingRetrySafeEvents,
        providerEventObserved: true,
        preserveProviderStreamBoundaries: true,
      });
    }
    logIgnoredStreamChunk({
      attempt: input.attempt,
      chunk: input.chunk,
      logger: input.input.logger,
      statusContext: input.statusContext,
    });
    return streamChunkResult();
  }

  return applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    events: input.toolCallAssembler.handle(event),
    pendingRetrySafeEvents: input.pendingRetrySafeEvents,
    providerEventObserved,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
  });
}
