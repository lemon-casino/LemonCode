import { context, ROOT_CONTEXT, SpanKind, trace, type Span, type Tracer } from "@opentelemetry/api";
import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentStepTraceStart,
  AgentTelemetryExecutionContext,
  AgentTurnSpanWriter,
  AgentTurnTraceStart,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  ModelCallSpanWriter,
  ModelCallTraceStart,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@lcode/contracts/telemetry";
import {
  activeWriterContext,
  safeId,
  safeString,
  contextFromCausation,
  type WriterHealth,
} from "./agent-trace-support.js";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentMetricSpanName,
  type AgentTelemetryMetricRecorder,
} from "./agent-metrics.js";
import { causationLink, inheritedMetadata, type TrackedWriter } from "./agent-trace-writer-base.js";
import { TurnWriter, StepWriter } from "./agent-trace-turn-writers.js";
import { ToolWriter, startCommand } from "./agent-trace-tool-writers.js";
import { CompactionWriter, DetachedWriter } from "./agent-trace-operation-writers.js";
import {
  turnMetricLabels,
  stepMetricLabels,
  toolMetricLabels,
  compactionMetricLabels,
  detachedMetricLabels,
} from "./agent-trace-metric-labels.js";
import {
  turnAttributes,
  stepAttributes,
  toolAttributes,
  compactionAttributes,
  detachedAttributes,
} from "./agent-trace-attributes.js";
import {
  NOOP_TURN_WRITER,
  NOOP_STEP_WRITER,
  NOOP_TOOL_WRITER,
  NOOP_COMPACTION_WRITER,
  NOOP_DETACHED_WRITER,
} from "./agent-trace-noop.js";
import { startModelCall } from "./agent-trace-model-start.js";
import type { StartWriterOptions, TraceWriterHost } from "./agent-trace-start-types.js";

export { NoopAgentExecutionTelemetry } from "./agent-trace-noop.js";

export interface AgentTraceRuntimeOptions extends WriterHealth {
  identity?: TelemetryIdentitySnapshot;
  maxActiveWriters?: number;
  metrics?: AgentTelemetryMetricRecorder;
  tracer: Tracer;
}

export class AgentExecutionTelemetryRuntime
  implements AgentExecutionTelemetryPort, ModelExecutionTelemetryPort
{
  private readonly activeWriters = new Set<TrackedWriter>();
  private capacityWarningActive = false;
  private identity: TelemetryIdentitySnapshot;
  private readonly maxActiveWriters: number;
  private readonly tracer: Tracer;
  private readonly health: WriterHealth;
  private readonly metrics: AgentTelemetryMetricRecorder;

  constructor(options: AgentTraceRuntimeOptions) {
    this.tracer = options.tracer;
    this.maxActiveWriters = positiveLimit(options.maxActiveWriters, 5_000);
    this.health = { onWarning: options.onWarning };
    this.metrics = options.metrics ?? NOOP_AGENT_TELEMETRY_METRICS;
    this.identity = options.identity ?? { identityState: "unknown" };
  }

  updateIdentity(snapshot: TelemetryIdentitySnapshot): void {
    this.identity = {
      identityState: snapshot.identityState,
      ...(safeId(snapshot.userSubjectId) ? { userSubjectId: safeId(snapshot.userSubjectId) } : {}),
    };
  }

  captureCausation() {
    const active = activeWriterContext();
    if (!active) return undefined;
    const spanContext = active.span.spanContext();
    if (!trace.isSpanContextValid(spanContext)) return undefined;
    return {
      isRemote: spanContext.isRemote ?? false,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
      ...(spanContext.traceState ? { traceState: spanContext.traceState.serialize() } : {}),
      sessionId: active.correlation?.sessionId,
      turnId: active.correlation?.turnId,
      toolCallId: active.toolCallId,
    };
  }

  startTurn(input: AgentTurnTraceStart): AgentTurnSpanWriter {
    const correlation: AgentTelemetryExecutionContext = {
      ...input.context,
      identityState: this.identity.identityState,
      ...(this.identity.userSubjectId ? { userSubjectId: this.identity.userSubjectId } : {}),
    };
    const linkedRoot = input.causationMode !== "child";
    const links =
      input.causation && linkedRoot ? [causationLink(input.causation, "spawned_by")] : undefined;
    return this.safeCreate(
      "agent_turn",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: turnAttributes(correlation, input),
          context: parentContext,
          correlation,
          links,
          spanName: "agent_turn",
        });
        return this.track(
          new TurnWriter(
            span,
            parentContext,
            {
              correlation,
              spanName: "agent_turn",
            },
            this.health,
            this.metrics,
            turnMetricLabels(correlation, input.inputSource),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_TURN_WRITER,
    );
  }

  startStep(input: AgentStepTraceStart): AgentStepSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "agent_step",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: stepAttributes(parent, input),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "agent_step",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new StepWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "agent_step"),
            this.health,
            this.metrics,
            stepMetricLabels(parent?.correlation),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_STEP_WRITER,
    );
  }

  startTool(input: ToolTraceStart): ToolExecutionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "tool_execution",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const toolName = safeString(input.registeredToolName, 128);
        const span = this.startSpan({
          attributes: toolAttributes(parent, input, toolName),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "tool_execution",
          toolCallId: safeId(input.toolCallId),
        });
        return this.track(
          new ToolWriter(
            span,
            parentContext,
            {
              ...inheritedMetadata(parent, "tool_execution"),
              toolCallId: safeId(input.toolCallId),
            },
            this.health,
            this.metrics,
            toolMetricLabels(input.registeredToolName),
            (writer) => this.activeWriters.delete(writer),
            (command) => startCommand(this.writerHost(), command),
          ),
        );
      },
      NOOP_TOOL_WRITER,
    );
  }

  startCompaction(input: CompactionTraceStart): ContextCompactionSpanWriter {
    const parent = activeWriterContext();
    return this.safeCreate(
      "context_compaction",
      () => {
        const parentContext = parent?.activeContext ?? context.active();
        const span = this.startSpan({
          attributes: compactionAttributes(parent, input),
          context: parentContext,
          correlation: parent?.correlation,
          parent,
          spanName: "context_compaction",
          toolCallId: parent?.toolCallId,
        });
        return this.track(
          new CompactionWriter(
            span,
            parentContext,
            inheritedMetadata(parent, "context_compaction"),
            this.health,
            this.metrics,
            compactionMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_COMPACTION_WRITER,
    );
  }

  startDetachedOperation(input: DetachedOperationTraceStart): DetachedOperationSpanWriter {
    const linkedRoot = input.executionKind !== "foreground";
    const links =
      input.causation && linkedRoot
        ? [
            causationLink(
              input.causation,
              input.trigger === "recovery" ? "resumed_from" : "triggered_by",
            ),
          ]
        : undefined;
    return this.safeCreate(
      "detached_operation",
      () => {
        const parentContext =
          input.causation && !linkedRoot ? contextFromCausation(input.causation) : ROOT_CONTEXT;
        const span = this.startSpan({
          attributes: detachedAttributes(input),
          context: parentContext,
          correlation: input.context,
          links,
          spanName: "detached_operation",
        });
        return this.track(
          new DetachedWriter(
            span,
            parentContext,
            {
              correlation: input.context,
              spanName: "detached_operation",
            },
            this.health,
            this.metrics,
            detachedMetricLabels(input),
            (writer) => this.activeWriters.delete(writer),
          ),
        );
      },
      NOOP_DETACHED_WRITER,
    );
  }

  startCall(input: ModelCallTraceStart): ModelCallSpanWriter {
    return startModelCall(this.writerHost(), input);
  }

  abandonSession(sessionId: string): void {
    for (const writer of this.activeWriters) {
      if (writer.state.correlation?.sessionId === sessionId) {
        writer.abandon("session_shutdown");
      }
    }
  }

  abandonProcess(): void {
    for (const writer of this.activeWriters) writer.abandon("process_shutdown");
  }

  private writerHost(): TraceWriterHost {
    return {
      health: this.health,
      metrics: this.metrics,
      startSpan: (options) => this.startSpan(options),
      track: (writer) => this.track(writer),
      safeCreate: (spanName, create, fallback) => this.safeCreate(spanName, create, fallback),
      remove: (writer) => {
        this.activeWriters.delete(writer);
      },
    };
  }

  private startSpan(options: StartWriterOptions): Span {
    return this.tracer.startSpan(
      options.spanName,
      {
        attributes: options.attributes,
        kind: options.kind ?? SpanKind.INTERNAL,
        links: options.links,
      },
      options.context ?? context.active(),
    );
  }

  private track<T extends TrackedWriter>(writer: T): T {
    this.activeWriters.add(writer);
    return writer;
  }

  private safeCreate<T>(spanName: string, create: () => T, fallback: T): T {
    if (this.activeWriters.size >= this.maxActiveWriters) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "process_capacity"),
      );
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        try {
          this.health.onWarning?.("Telemetry active writer capacity was reached", {
            activeWriterCount: this.activeWriters.size,
            maxActiveWriters: this.maxActiveWriters,
            spanName,
          });
        } catch {
          // 健康回调同样属于旁路。
        }
      }
      return fallback;
    }
    this.capacityWarningActive = false;
    try {
      return create();
    } catch (error) {
      this.safeMetric(() =>
        this.metrics.recordCreationDrop(spanName as AgentMetricSpanName, "unknown"),
      );
      try {
        this.health.onWarning?.("Telemetry writer creation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
          spanName,
        });
      } catch {
        // 健康回调同样属于旁路。
      }
      return fallback;
    }
  }

  private safeMetric(record: () => void): void {
    try {
      record();
    } catch (error) {
      try {
        this.health.onWarning?.("Telemetry metric operation failed", {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // Metric 与健康回调都属于旁路。
      }
    }
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
