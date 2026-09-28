import type { WorkspaceHookBundleSnapshot, WorkspaceHookTrustRecord } from "@lcode/contracts";
import { workspaceHookTrustRecordSchema } from "@lcode/contracts";

export function createWorkspaceHookTrustRecords(input: {
  snapshot: WorkspaceHookBundleSnapshot;
  reviewItemIds: readonly string[];
  grantedAt: string;
  appVersion?: string;
}): WorkspaceHookTrustRecord[] {
  const items = new Map(input.snapshot.hooks.map((entry) => [entry.reviewItemId, entry] as const));
  return unique(input.reviewItemIds).map((reviewItemId) => {
    const entry = items.get(reviewItemId);
    if (!entry) throw new Error(`Unknown Workspace Hook review item: ${reviewItemId}`);
    const source = input.snapshot.sourceFiles[entry.sourceFileIndex];
    if (!source) throw new Error(`Workspace Hook source is missing for ${reviewItemId}`);
    return workspaceHookTrustRecordSchema.parse({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: input.grantedAt,
      bundleDigestAtGrant: input.snapshot.bundleDigest,
      eventAtGrant: entry.event,
      displayCommandAtGrant:
        entry.type === "process" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.command,
      sourcePathAtGrant: entry.sourceRelativePath,
      sourceDiscoveryOrderAtGrant: source.discoveryOrder,
      matcherAtGrant: entry.matcher,
      matcherIndexAtGrant: entry.matcherIndex,
      hookIndexAtGrant: entry.hookIndex,
      ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
    });
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
