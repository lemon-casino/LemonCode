import type {
  CanonicalWorkspaceHookEntry,
  WorkspaceHookBundleSnapshot,
  WorkspaceHookEffectiveState,
  WorkspaceHookPolicy,
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustState,
} from "@lcode/contracts";
import {
  WORKSPACE_HOOK_STATE_ADMISSION_MAP,
  workspaceHookEffectiveStateSchema,
} from "@lcode/contracts";
import type { WorkspaceHookTrustStoreStatus } from "./workspace-hook-trust-types.js";

export function evaluateWorkspaceHookEntry(input: {
  entry: CanonicalWorkspaceHookEntry;
  snapshot: WorkspaceHookBundleSnapshot;
  policy: WorkspaceHookPolicy;
  persistentRecords: ReadonlyMap<string, WorkspaceHookTrustRecord>;
  revokedKeys: ReadonlySet<string>;
  storeStatus: WorkspaceHookTrustStoreStatus;
}): WorkspaceHookEffectiveState {
  const { entry, snapshot, policy } = input;
  const key = trustKey(snapshot.workspaceIdentity, entry.hookDeclarationDigest);
  const persistent = input.persistentRecords.get(key);
  let trustState: WorkspaceHookTrustState;

  if (policy.mode === "deny") {
    trustState = "blocked_policy";
  } else if (input.storeStatus === "corrupt") {
    trustState = "blocked_untrusted";
  } else if (policy.mode === "allow_trusted_only") {
    trustState = persistent ? "trusted_persistent" : "blocked_policy";
  } else if (persistent) {
    trustState = "trusted_persistent";
  } else if (input.revokedKeys.has(key)) {
    trustState = "revoked";
  } else if (hasStaleSlotRecord(snapshot, entry, input.persistentRecords.values())) {
    trustState = "stale_digest";
  } else {
    trustState = "pending_trust";
  }

  const mapped = WORKSPACE_HOOK_STATE_ADMISSION_MAP[trustState];
  return workspaceHookEffectiveStateSchema.parse({
    reviewItemId: entry.reviewItemId,
    sourceRootEnabled: entry.sourceRootEnabled,
    declarationEnabled: entry.declarationEnabled,
    runtimeHooksEnabled: entry.runtimeHooksEnabled,
    configuredEnabled: entry.configuredEnabled,
    editable: entry.editable,
    trustState,
    admissionClass: mapped.admissionClass,
    effectiveRunnable:
      mapped.admissionClass === "admitted" && entry.configuredEnabled && policy.mode !== "deny",
    workspaceIdentity: snapshot.workspaceIdentity,
    bundleDigest: snapshot.bundleDigest,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    sourcePaths: [
      snapshot.sourceFiles[entry.sourceFileIndex]?.canonicalPath ?? entry.sourceRelativePath,
    ],
    reasonCode: mapped.reasonCode,
  });
}

export function trustKey(workspaceIdentity: string, hookDeclarationDigest: string): string {
  return `${workspaceIdentity}\u0000${hookDeclarationDigest}`;
}

function hasStaleSlotRecord(
  snapshot: WorkspaceHookBundleSnapshot,
  entry: CanonicalWorkspaceHookEntry,
  records: Iterable<WorkspaceHookTrustRecord>,
): boolean {
  const source = snapshot.sourceFiles[entry.sourceFileIndex];
  if (!source) return false;
  for (const record of records) {
    if (record.workspaceIdentity !== snapshot.workspaceIdentity) continue;
    if (record.hookDeclarationDigest === entry.hookDeclarationDigest) continue;
    if (
      record.sourceDiscoveryOrderAtGrant === undefined ||
      record.matcherIndexAtGrant === undefined ||
      record.hookIndexAtGrant === undefined
    ) {
      continue;
    }
    if (
      record.eventAtGrant === entry.event &&
      record.sourcePathAtGrant === entry.sourceRelativePath &&
      record.sourceDiscoveryOrderAtGrant === source.discoveryOrder &&
      record.matcherAtGrant === entry.matcher &&
      record.matcherIndexAtGrant === entry.matcherIndex &&
      record.hookIndexAtGrant === entry.hookIndex
    ) {
      return true;
    }
  }
  return false;
}
