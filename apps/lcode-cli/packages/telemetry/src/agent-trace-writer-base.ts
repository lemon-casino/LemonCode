import type { Attributes, Context, Span, Link } from "@opentelemetry/api";
import type {
  AgentTelemetryAbandonReason,
  AgentTelemetryCausation,
  AgentTelemetryErrorCategory,
} from "@lcode/contracts/telemetry";
import {
  BaseSpanWriter,
  compactAttributes,
  isAbortLike,
  spanContextFromCausation,
  type ActiveWriterContext,
  type WriterHealth,
  type WriterLifecycleKeys,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import type { AgentMetricSpanName, AgentTelemetryMetricRecorder } from "./agent-metrics.js";

export type TrackedWriter = BaseSpanWriter & {
  abandon(reason: AgentTelemetryAbandonReason): void;
  readonly state: ActiveWriterContext;
};

export function terminalMetricLabels(
  labels: Attributes,
  observation: WriterTerminalObservation,
): Attributes {
  return compactAttributes({
    ...labels,
    error_category: observation.errorCategory,
  });
}

export abstract class TrackedBaseWriter extends BaseSpanWriter {
  protected readonly metricLabels: Attributes;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    lifecycle: WriterLifecycleKeys,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    const terminalTarget: { writer?: TrackedBaseWriter } = {};
    super(span, parentContext, metadata, lifecycle, health, (outcome, durationMs, observation) => {
      const writer = terminalTarget.writer;
      if (writer) {
        // 终态 Metric 从 Writer 已记录的实时事实投影，覆盖显式 finish、业务异常、
        // missing_terminal 和进程回收；不能只埋在各 finishXxx 分支里留下缺口。
        writer.safe(() => onRemoved(writer));
        writer.safe(() => writer.recordTerminalDetailMetrics(outcome, observation));
        writer.safe(() =>
          metrics.recordSpanTerminal(
            metadata.spanName as AgentMetricSpanName,
            outcome,
            durationMs,
            terminalMetricLabels(metricLabels, observation),
            observation.abandonReason,
          ),
        );
      }
    });
    terminalTarget.writer = this;
    this.metricLabels = metricLabels;
  }

  abandon(reason: AgentTelemetryAbandonReason): void {
    this.finishAbandonedIfOpen(reason);
  }

  protected recordTerminalDetailMetrics(
    _outcome: string,
    _observation: WriterTerminalObservation,
  ): void {}
}

export function causationLink(
  causation: AgentTelemetryCausation,
  relation: "spawned_by" | "triggered_by" | "resumed_from",
): Link {
  return {
    attributes: {
      "zcode.link.relation": relation,
    },
    context: spanContextFromCausation(causation),
  };
}

export function inheritedMetadata(
  parent: ActiveWriterContext | undefined,
  spanName: string,
): Omit<ActiveWriterContext, "activeContext" | "span"> {
  return {
    correlation: parent?.correlation,
    parent,
    spanName,
    toolCallId: parent?.toolCallId,
  };
}

export function lifecycleKeys(spanName: string): WriterLifecycleKeys {
  const prefix = `lcode.${spanName}`;
  return {
    abandonReason: `${prefix}.abandon_reason`,
    cancelReason: `${prefix}.cancel_reason`,
    errorCategory: `${prefix}.error_category`,
    errorCode: `${prefix}.error_code`,
    errorMessage: `${prefix}.error_message`,
    errorType: `${prefix}.error_type`,
    failureStage: `${prefix}.failure_stage`,
    outcome: `${prefix}.outcome`,
  };
}

export function classifyErrorCategory(error: unknown): AgentTelemetryErrorCategory {
  if (isAbortLike(error)) return "cancelled";
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  const code = String(record.code ?? "").toLowerCase();
  if (code.includes("timeout")) return "timeout";
  if (
    code.includes("network") ||
    code.includes("econn") ||
    code.includes("enotfound") ||
    code.includes("tls")
  ) {
    return "network";
  }
  return "unknown";
}
