import type { ModelNetworkStatusEvent, ModelStatusSink } from "./network-status.js";
import type { ModelUsage } from "./usage.js";

export interface PhysicalRequestBoundary {
  requestId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Final invocation boundary; preparation lifecycle events are not physical starts. */
  startedEvent?: ModelNetworkStatusEvent;
  /** null means the actual request has no selected speed; missing is unobserved. */
  selectedSpeed?: string | null;
}

/** Optional, invocation-scoped benchmark accounting. No prompts, headers or production storage. */
export interface PhysicalRequestAccountingPort extends ModelStatusSink {
  beforeRequest(input: PhysicalRequestBoundary): void;
}

export interface PhysicalRequestFact {
  requestId: string;
  operationId?: string;
  parentOperationId?: string;
  sessionId?: string;
  parentSessionId?: string;
  providerId?: string;
  modelId?: string;
  selectedSpeed?: string | null;
  effectiveReasoningState?: string;
  effectiveReasoningControl?: string;
  effectiveReasoningLevel?: string;
  effectiveReasoningBudgetTokens?: number;
  kind: "main" | "actor" | "compact" | "memory" | "other";
  status: "reserved" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  totalTokens: number | null;
}

export interface PhysicalRequestSummary {
  schemaVersion: 1;
  tokenCoverage: "complete" | "incomplete";
  reservedTokens: number;
  totalTokens: number | null;
  knownTokens: number;
  maintenanceTokens: number | null;
  unsettledRequests: number;
  cost: null;
  requests: PhysicalRequestFact[];
}

export function createPhysicalRequestAccounting(
  limits: { maxRequests: number; maxReservedTokens: number },
  onLimit?: (reason: string) => void,
) {
  if (![limits.maxRequests, limits.maxReservedTokens].every(positiveInteger)) {
    throw new Error("benchmark_limits_invalid");
  }
  const records = new Map<string, PhysicalRequestFact>();
  let reservedTokens = 0;
  let stopped: string | undefined;
  let sealed = false;
  const reject = (reason: string): never => {
    stopped = reason;
    onLimit?.(reason);
    throw new Error(reason);
  };
  const publish = (event: ModelNetworkStatusEvent): void => {
    const fact = records.get(event.requestId);
    // seal 是观测终态；迟到 sidecar 不能改变已经输出的 incomplete 事实。
    if (sealed || !fact || fact.status === "completed" || fact.status === "failed") return;
    if (
      !["model_request_started", "model_request_completed", "model_request_failed"].includes(
        event.type,
      )
    )
      return;
    fact.kind = classify(event.querySource);
    fact.operationId = event.modelCall?.operationId ?? event.spanId;
    fact.parentOperationId = event.parentSpanId;
    fact.sessionId = event.sessionId;
    fact.parentSessionId = event.parentSessionId;
    fact.providerId = event.providerId;
    fact.modelId = event.modelId;
    fact.effectiveReasoningState = event.modelCall?.reasoning.effectiveState;
    fact.effectiveReasoningControl = event.modelCall?.reasoning.effectiveControl;
    fact.effectiveReasoningLevel = event.modelCall?.reasoning.effectiveLevel;
    fact.effectiveReasoningBudgetTokens = event.modelCall?.reasoning.effectiveBudgetTokens;
    if (event.type === "model_request_started") {
      fact.startedAt ??= event.timestamp;
      fact.status = "running";
    } else {
      fact.completedAt = event.timestamp;
      fact.status = event.type === "model_request_completed" ? "completed" : "failed";
      fact.totalTokens = event.type === "model_request_completed" ? total(event.usage) : null;
    }
  };
  return {
    beforeRequest(input: PhysicalRequestBoundary): void {
      if (sealed) throw new Error("benchmark_accounting_closed");
      if (stopped) throw new Error(stopped);
      if (records.has(input.requestId)) return;
      if (!positiveInteger(input.contextWindow) || !positiveInteger(input.maxOutputTokens)) {
        reject("benchmark_model_bounds_missing");
      }
      const reservation = input.contextWindow! + input.maxOutputTokens!;
      if (records.size >= limits.maxRequests) reject("benchmark_request_budget");
      if (reservation > limits.maxReservedTokens - reservedTokens) reject("benchmark_token_budget");
      reservedTokens += reservation;
      records.set(input.requestId, {
        requestId: input.requestId,
        kind: "other",
        status: "reserved",
        totalTokens: null,
        ...(input.selectedSpeed === undefined ? {} : { selectedSpeed: input.selectedSpeed }),
      });
      if (input.startedEvent) publish(input.startedEvent);
    },
    publish,
    seal(): void {
      sealed = true;
    },
    snapshot(): PhysicalRequestSummary {
      const requests = [...records.values()].map((fact) => ({ ...fact }));
      const unsettledRequests = requests.filter(
        (r) => r.status === "reserved" || r.status === "running",
      ).length;
      const complete =
        requests.length > 0 &&
        requests.every((r) => r.startedAt && r.totalTokens !== null && r.status === "completed");
      const knownTokens = requests.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
      const memory = requests.filter((r) => r.kind === "memory");
      return {
        schemaVersion: 1,
        tokenCoverage: complete ? "complete" : "incomplete",
        reservedTokens,
        totalTokens: complete ? knownTokens : null,
        knownTokens,
        maintenanceTokens: memory.every((r) => r.totalTokens !== null)
          ? memory.reduce((sum, r) => sum + r.totalTokens!, 0)
          : null,
        unsettledRequests,
        cost: null,
        requests,
      };
    },
  };
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function total(usage?: ModelUsage): number | null {
  const valid = (n: number | undefined): n is number =>
    n !== undefined && Number.isSafeInteger(n) && n >= 0;
  if (valid(usage?.totalTokens)) return usage.totalTokens;
  if (valid(usage?.inputTokens) && valid(usage?.outputTokens))
    return usage.inputTokens + usage.outputTokens;
  return null;
}

function classify(source = ""): PhysicalRequestFact["kind"] {
  if (/memory/i.test(source)) return "memory";
  if (/compact/i.test(source)) return "compact";
  if (/workflow|subagent|actor/i.test(source)) return "actor";
  return source === "main_turn" ? "main" : "other";
}
