import { createLocalTtftSpans } from "./localTtftSpans.js";
import { LocalTtftExportDedupe } from "./localTtftExportDedupe.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { LOCAL_TTFT_BUCKETS_MS, localTtftBatchSchema, type LocalTtftBatch } from "@lcode/shared";
import {
  createRendererActionTraceExporter,
  parseRendererActionTraceHeaders,
  validHttpUrl,
} from "./rendererActionTraceExporter.js";

const MAX_QUEUE = 32;
const EXPORT_TIMEOUT_MS = 3000;

/** 只接收已冻结的观测事实；Main 不参与 session/command 状态裁决。 */
export function createLocalTtftExporter(options: {
  env: Record<string, string | undefined>;
  now?: () => number;
  version: string;
  logger: { warn(...args: unknown[]): void };
}) {
  const exporter = createRendererActionTraceExporter(options.env);
  const endpoint =
    validHttpUrl(options.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ??
    validHttpUrl(
      options.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${options.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`
        : undefined,
    );
  const resource = resourceFromAttributes({
    "service.name": "lcode-local-ttft",
    "service.version": options.version,
    "os.type": process.platform,
    "lcode.telemetry.schema_version": 1,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: endpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: endpoint,
              headers: parseRendererActionTraceHeaders(
                options.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ??
                  options.env.OTEL_EXPORTER_OTLP_HEADERS,
              ),
              temporalityPreference: AggregationTemporality.DELTA,
              timeoutMillis: EXPORT_TIMEOUT_MS,
            }),
            exportIntervalMillis: 5000,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
          }),
        ]
      : [],
    views: [
      {
        instrumentName: "lcode.local_ttft.*",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: LOCAL_TTFT_BUCKETS_MS },
        },
        instrumentType: InstrumentType.HISTOGRAM,
        aggregationCardinalityLimit: 256,
      },
      {
        instrumentName: "lcode.local_ttft.*",
        instrumentType: InstrumentType.COUNTER,
        aggregationCardinalityLimit: 256,
      },
    ],
  });
  const meter = meterProvider.getMeter("@lcode/local-ttft", "1");
  const duration = meter.createHistogram("lcode.local_ttft.duration", { unit: "ms" });
  const stageDuration = meter.createHistogram("lcode.local_ttft.stage.duration", { unit: "ms" });
  const stageObservation = meter.createHistogram("lcode.local_ttft.stage.observation.duration", {
    unit: "ms",
  });
  const preparationObservation = meter.createHistogram(
    "lcode.local_ttft.preparation.observation.duration",
    { unit: "ms" },
  );
  const systemDuration = meter.createHistogram("lcode.local_ttft.system.duration", { unit: "ms" });
  const preparationDuration = meter.createHistogram("lcode.local_ttft.preparation.duration", {
    unit: "ms",
  });
  const attemptDuration = meter.createHistogram("lcode.local_ttft.attempt.duration", {
    unit: "ms",
  });
  const executionDuration = meter.createHistogram("lcode.local_ttft.execution.duration", {
    unit: "ms",
  });
  const failureWait = meter.createHistogram("lcode.local_ttft.no_output.wait", { unit: "ms" });
  const textDuration = meter.createHistogram("lcode.local_ttft.first_text.duration", {
    unit: "ms",
  });
  const outcomes = meter.createCounter("lcode.local_ttft.records");
  const drops = meter.createCounter("lcode.local_ttft.dropped");
  const queue: LocalTtftBatch[] = [];
  const dedupe = new LocalTtftExportDedupe(options.now);
  const modelLabels = new Set<string>();
  let draining: Promise<void> | undefined;
  let closed = false;
  const consume = async () => {
    while (queue.length && !closed) {
      const batch = queue.shift()!;
      drops.add(batch.dropped, { reason: "renderer_capacity" });
      const spans: ReadableSpan[] = [];
      for (const record of batch.records) {
        const remember = dedupe.admit(batch.rendererInstanceId, record.observationId, record.start);
        if (!remember) {
          drops.add(1, { reason: "dedupe_window_or_capacity" });
          continue;
        }
        const key = record.observationId;
        const pair = `${record.provider ?? "unknown"}/${record.model ?? "unknown"}`;
        if (modelLabels.size < 16 && /^[a-zA-Z0-9._:/-]{1,128}$/.test(pair)) modelLabels.add(pair);
        const labels = {
          provider: modelLabels.has(pair) ? (record.provider ?? "unknown") : "other",
          model: modelLabels.has(pair) ? (record.model ?? "unknown") : "other",
          quality: record.quality,
          visibility: record.visibility ?? "foreground",
          send_mode: record.sendMode ?? "idle",
          app_version: options.version,
          os: process.platform,
        };
        const firstRecord = remember(`${key}:${record.kind}:${record.checkpointId ?? ""}`);
        if (firstRecord) {
          outcomes.add(1, {
            kind: record.kind,
            outcome: record.outcome,
            quality: record.quality,
            send_mode: labels.send_mode,
            visibility: labels.visibility,
          });
          if (record.truncated) drops.add(1, { reason: "detail_truncated" });
          if (
            record.kind === "first_output" &&
            record.outcome === "success" &&
            record.timingReliable !== false &&
            record.sendMode !== "guided"
          ) {
            duration.record(record.end - record.start, labels);
            if ((record.userWaitMs ?? 0) <= record.end - record.start)
              systemDuration.record(record.end - record.start - (record.userWaitMs ?? 0), labels);
            if (record.executionMs !== undefined)
              executionDuration.record(record.executionMs, labels);
          }
          if (
            record.kind === "first_text" &&
            record.outcome === "success" &&
            record.timingReliable !== false
          )
            textDuration.record(record.end - record.start, labels);
          if (
            record.kind === "excluded" &&
            ["failed", "cancelled", "rejected", "interrupted"].includes(record.outcome) &&
            record.timingReliable !== false
          )
            failureWait.record(record.end - record.start, { ...labels, outcome: record.outcome });
        }
        const intervals = record.intervals.filter((interval) =>
          remember(`${key}:stage:${interval.stage}`),
        );
        for (const interval of intervals) {
          const reliable =
            interval.source === "cli"
              ? record.cliTimingReliable !== false
              : interval.source === "renderer"
                ? record.timingReliable !== false
                : record.quality !== "clock_invalid";
          if (reliable)
            stageObservation.record(interval.end - interval.start, {
              ...labels,
              stage: interval.stage,
              clock_source: interval.source,
            });
        }
        const details = (record.details ?? []).filter((detail) =>
          remember(`${key}:detail:${detail.id}:${detail.end === undefined ? "open" : "closed"}`),
        );
        for (const detail of details) {
          if (
            detail.end === undefined ||
            (detail.source === "cli"
              ? record.cliTimingReliable === false
              : record.timingReliable === false)
          )
            continue;
          const histogram = detail.stage === "attempt" ? attemptDuration : preparationObservation;
          histogram.record(detail.end - detail.start, {
            ...labels,
            stage: detail.stage,
            role: detail.role ?? "preparation",
            outcome: detail.outcome ?? "completed",
          });
        }
        // 默认体验分布在 Renderer 已确定整条输入的前后台与时钟质量后落样；
        // 累计阶段观察另用 observation instrument，避免先报前台再切后台污染默认分布。
        if (
          (record.kind === "first_output" || record.firstOutputKind) &&
          record.outcome === "success"
        ) {
          for (const interval of record.intervals) {
            if (record.quality === "complete" && remember(`${key}:success-stage:${interval.stage}`))
              stageDuration.record(interval.end - interval.start, {
                ...labels,
                stage: interval.stage,
              });
          }
          for (const detail of record.details ?? []) {
            if (
              detail.stage !== "attempt" &&
              detail.end !== undefined &&
              record.quality === "complete" &&
              remember(`${key}:success-detail:${detail.id}`)
            )
              preparationDuration.record(detail.end - detail.start, {
                ...labels,
                stage: detail.stage,
              });
          }
        }
        spans.push(
          ...createLocalTtftSpans({ ...record, intervals, details }, resource, firstRecord, record),
        );
      }
      if (exporter && spans.length && !(await exportWithin(exporter, spans))) {
        drops.add(spans.length, { reason: "trace_export" });
        options.logger.warn("[local-ttft] trace export failed or timed out", {
          spans: spans.length,
        });
      }
    }
  };
  return {
    enqueue(input: unknown): void {
      if (closed || !exporter || !endpoint) return;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(input));
      } catch {
        return;
      }
      if (size > 256 * 1024) {
        drops.add(1, { reason: "oversized" });
        return;
      }
      const parsed = localTtftBatchSchema.safeParse(input);
      if (!parsed.success) {
        drops.add(1, { reason: "invalid" });
        options.logger.warn("[local-ttft] rejected invalid batch", { issues: parsed.error.issues });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        drops.add(parsed.data.records.length, { reason: "queue_full" });
        return;
      }
      queue.push(parsed.data);
      draining ??= Promise.resolve()
        .then(consume)
        .catch(() => {
          drops.add(1, { reason: "export_error" });
        })
        .finally(() => {
          draining = undefined;
        });
    },
    async shutdown(): Promise<void> {
      closed = true;
      queue.length = 0;
      await Promise.allSettled([meterProvider.shutdown(), exporter?.shutdown()]);
    },
  };
}

function exportWithin(exporter: SpanExporter, spans: ReadableSpan[]): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), EXPORT_TIMEOUT_MS);
    timer.unref();
    try {
      exporter.export(spans, (result) => {
        clearTimeout(timer);
        resolve(result.code === 0);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}
