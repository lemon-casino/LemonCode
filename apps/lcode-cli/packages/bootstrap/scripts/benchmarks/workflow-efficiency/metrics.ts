import type { ModelNetworkStatusEvent, ModelUsage } from "@lcode/contracts";
import type { RunEvent } from "@lcode/dynamic-workflow";
import { TASK_IDS, type Arm, type TaskId } from "./fixtures.js";

export const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];
export type Usage = Record<UsageKey, number | null>;
export const FAILURE_REASONS = new Set([
  "auth",
  "not_configured",
  "model_unavailable",
  "invalid_request",
  "quota",
  "other",
  "rate_limited",
  "provider_overloaded",
  "server_error",
  "network_error",
  "timeout",
  "stream_idle_timeout",
  "stale_connection",
  "offpeak_queued",
  "cancelled",
  "context_exceeded",
  "empty_response",
  "reasoning_signature_repair",
  "auth_refresh",
  "validation_failed",
  "invalid_json",
  "incomplete_stream",
  "unexpected_tool",
  "arm_timeout",
  "worker_timeout",
  "worker_failed",
  "cleanup_timeout",
  "unknown",
]);

export function safeReason(reason: unknown): string {
  return typeof reason === "string" && FAILURE_REASONS.has(reason) ? reason : "unknown";
}

export function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function sanitizeUsage(value: ModelUsage | undefined): Usage | null {
  if (!value || !USAGE_KEYS.some((key) => numeric(value[key]) !== null)) return null;
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, numeric(value[key])])) as Usage;
}

export function usageSummary(usages: (Usage | null)[]) {
  const knownSums = {} as Usage;
  const completeTotals = {} as Usage;
  const coverage = {} as Record<UsageKey, number>;
  for (const key of USAGE_KEYS) {
    const values = usages.map((usage) => usage?.[key] ?? null).filter((v) => v !== null);
    coverage[key] = values.length;
    knownSums[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    completeTotals[key] =
      usages.length > 0 && values.length === usages.length ? knownSums[key] : null;
  }
  // reasoningTokens 是 output 子类；不得再加到 totalTokens 或 outputTokens。
  return { requests: usages.length, knownSums, completeTotals, coverage };
}

export interface RequestMetric {
  id: number;
  task: TaskId;
  attempt: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  status: "queued" | "started" | "completed" | "failed";
  reason: string | null;
  adapterAttemptDurationMs: number | null;
  observedRequestDurationMs: number | null;
  outputTokensPerSecondRequestWall: number | null;
  admissionQueuedMs: number | null;
  wasQueued: boolean;
  timeToFirstProviderEventMs: number | null;
  timeToFirstContentMs: number | null;
  timeToFirstTextMs: number | null;
  usage: Usage | null;
}

export interface TaskMetric {
  task: TaskId;
  queuedAtMs: number | null;
  dispatchedAtMs: number | null;
  requestCallAtMs: number | null;
  firstTextAtMs: number | null;
  settledAtMs: number | null;
  validationMs: number | null;
  validated: boolean;
  outcome: "not_started" | "running" | "accepted" | "failed" | "cancelled";
  failureReason: string | null;
  promptSha256: string | null;
}

export class ArmMetrics {
  readonly tasks: TaskMetric[] = TASK_IDS.map((task) => ({
    task,
    queuedAtMs: null,
    dispatchedAtMs: null,
    requestCallAtMs: null,
    firstTextAtMs: null,
    settledAtMs: null,
    validationMs: null,
    validated: false,
    outcome: "not_started",
    failureReason: null,
    promptSha256: null,
  }));
  readonly requests: RequestMetric[] = [];
  readonly retries: {
    task: TaskId;
    request: number;
    reason: string;
    scheduledAtMs: number;
    scheduledDelayMs: number;
    retryAfterMs: number | null;
  }[] = [];
  readonly admission: { task: TaskId; cause: string | null; atMs: number }[] = [];
  readonly concurrency: { atMs: number; previous: number; next: number; reason: string }[] = [];
  readonly eventCounts: Record<string, number> = {};
  readonly requestIds = new Map<string, RequestMetric>();
  ttfdMs: number | null = null;
  cachedNodes = 0;
  logicalRequests = 0;

  constructor(
    readonly started: number,
    readonly clock: () => number = performance.now.bind(performance),
  ) {}

  elapsed(): number {
    return round(this.clock() - this.started);
  }
  task(task: TaskId): TaskMetric {
    return this.tasks[TASK_IDS.indexOf(task)]!;
  }

  network(task: TaskId, event: ModelNetworkStatusEvent): void {
    let request = this.requestIds.get(event.requestId);
    if (!request) {
      if (this.requests.length >= 4096) throw new Error("observation_limit");
      request = {
        id: this.requests.length + 1,
        task,
        attempt: event.attempt,
        startedAtMs: null,
        finishedAtMs: null,
        status: "queued",
        reason: null,
        adapterAttemptDurationMs: null,
        observedRequestDurationMs: null,
        outputTokensPerSecondRequestWall: null,
        admissionQueuedMs: null,
        wasQueued: false,
        timeToFirstProviderEventMs: null,
        timeToFirstContentMs: null,
        timeToFirstTextMs: null,
        usage: null,
      };
      this.requests.push(request);
      this.requestIds.set(event.requestId, request);
    }
    const at = this.elapsed();
    if (event.type === "model_request_queued") request.wasQueued = true;
    if (event.type === "model_request_admitted")
      request.admissionQueuedMs = numeric(event.queuedMs);
    if (event.type === "model_request_started") {
      request.startedAtMs = at;
      request.status = "started";
    }
    if (event.type === "model_request_completed" || event.type === "model_request_failed") {
      request.finishedAtMs = at;
      request.adapterAttemptDurationMs = numeric(event.durationMs);
      request.observedRequestDurationMs =
        request.startedAtMs === null ? null : round(at - request.startedAtMs);
      request.status = event.type === "model_request_completed" ? "completed" : "failed";
      if (event.type === "model_request_completed") {
        request.usage = sanitizeUsage(event.usage);
        const output = request.usage?.outputTokens;
        if (
          output !== undefined &&
          output !== null &&
          request.observedRequestDurationMs !== null &&
          request.observedRequestDurationMs > 0
        )
          request.outputTokensPerSecondRequestWall = round(
            (output * 1000) / request.observedRequestDurationMs,
          );
        request.timeToFirstProviderEventMs = numeric(event.timeToFirstProviderEventMs);
        request.timeToFirstContentMs = numeric(event.timeToFirstContentMs);
        request.timeToFirstTextMs = numeric(event.timeToFirstTextMs);
      } else request.reason = safeReason(event.reason);
    }
    if (event.type === "model_retry_scheduled") {
      this.retries.push({
        task,
        request: request.id,
        reason: safeReason(event.reason),
        scheduledAtMs: at,
        scheduledDelayMs: event.delayMs,
        retryAfterMs: numeric(event.retryAfterMs),
      });
    }
  }

  engine(event: RunEvent): void {
    this.eventCounts[event.type] = (this.eventCounts[event.type] ?? 0) + 1;
    const at = this.elapsed();
    if (event.type === "concurrency-changed") {
      this.concurrency.push({
        atMs: at,
        previous: event.previous,
        next: event.next,
        reason: event.reason,
      });
    }
    if (!("instance" in event) || !TASK_IDS.includes(event.instance.siteId as TaskId)) return;
    const task = this.task(event.instance.siteId as TaskId);
    if (event.type === "node-queued") task.queuedAtMs = at;
    if (event.type === "node-dispatched") {
      task.dispatchedAtMs = at;
      task.outcome = "running";
    }
    if (event.type === "node-admission")
      this.admission.push({ task: task.task, cause: event.cause, atMs: at });
    if (event.type === "node-settled") {
      this.cachedNodes += Number(event.cached === true);
      task.settledAtMs = at;
      task.outcome = event.outcome === "ok" ? "accepted" : event.outcome;
      if (event.outcome === "ok" && task.validated) this.ttfdMs ??= at;
    }
  }

  snapshot() {
    const startedRequests = this.requests.filter((request) => request.startedAtMs !== null);
    const byReason: Record<string, { count: number; scheduledDelayMs: number }> = {};
    for (const retry of this.retries) {
      const item = (byReason[retry.reason] ??= { count: 0, scheduledDelayMs: 0 });
      item.count += 1;
      item.scheduledDelayMs += retry.scheduledDelayMs;
    }
    return {
      ttfdMs: this.ttfdMs,
      totalMs: this.elapsed(),
      logicalRequests: this.logicalRequests,
      requestsStarted: startedRequests.length,
      requestsCompleted: this.requests.filter((request) => request.status === "completed").length,
      requestsFailed: this.requests.filter((request) => request.status === "failed").length,
      acceptedTasks: this.tasks.filter((task) => task.validated && task.outcome === "accepted")
        .length,
      cachedNodes: this.cachedNodes,
      tasks: this.tasks,
      requests: this.requests,
      usage: usageSummary(startedRequests.map((request) => request.usage)),
      admission: {
        scheduler: this.admission,
        providerQueuedCount: this.requests.filter((request) => request.wasQueued).length,
        measuredQueuedMs: this.requests.reduce(
          (sum, request) => sum + (request.admissionQueuedMs ?? 0),
          0,
        ),
        unresolvedQueuedCount: this.requests.filter(
          (request) => request.wasQueued && request.admissionQueuedMs === null,
        ).length,
      },
      backoff: { actualSleepMs: null, scheduled: this.retries, byReason },
      tools: { allowed: 0, executed: 0, executionMs: 0, scope: "synthetic_no_tools" },
      concurrency: this.concurrency,
      eventCounts: this.eventCounts,
    };
  }
}

export interface ArmResult {
  pair: number;
  arm: Arm;
  success: boolean;
  failureReason: string | null;
  engineStatus: string;
  cleanupCompleted: boolean;
  metrics: ReturnType<ArmMetrics["snapshot"]>;
  preparation: Record<string, unknown>;
}

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? {
        count: sorted.length,
        median: round(
          sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
        ),
        min: round(sorted[0]!),
        max: round(sorted.at(-1)!),
      }
    : null;
}

export function pairedSummary(arms: ArmResult[]) {
  const pairs = Array.from({ length: 5 }, (_, index) => {
    const a = arms.find((arm) => arm.pair === index + 1 && arm.arm === "A");
    const b = arms.find((arm) => arm.pair === index + 1 && arm.arm === "B");
    const eligible = a?.success === true && b?.success === true;
    return {
      pair: index + 1,
      complete: Boolean(a && b),
      eligible,
      totalSpeedup: eligible ? round(a.metrics.totalMs / b.metrics.totalMs) : null,
      ttfdSpeedup:
        eligible && a.metrics.ttfdMs !== null && b.metrics.ttfdMs !== null
          ? round(a.metrics.ttfdMs / b.metrics.ttfdMs)
          : null,
    };
  });
  return {
    arms: arms.length,
    successfulArms: arms.filter((arm) => arm.success).length,
    acceptedTasks: arms.reduce((sum, arm) => sum + arm.metrics.acceptedTasks, 0),
    plannedTasksForAttemptedArms: arms.length * 3,
    successfulPairs: pairs.filter((pair) => pair.eligible).length,
    pairs,
    totalSpeedup: distribution(
      pairs.flatMap((pair) => (pair.totalSpeedup === null ? [] : [pair.totalSpeedup])),
    ),
    ttfdSpeedup: distribution(
      pairs.flatMap((pair) => (pair.ttfdSpeedup === null ? [] : [pair.ttfdSpeedup])),
    ),
    byArm: Object.fromEntries(
      (["A", "B"] as const).map((arm) => {
        const selected = arms.filter((item) => item.arm === arm && item.success);
        return [
          arm,
          {
            totalMs: distribution(selected.map((item) => item.metrics.totalMs)),
            ttfdMs: distribution(
              selected.flatMap((item) =>
                item.metrics.ttfdMs === null ? [] : [item.metrics.ttfdMs],
              ),
            ),
          },
        ];
      }),
    ),
  };
}
