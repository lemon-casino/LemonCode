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
  inheritedMetadata,
  type TrackedWriter,
} from "./agent-trace-writer-base.js";
import type {
  ToolExecutionSpanWriter,
  CommandTraceStart,
  CommandExecutionSpanWriter,
} from "@lcode/contracts/telemetry";
import {
  compactAttributes,
  finiteNonNegative,
  integer,
  isAbortLike,
  safeIdentifier,
  type WriterTerminalObservation,
} from "./agent-trace-support.js";
import { commandCompatibilityAttributes } from "./compatibility-adapters.js";
import { commandAttributes } from "./agent-trace-attributes.js";
import { commandMetricLabels } from "./agent-trace-metric-labels.js";
import { NOOP_COMMAND_WRITER } from "./agent-trace-noop.js";
import type { TraceWriterHost } from "./agent-trace-start-types.js";

export class ToolWriter extends TrackedBaseWriter implements ToolExecutionSpanWriter {
  private permissionRequested = false;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
    private readonly createCommand: (
      input: CommandTraceStart & { parent: ToolWriter },
    ) => CommandExecutionSpanWriter,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("tool_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markPermissionRequested(): void {
    if (this.permissionRequested) return;
    this.permissionRequested = true;
    this.addEvent("permission_requested");
  }

  setPermissionDecision(decision: "granted" | "denied" | "not_required"): void {
    this.setAttribute("zcode.tool_execution.permission_decision", decision);
    if (this.permissionRequested && decision !== "not_required") {
      this.addEvent("permission_decided", { decision });
    }
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.tool_execution.output_bytes", finiteNonNegative(bytes));
  }

  setOutputTruncated(truncated: boolean): void {
    this.setAttribute("zcode.tool_execution.output_truncated", truncated);
  }

  startCommand(input: CommandTraceStart): CommandExecutionSpanWriter {
    return this.createCommand({ ...input, parent: this });
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishDenied(reason: "user_denied" | "policy_denied" | "unavailable" | "unknown"): void {
    this.finishDomainOutcomeIfOpen("denied", () =>
      this.setAttribute("zcode.tool_execution.permission_denial_reason", reason),
    );
  }

  finishFailed(
    stage:
      | "lookup"
      | "validation"
      | "permission"
      | "pre_hook"
      | "handler"
      | "post_hook"
      | "serialize"
      | "unhandled",
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

export class CommandWriter extends TrackedBaseWriter implements CommandExecutionSpanWriter {
  private firstOutput = false;
  private firstOutputMs: number | undefined;

  constructor(
    span: Span,
    parentContext: Context,
    metadata: Omit<ActiveWriterContext, "activeContext" | "span">,
    health: WriterHealth,
    private readonly metrics: AgentTelemetryMetricRecorder,
    metricLabels: Attributes,
    onRemoved: (writer: TrackedWriter) => void,
  ) {
    super(
      span,
      parentContext,
      metadata,
      lifecycleKeys("command_execution"),
      health,
      metrics,
      metricLabels,
      onRemoved,
    );
  }

  markFirstOutput(): void {
    if (this.firstOutput) return;
    this.firstOutput = true;
    const elapsed = this.elapsedMs();
    this.firstOutputMs = elapsed;
    this.setAttribute("zcode.command_execution.first_output_ms", elapsed);
    this.addEvent("first_output");
  }

  markTerminationRequested(reason: "cancelled" | "timeout" | "shutdown"): void {
    this.addEvent("termination_requested", { reason });
  }

  setExitCode(exitCode: number): void {
    const normalized = integer(exitCode);
    this.setAttribute("zcode.command_execution.exit_code", normalized);
    this.setAttributes(commandCompatibilityAttributes({ exitCode: normalized }));
  }

  setSignal(signal: string): void {
    const normalized = safeIdentifier(signal);
    this.setAttribute("zcode.command_execution.signal", normalized);
    this.setAttributes(commandCompatibilityAttributes({ signal: normalized }));
  }

  setOutputBytes(bytes: number): void {
    this.setAttribute("zcode.command_execution.output_bytes", finiteNonNegative(bytes));
  }

  setTimedOut(timedOut: boolean): void {
    this.setAttribute("zcode.command_execution.timed_out", timedOut);
  }

  finishCompleted(): void {
    this.finishCompletedIfOpen();
  }

  finishFailed(
    stage: "prepare" | "spawn" | "execute" | "timeout" | "collect_output" | "unhandled",
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void {
    this.finishFailedIfOpen(stage, category, error);
  }

  finishCancelled(reason: AgentTelemetryCancellationReason): void {
    this.finishCancelledIfOpen(reason);
  }

  finishBackgrounded(): void {
    this.finishDomainOutcomeIfOpen("backgrounded");
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
    if (this.firstOutputMs === undefined) return;
    this.metrics.recordCommandFirstOutput(
      this.firstOutputMs,
      compactAttributes({
        ...this.metricLabels,
        error_category: observation.errorCategory,
        outcome,
      }),
    );
  }
}

export function startCommand(
  host: TraceWriterHost,
  input: CommandTraceStart & { parent: ToolWriter },
): CommandExecutionSpanWriter {
  const parent = input.parent.state;
  return host.safeCreate(
    "command_execution",
    () => {
      const span = host.startSpan({
        attributes: commandAttributes(parent, input),
        context: parent.activeContext,
        correlation: parent.correlation,
        parent,
        spanName: "command_execution",
        toolCallId: parent.toolCallId,
      });
      return host.track(
        new CommandWriter(
          span,
          parent.activeContext,
          inheritedMetadata(parent, "command_execution"),
          host.health,
          host.metrics,
          commandMetricLabels(input),
          (writer) => host.remove(writer),
        ),
      );
    },
    NOOP_COMMAND_WRITER,
  );
}
