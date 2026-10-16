import type {
  RoutingRequest,
  RoutingWindow,
  RoutingTokens,
  ProviderRoutingPolicy,
} from "@lcode/shared/provider-routing";
/** 共享额度 owner 的窄端口；Scheduler 不依赖任何 IO 实现。 */
export interface SharedQuotaInput {
  providerId: string;
  poolId: string;
  keyId: string;
  maxInFlight: number;
  reserveRules?: ProviderRoutingPolicy["reserveRules"];
  request: Pick<RoutingRequest, "attemptId" | "scopeKey" | "modelKey" | "tokens" | "demands"> & {
    createdAt: number;
  };
  windows: readonly RoutingWindow[];
}
export interface SharedQuotaHandle {
  poolKey: string;
  leaseId: string;
  fence: string;
  sequence: number;
  expiresAt: number;
}
export interface RoutingQuotaDiagnostic {
  resourceId: string;
  instanceId: string;
  readingRemaining?: number;
  limit?: number;
  unit?: string;
  quality: RoutingWindow["quality"];
  current?: boolean;
  coveredThroughSeq?: number;
  reserved: number;
  dispatched: number;
  endedActual: number;
  endedEstimated: number;
  folded: number;
  foldedUnknown: boolean;
  held: number;
  available?: number;
}
export interface SharedQuotaView {
  asOf: number;
  resourceCount: number;
  resourcesTruncated: boolean;
  source: "shared-owner";
  sequence: number;
  inFlight: number;
  reservations: number;
  retainedAttempts: number;
  capacity: number;
  recovery: { resource: string; revision: number; phase: string; retryAt?: number }[];
  resources: RoutingQuotaDiagnostic[];
}
export interface SharedQuotaFeedback {
  outcome?: "success" | "failed" | "cancelled" | "unknown";
  statusCode?: number;
  retryAfterMs?: number;
  rateLimitScope?: "key" | "shared";
}
export interface SharedQuotaCoordinator {
  reserve(input: SharedQuotaInput): Promise<SharedQuotaHandle>;
  dispatch(handle: SharedQuotaHandle): Promise<boolean>;
  cancel(handle: SharedQuotaHandle): Promise<void>;
  finish(handle: SharedQuotaHandle): Promise<void>;
  rollbackDispatch(handle: SharedQuotaHandle): Promise<void>;
  usage(
    handle: SharedQuotaHandle,
    actual: Readonly<Record<string, number>>,
    tokens?: RoutingTokens,
    feedback?: SharedQuotaFeedback,
  ): Promise<void>;
  observe(
    providerId: string,
    poolId: string,
    windows: readonly RoutingWindow[],
    coversThroughSeq?: number,
  ): Promise<void>;
  inspect(providerId: string, poolId: string): Promise<SharedQuotaView>;
}
