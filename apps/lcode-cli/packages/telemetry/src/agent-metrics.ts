import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";

export type AgentMetricSpanName =
  | "agent_turn"
  | "agent_step"
  | "tool_execution"
  | "command_execution"
  | "context_compaction"
  | "detached_operation"
  | "model_call"
  | "model_attempt";

export type ModelTokenType = "input" | "output" | "reasoning" | "cache_read" | "cache_write";

export interface AgentTelemetryMetricRecorder {
  recordCommandFirstOutput(durationMs: number, labels: Attributes): void;
  recordCreationDrop(spanName: AgentMetricSpanName, reason: "process_capacity" | "unknown"): void;
  recordModelAttemptDetail(
    labels: Attributes,
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    },
  ): void;
  recordModelCallAttempts(attemptCount: number, labels: Attributes): void;
  recordModelTokenDelta(tokenType: ModelTokenType, delta: number, labels: Attributes): void;
  recordSpanTerminal(
    spanName: AgentMetricSpanName,
    outcome: string,
    durationMs: number,
    labels: Attributes,
    abandonReason?: string,
  ): void;
}

/**
 * Metric 只接收已归一化、低基数的标签。高基数执行 ID 和原始业务内容只属于 Trace，
 * 不能通过这个边界进入 Metric Series。
 */
export class OtelAgentTelemetryMetrics implements AgentTelemetryMetricRecorder {
  private readonly abandoned: Counter;
  private readonly commandFirstOutput: Histogram;
  private readonly creationDrop: Counter;
  private readonly durations: Record<AgentMetricSpanName, Histogram>;
  private readonly modelAttemptFirstContent: Histogram;
  private readonly modelAttemptFirstProviderEvent: Histogram;
  private readonly modelAttemptFirstText: Histogram;
  private readonly modelAttemptStreamMaxIdle: Histogram;
  private readonly modelAttemptStreamStalls: Counter;
  private readonly modelCallAttempts: Histogram;
  private readonly modelTokens: Counter;

  constructor(meter: Meter) {
    this.durations = {
      agent_turn: duration(meter, "zcode.agent.turn.duration"),
      agent_step: duration(meter, "zcode.agent.step.duration"),
      tool_execution: duration(meter, "zcode.tool.execution.duration"),
      command_execution: duration(meter, "zcode.command.execution.duration"),
      context_compaction: duration(meter, "zcode.context.compaction.duration"),
      detached_operation: duration(meter, "zcode.detached.operation.duration"),
      model_call: duration(meter, "zcode.model.call.duration"),
      model_attempt: duration(meter, "zcode.model.attempt.duration"),
    };
    this.modelCallAttempts = meter.createHistogram("zcode.model.call.attempts", {
      description: "Physical provider attempts per logical model call",
      unit: "{attempt}",
    });
    this.modelTokens = meter.createCounter("zcode.model.attempt.tokens", {
      description: "Observed provider token delta by token type",
      unit: "{token}",
    });
    this.modelAttemptFirstProviderEvent = duration(
      meter,
      "zcode.model.attempt.time_to_first_provider_event",
    );
    this.modelAttemptFirstContent = duration(meter, "zcode.model.attempt.time_to_first_content");
    this.modelAttemptFirstText = duration(meter, "zcode.model.attempt.time_to_first_text");
    this.modelAttemptStreamStalls = meter.createCounter("zcode.model.attempt.stream_stall.count", {
      description: "Observed stream stalls",
      unit: "{stall}",
    });
    this.modelAttemptStreamMaxIdle = duration(meter, "zcode.model.attempt.stream_max_idle");
    this.commandFirstOutput = duration(meter, "zcode.command.execution.time_to_first_output");
    this.creationDrop = meter.createCounter("zcode.telemetry.creation_drop.count", {
      description: "Spans rejected before creation by runtime capacity protection",
      unit: "{span}",
    });
    this.abandoned = meter.createCounter("zcode.telemetry.abandoned.count", {
      description: "Spans closed as abandoned",
      unit: "{span}",
    });
  }

  recordSpanTerminal(
    spanName: AgentMetricSpanName,
    outcome: string,
    durationMs: number,
    labels: Attributes,
    abandonReason?: string,
  ): void {
    const terminalLabels = allowMetricAttributes({ ...labels, outcome }, TERMINAL_LABELS[spanName]);
    this.durations[spanName].record(durationMs / 1_000, terminalLabels);
    if (outcome === "abandoned") {
      this.abandoned.add(
        1,
        allowMetricAttributes(
          {
            abandon_reason: abandonReason,
            span_name: spanName,
          },
          ["abandon_reason", "span_name"],
        ),
      );
    }
  }

  recordCreationDrop(spanName: AgentMetricSpanName, reason: "process_capacity" | "unknown"): void {
    this.creationDrop.add(1, {
      drop_reason: reason,
      span_name: spanName,
    });
  }

  recordModelCallAttempts(attemptCount: number, labels: Attributes): void {
    this.modelCallAttempts.record(attemptCount, allowMetricAttributes(labels, MODEL_CALL_LABELS));
  }

  recordModelTokenDelta(tokenType: ModelTokenType, delta: number, labels: Attributes): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.modelTokens.add(
      delta,
      allowMetricAttributes(
        {
          ...labels,
          token_type: tokenType,
        },
        MODEL_TOKEN_LABELS,
      ),
    );
  }

  recordModelAttemptDetail(
    labels: Attributes,
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    },
  ): void {
    const safeLabels = allowMetricAttributes(labels, MODEL_ATTEMPT_LABELS);
    if (detail.firstProviderEventMs !== undefined) {
      this.modelAttemptFirstProviderEvent.record(detail.firstProviderEventMs / 1_000, safeLabels);
    }
    if (detail.firstContentMs !== undefined) {
      this.modelAttemptFirstContent.record(detail.firstContentMs / 1_000, safeLabels);
    }
    if (detail.firstTextMs !== undefined) {
      this.modelAttemptFirstText.record(detail.firstTextMs / 1_000, safeLabels);
    }
    if (detail.stallCount > 0) {
      this.modelAttemptStreamStalls.add(detail.stallCount, safeLabels);
      this.modelAttemptStreamMaxIdle.record(detail.streamMaxIdleMs / 1_000, safeLabels);
    }
  }

  recordCommandFirstOutput(durationMs: number, labels: Attributes): void {
    this.commandFirstOutput.record(
      durationMs / 1_000,
      allowMetricAttributes(labels, COMMAND_LABELS),
    );
  }
}

export const NOOP_AGENT_TELEMETRY_METRICS: AgentTelemetryMetricRecorder = {
  recordCommandFirstOutput() {},
  recordCreationDrop() {},
  recordModelAttemptDetail() {},
  recordModelCallAttempts() {},
  recordModelTokenDelta() {},
  recordSpanTerminal() {},
};

function duration(meter: Meter, name: string): Histogram {
  return meter.createHistogram(name, {
    description: `${name} in seconds`,
    unit: "s",
  });
}

const COMMON_TERMINAL_LABELS = ["error_category", "outcome"] as const;
const MODEL_CALL_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "call_cause",
  "model_operation",
  "model_role",
  "retry_state",
] as const;
const MODEL_ATTEMPT_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "model",
  "model_operation",
  "model_role",
  "provider_kind",
  "transport",
] as const;
const MODEL_TOKEN_LABELS = [
  "model",
  "model_operation",
  "model_role",
  "provider_kind",
  "token_type",
  "transport",
] as const;
const COMMAND_LABELS = [
  ...COMMON_TERMINAL_LABELS,
  "command_category",
  "command_safe_name",
] as const;

const TERMINAL_LABELS: Record<AgentMetricSpanName, readonly string[]> = {
  agent_turn: [...COMMON_TERMINAL_LABELS, "actor_kind", "input_source", "launch_surface"],
  agent_step: [...COMMON_TERMINAL_LABELS, "actor_kind", "terminal_reason"],
  tool_execution: [...COMMON_TERMINAL_LABELS, "tool_name"],
  command_execution: COMMAND_LABELS,
  context_compaction: [...COMMON_TERMINAL_LABELS, "model_mode", "trigger"],
  detached_operation: [...COMMON_TERMINAL_LABELS, "execution_kind", "operation"],
  model_call: MODEL_CALL_LABELS,
  model_attempt: MODEL_ATTEMPT_LABELS,
};

function allowMetricAttributes(attributes: Attributes, allowed: readonly string[]): Attributes {
  const result: Attributes = {};
  for (const key of allowed) {
    const value = attributes[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 0)) {
      result[key] = value;
    }
  }
  return result;
}
