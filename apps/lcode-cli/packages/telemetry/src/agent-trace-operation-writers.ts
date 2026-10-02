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
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
} from "@lcode/contracts/telemetry";
import { finiteNonNegative, isAbortLike, safeEnum } from "./agent-trace-support.js";

export class CompactionWriter extends TrackedBaseWriter implements ContextCompactionSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("context_compaction"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setInputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.input_tokens", finiteNonNegative(tokens));
  }

  setOutputTokens(tokens: number): void {
    this.setAttribute("zcode.context_compaction.output_tokens", finiteNonNegative(tokens));
  }

  markFallbackSelected(reason: string): void {
    this.addEvent("fallback_selected", { reason: safeEnum(reason) });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDiscarded(): void {
    this.finishDomainOutcomeIfOpen("discarded");
  }

  finishFailed(
    stage: "prepare" | "model" | "parse" | "commit" | "fallback" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}

export class DetachedWriter extends TrackedBaseWriter implements DetachedOperationSpanWriter {
  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("detached_operation"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  setResultType(resultType: "text" | "boolean" | "metadata" | "other"): void {
    this.setAttribute("zcode.detached_operation.result_type", resultType);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "schedule" | "execute" | "commit" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  protected finishUnhandled(error: unknown): void {
    if (isAbortLike(error)) this.finishCancelledIfOpen("abort_signal");
    else this.finishFailedIfOpen("unhandled", classifyErrorCategory(error), error);
  }
}
