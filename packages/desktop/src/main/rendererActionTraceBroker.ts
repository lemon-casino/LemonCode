import { SpanKind, SpanStatusCode, TraceFlags, type HrTime } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  RENDERER_ACTION_TRACE_MAX_BATCH_BYTES,
  rendererActionTraceBatchSchema,
  type RendererActionTraceBatchV1,
  type RendererActionTraceSpanV1,
} from "@lcode/shared";

const RENDERER_ACTION_TRACE_MAX_INGRESS_BATCHES = 32;
const RENDERER_ACTION_TRACE_EXPORT_TIMEOUT_MS = 3_000;
const RENDERER_ACTION_TRACE_SHUTDOWN_TIMEOUT_MS = 2_000;
const RENDERER_ACTION_TRACE_FLUSH_TIMEOUT_MS = 2_000;

export interface RendererActionTraceBroker {
  enqueue(batch: unknown): boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createRendererActionTraceBroker(options: {
  exporter: SpanExporter | undefined;
  logger: {
    debug(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
  shutdownTimeoutMs?: number;
  flushTimeoutMs?: number;
  exportTimeoutMs?: number;
}): RendererActionTraceBroker {
  const queue: RendererActionTraceBatchV1[] = [];
  let drainPromise: Promise<void> | undefined;
  let flushPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let closed = false;
  let shuttingDown = false;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? RENDERER_ACTION_TRACE_SHUTDOWN_TIMEOUT_MS;
  const flushTimeoutMs = options.flushTimeoutMs ?? RENDERER_ACTION_TRACE_FLUSH_TIMEOUT_MS;
  const exportTimeoutMs = options.exportTimeoutMs ?? RENDERER_ACTION_TRACE_EXPORT_TIMEOUT_MS;

  const drain = async (): Promise<void> => {
    if (!options.exporter || closed) {
      queue.splice(0, queue.length);
      return;
    }
    while (queue.length > 0) {
      if (closed) {
        queue.splice(0, queue.length);
        return;
      }
      const batch = queue.shift();
      if (!batch) continue;
      const spans = batch.spans.map((span) => toReadableSpan(batch, span));
      let result = await exportSpansWithDeadline(options.exporter, spans, exportTimeoutMs);
      // Bug 原因：deadline 只能停止等待，无法取消已发出的 exporter 请求。超时后立即重试
      // 可能让迟到的首次请求和重试同时成功，因此仅在 exporter 明确失败时重试。
      if (result === "failed" && !closed) {
        result = await exportSpansWithDeadline(options.exporter, spans, exportTimeoutMs);
      }
      if (result !== "success" && !closed) {
        options.logger.warn("[renderer-action-trace] batch export failed", {
          rendererInstanceId: batch.rendererInstanceId,
          sequence: batch.sequence,
          spanCount: spans.length,
          failureKind: result,
        });
      }
    }
  };

  const scheduleDrain = (): void => {
    if (drainPromise) return;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = undefined;
        if (!closed && queue.length > 0) scheduleDrain();
      });
  };

  return {
    enqueue(input) {
      if (closed || shuttingDown || !options.exporter) return false;
      let serializedBytes = 0;
      try {
        serializedBytes = Buffer.byteLength(JSON.stringify(input));
      } catch {
        return false;
      }
      if (serializedBytes > RENDERER_ACTION_TRACE_MAX_BATCH_BYTES) {
        options.logger.warn("[renderer-action-trace] rejected oversized batch", {
          serializedBytes,
        });
        return false;
      }
      const parsed = rendererActionTraceBatchSchema.safeParse(input);
      if (!parsed.success) {
        options.logger.warn("[renderer-action-trace] rejected malformed batch", {
          issueCount: parsed.error.issues.length,
        });
        return false;
      }
      if (queue.length >= RENDERER_ACTION_TRACE_MAX_INGRESS_BATCHES) {
        options.logger.warn("[renderer-action-trace] ingress queue full", {
          rendererInstanceId: parsed.data.rendererInstanceId,
          sequence: parsed.data.sequence,
        });
        return false;
      }
      queue.push(parsed.data);
      scheduleDrain();
      return true;
    },
    flush() {
      if (flushPromise) return flushPromise;
      flushPromise = (async () => {
        await drainPromise;
        if (queue.length > 0) {
          scheduleDrain();
          await drainPromise;
        }
        if (options.exporter?.forceFlush) {
          const deadline = Date.now() + flushTimeoutMs;
          const forceFlush = Promise.resolve().then(() => options.exporter?.forceFlush?.());
          if (!(await settleWithinDeadline(forceFlush, deadline)).completed) {
            options.logger.warn(
              "[renderer-action-trace] exporter forceFlush exceeded deadline; continuing",
            );
          }
        }
      })().finally(() => {
        flushPromise = undefined;
      });
      return flushPromise;
    },
    shutdown() {
      if (closed) return Promise.resolve();
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      shutdownPromise = (async () => {
        const deadline = Date.now() + shutdownTimeoutMs;
        if (drainPromise && !(await settleWithinDeadline(drainPromise, deadline)).completed) {
          closed = true;
          const droppedBatchCount = queue.splice(0, queue.length).length;
          options.logger.warn(
            "[renderer-action-trace] shutdown deadline exceeded; dropping queued batches",
            { droppedBatchCount },
          );
          return;
        }
        closed = true;
        queue.splice(0, queue.length);
        const remainingMs = deadline - Date.now();
        if (options.exporter?.shutdown && remainingMs > 0) {
          const exporterShutdown = Promise.resolve().then(() => options.exporter?.shutdown());
          if (!(await settleWithinDeadline(exporterShutdown, deadline)).completed) {
            options.logger.warn(
              "[renderer-action-trace] exporter shutdown exceeded deadline; continuing app quit",
            );
          }
        }
      })();
      return shutdownPromise;
    },
  };
}

async function settleWithinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  options?: { unrefTimer?: boolean },
): Promise<{ completed: true; value?: T } | { completed: false }> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return { completed: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ completed: false }>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), remainingMs);
    if (options?.unrefTimer) timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ completed: true as const, value }),
        () => ({ completed: true as const }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function exportSpansWithDeadline(
  exporter: SpanExporter,
  spans: ReadableSpan[],
  timeoutMs: number,
): Promise<"success" | "failed" | "timeout"> {
  const settled = await settleWithinDeadline(exportSpans(exporter, spans), Date.now() + timeoutMs, {
    unrefTimer: true,
  });
  if (!settled.completed) return "timeout";
  return settled.value === true ? "success" : "failed";
}

function toReadableSpan(
  batch: RendererActionTraceBatchV1,
  span: RendererActionTraceSpanV1,
): ReadableSpan {
  const startTime = unixMsToHrTime(span.startTimeUnixMs);
  const endTime = unixMsToHrTime(span.endTimeUnixMs);
  const resource = resourceFromAttributes({
    "service.name": batch.resource.serviceName,
    "service.version": batch.resource.serviceVersion,
    "service.instance.id": batch.resource.rendererInstanceId,
    "deployment.environment.name": batch.resource.deploymentEnvironment,
  });
  return {
    name: span.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: span.traceId,
      spanId: span.spanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    }),
    startTime,
    endTime,
    status: {
      code:
        span.status === "ok"
          ? SpanStatusCode.OK
          : span.status === "error"
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
    },
    attributes: span.attributes,
    links: [],
    events: [],
    duration: subtractHrTime(endTime, startTime),
    ended: true,
    resource,
    instrumentationScope: {
      name: "@lcode/desktop-renderer-action-trace",
      version: "1",
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function unixMsToHrTime(value: number): HrTime {
  const seconds = Math.floor(value / 1_000);
  const nanos = Math.floor((value - seconds * 1_000) * 1_000_000);
  return [seconds, nanos];
}

function subtractHrTime(end: HrTime, start: HrTime): HrTime {
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1_000_000_000;
  }
  return [Math.max(seconds, 0), Math.max(nanos, 0)];
}

function exportSpans(exporter: SpanExporter, spans: ReadableSpan[]): Promise<boolean> {
  return new Promise((resolve) => {
    exporter.export(spans, (result) => resolve(result.code === 0));
  });
}
