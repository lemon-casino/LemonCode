import type { SharedQuotaFeedback } from "@lcode/provider";
import { sharedRecovery, type SharedQuotaState } from "./api-key-shared-quota-state.js";
export function applySharedRecoveryFeedback(
  state: SharedQuotaState,
  lease: SharedQuotaState["leases"][string],
  observed: SharedQuotaFeedback,
  now: number,
) {
  const recovery = sharedRecovery(state);
  if (lease.recoveryPermit) {
    if (
      observed.outcome === "failed" &&
      observed.statusCode === undefined &&
      (lease.state === "dispatched" || lease.state === "ended")
    )
      recovery.fail(
        lease.recoveryPermit,
        Object.keys(lease.recoveryPermit.versions).filter((key) => key.startsWith("model:")),
        now + 1000,
      );
    if (
      observed.statusCode === 429 ||
      (observed.statusCode !== undefined && observed.statusCode >= 500)
    ) {
      const prefix =
        observed.rateLimitScope === "provider" ||
        (observed.statusCode === 429 && observed.rateLimitScope === undefined)
          ? "provider"
          : observed.rateLimitScope === "shared" || observed.rateLimitScope === "pool"
            ? "pool"
            : observed.rateLimitScope === "key"
              ? "key:"
              : "model:";
      recovery.fail(
        lease.recoveryPermit,
        Object.keys(lease.recoveryPermit.versions).filter((key) => key.startsWith(prefix)),
        now + (observed.retryAfterMs ?? 1000),
      );
    }
    recovery.observe(lease.recoveryPermit, observed.outcome, now);
  }
}
