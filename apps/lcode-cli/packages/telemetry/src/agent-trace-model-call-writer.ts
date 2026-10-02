import type { Attributes, Context, Span } from "@opentelemetry/api";
import type {
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
} from "@lcode/contracts/telemetry";
import type { ActiveWriterContext, WriterHealth } from "./agent-trace-support.js";
import type { AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import {
  TrackedBaseWriter,
  classifyErrorCategory,
  lifecycleKeys,
  type TrackedWriter,
} from "./agent-trace-writer-base.js";
import type {
  AgentTelemetryAbandonReason,
  ModelCallSpanWriter,
  ModelCallFailureStage,
  ModelAttemptTraceStart,
  ModelAttemptSpanWriter,
} from "@lcode/contracts/telemetry";
import {
  compactAttributes,
  isAbortLike,
  safeString,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";

export class ModelCallWriter extends TrackedBaseWriter implements ModelCallSpanWriter {
  private attemptCount = 0;
  private hadFailedAttempt = false;
  readonly logicalCallId: string | undefined;
  readonly modelRole: string | undefined;
  readonly operation: string | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createAttempt: (
      writer: ModelCallWriter,
      input: ModelAttemptTraceStart,
    ) => ModelAttemptSpanWriter,
    logicalCallId: string | undefined,
    operation: string | undefined,
    modelRole: string | undefined,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("model_call"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
    this.logicalCallId = logicalCallId;
    this.operation = operation;
    this.modelRole = modelRole;
  }

  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter {
    this.attemptCount += 1;
    return this.createAttempt(this, input);
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeString(reason, 128) });
  }

  recordAttemptFailed(): void {
    this.hadFailedAttempt = true;
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishAbandoned(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) {
      this.finishCancelledIfOpen("abort_signal");
    } else {
      const category = classifyErrorCategory(error);
      this.finishFailedIfOpen("unhandled", category, error);
    }
  }

  protected override recordTerminalDetailMetrics(
    outcome: string,
    observation: WriterTerminalObservation,
  ): void {
    const retryState =
      this.attemptCount <= 1
        ? "not_needed"
        : outcome === "completed" && this.hadFailedAttempt
          ? "recovered"
          : "not_recovered";
    this.metrics.recordModelCallAttempts(
      this.attemptCount,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
        retry_state: retryState,
      }),
    );
  }
}
