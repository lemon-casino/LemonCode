import { context, SpanKind } from "@opentelemetry/api";
import type {
  ModelCallTraceStart,
  ModelCallSpanWriter,
  ModelAttemptTraceStart,
  ModelAttemptSpanWriter,
} from "@lcode/contracts/telemetry";
import { activeWriterContext, safeEnum, safeId } from "./agent-trace-support.js";
import { inheritedMetadata } from "./agent-trace-writer-base.js";
import { ModelCallWriter } from "./agent-trace-model-call-writer.js";
import { ModelAttemptWriter } from "./agent-trace-model-attempt-writer.js";
import { modelCallMetricLabels, modelAttemptMetricLabels } from "./agent-trace-metric-labels.js";
import { modelCallAttributes, modelAttemptAttributes } from "./agent-trace-attributes.js";
import { NOOP_MODEL_CALL_WRITER, NOOP_MODEL_ATTEMPT_WRITER } from "./agent-trace-noop.js";
import type { TraceWriterHost } from "./agent-trace-start-types.js";

export function startModelCall(
  host: TraceWriterHost,
  input: ModelCallTraceStart,
): ModelCallSpanWriter {
  const parent = activeWriterContext();
  return host.safeCreate(
    "model_call",
    () => {
      const parentContext = parent?.activeContext ?? context.active();
      const span = host.startSpan({
        attributes: modelCallAttributes(parent, input),
        context: parentContext,
        correlation: parent?.correlation,
        parent,
        spanName: "model_call",
        toolCallId: parent?.toolCallId,
      });
      return host.track(
        new ModelCallWriter(
          span,
          parentContext,
          {
            ...inheritedMetadata(parent, "model_call"),
          },
          host.health,
          host.metrics,
          modelCallMetricLabels(input),
          (writer) => host.remove(writer),
          (writer, attempt) => startAttempt(host, writer, attempt),
          safeId(input.logicalCallId),
          safeEnum(input.operation),
          safeEnum(input.modelRole),
        ),
      );
    },
    NOOP_MODEL_CALL_WRITER,
  );
}

function startAttempt(
  host: TraceWriterHost,
  parentWriter: ModelCallWriter,
  input: ModelAttemptTraceStart,
): ModelAttemptSpanWriter {
  const parent = parentWriter.state;
  return host.safeCreate(
    "model_attempt",
    () => {
      const span = host.startSpan({
        attributes: modelAttemptAttributes(parent, parentWriter, input),
        context: parent.activeContext,
        correlation: parent.correlation,
        kind: SpanKind.CLIENT,
        parent,
        spanName: "model_attempt",
        toolCallId: parent.toolCallId,
      });
      return host.track(
        new ModelAttemptWriter(
          span,
          parent.activeContext,
          inheritedMetadata(parent, "model_attempt"),
          host.health,
          host.metrics,
          modelAttemptMetricLabels(input, parentWriter),
          () => parentWriter.recordAttemptFailed(),
          (writer) => host.remove(writer),
        ),
      );
    },
    NOOP_MODEL_ATTEMPT_WRITER,
  );
}
