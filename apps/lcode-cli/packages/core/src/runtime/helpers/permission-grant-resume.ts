import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  traceContextToLogContext,
  type TraceContext,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

/** 授权 receipt 在恢复时仅提供辅助标记；格式损坏不能阻断历史及执行状态恢复。 */
export async function restorePermissionGrantMarker(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  runtime.lastPermissionGrantId = undefined;
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: PERMISSION_FULL_ACCESS_ENTRY,
  });
  const lastGrant = entries?.at(-1);
  if (!lastGrant) return;
  const receipt = permissionFullAccessReceiptSchema.safeParse(lastGrant.data);
  if (!receipt.success || receipt.data.event.sessionId !== runtime.sessionId) {
    runtime.logger?.warn("Ignoring invalid permission grant marker during session resume", {
      ...traceContextToLogContext(traceContext),
      event: "session.resume.permission_grant_invalid",
      module: "core.runtime",
      entryId: lastGrant.id,
      reason: receipt.success ? "session_mismatch" : "invalid_receipt",
    });
    return;
  }
  runtime.lastPermissionGrantId = receipt.data.interactionId;
}
