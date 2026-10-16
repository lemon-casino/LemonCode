import {
  providerAuthorizationDiagnosticSchema,
  type ProviderAuthorization,
  type ProviderAuthorizationDiagnostic,
} from "@lcode/shared";
import { readAuthorizationDiagnostic } from "@lcode/provider-node";
import { createServiceLogger } from "../logger/serviceLogger.js";
const logger = createServiceLogger("provider-authorization");
export interface AuthorizationProgressOwner {
  view: ProviderAuthorization;
  startedAt?: number;
}
export function updateAuthorizationProgress(
  owner: AuthorizationProgressOwner,
  diagnostic: ProviderAuthorizationDiagnostic,
): void {
  const parsed = providerAuthorizationDiagnosticSchema.parse(diagnostic);
  if (JSON.stringify(owner.view.diagnostic) === JSON.stringify(parsed)) return;
  owner.view = { ...owner.view, diagnostic: parsed };
  const fact = {
    attemptId: owner.view.attemptId,
    channelId: owner.view.channelId,
    methodId: owner.view.methodId,
    status: owner.view.status,
    ...parsed,
    durationMs: Math.max(0, Date.now() - (owner.startedAt ?? Date.now())),
  };
  if (parsed.code) logger.warn(undefined, "authorization transition", fact);
  else logger.info(undefined, "authorization transition", fact);
}
export function failAuthorizationProgress(
  owner: AuthorizationProgressOwner,
  error: unknown,
  phase: ProviderAuthorizationDiagnostic["phase"],
  saved = false,
): void {
  updateAuthorizationProgress(owner, {
    ...readAuthorizationDiagnostic(error, phase, saved),
    ...(phase === "post-login" && owner.view.diagnostic?.followupPending !== undefined
      ? { followupPending: owner.view.diagnostic.followupPending }
      : {}),
  });
}
