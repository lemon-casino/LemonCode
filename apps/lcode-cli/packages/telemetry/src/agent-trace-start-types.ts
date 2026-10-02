import type { Attributes, Context, Link, Span, SpanKind } from "@opentelemetry/api";
import type { AgentTelemetryExecutionContext } from "@lcode/contracts/telemetry";
import type { AgentTelemetryMetricRecorder } from "./agent-metrics.js";
import type { ActiveWriterContext, WriterHealth } from "./agent-trace-support.js";
import type { TrackedWriter } from "./agent-trace-writer-base.js";

export interface StartWriterOptions {
  attributes?: Attributes;
  context?: Context;
  correlation?: AgentTelemetryExecutionContext;
  kind?: SpanKind;
  links?: Link[];
  parent?: ActiveWriterContext;
  spanName: string;
  toolCallId?: string;
}

/** 创建辅助函数借用 runtime 的注册/释放路径，不持有第二份 active writer 集合。 */
export interface TraceWriterHost {
  readonly health: WriterHealth;
  readonly metrics: AgentTelemetryMetricRecorder;
  startSpan(options: StartWriterOptions): Span;
  track<T extends TrackedWriter>(writer: T): T;
  safeCreate<T>(spanName: string, create: () => T, fallback: T): T;
  remove(writer: TrackedWriter): void;
}
