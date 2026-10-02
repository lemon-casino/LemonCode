import type { ModelStreamEvent } from "@lcode/contracts";
import { publishModelTelemetryMilestone } from "./runner-status.js";

import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  "attempt" | "startedAt" | "statusContext" | "timeToFirstContentMs" | "timeToFirstTextMs"
>;

export async function publishVisibleMilestones(
  input: Pick<StreamRunnerInput, "logger" | "statusSink">,
  state: AttemptState,
  observation: { contentMs?: number; textMs?: number },
): Promise<void> {
  if (state.timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
    state.timeToFirstContentMs = observation.contentMs;
    await publishModelTelemetryMilestone(
      {
        ...state.statusContext,
        attempt: state.attempt,
        elapsedMs: observation.contentMs,
        timestamp: new Date(state.startedAt + observation.contentMs).toISOString(),
        type: "model_first_content",
      },
      { logger: input.logger, statusSink: input.statusSink },
    );
  }
  if (state.timeToFirstTextMs === undefined && observation.textMs !== undefined) {
    state.timeToFirstTextMs = observation.textMs;
    await publishModelTelemetryMilestone(
      {
        ...state.statusContext,
        attempt: state.attempt,
        elapsedMs: observation.textMs,
        timestamp: new Date(state.startedAt + observation.textMs).toISOString(),
        type: "model_first_text",
      },
      { logger: input.logger, statusSink: input.statusSink },
    );
  }
}

export function observeVisibleStreamEvent(
  event: ModelStreamEvent,
  elapsed: number,
): { contentMs?: number; textMs?: number; outputCommitted: boolean } {
  switch (event.type) {
    case "text_delta":
      return {
        contentMs: elapsed,
        textMs: event.text ? elapsed : undefined,
        outputCommitted: true,
      };
    case "reasoning_delta":
    case "tool_input_delta":
    case "tool_call":
      return { contentMs: elapsed, outputCommitted: true };
    case "text_start":
    case "reasoning_start":
    case "tool_input_start":
      return { contentMs: elapsed, outputCommitted: false };
    case "compact_stream_boundary":
      return {
        contentMs: event.boundary === "provider_content_block_start" ? elapsed : undefined,
        outputCommitted:
          event.boundary === "provider_content_block_stop" ||
          event.boundary === "inferred_content_block_stop",
      };
    default:
      return { outputCommitted: false };
  }
}
