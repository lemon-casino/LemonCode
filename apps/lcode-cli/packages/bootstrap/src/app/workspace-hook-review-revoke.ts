import type { WorkspaceHookBundleSnapshot } from "@lcode/contracts";
import type { WorkspaceHookTrustCoordinator } from "@lcode/core";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";

export async function applyWorkspaceHookRevoke(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  digests: readonly string[];
  reviewItemIds: readonly string[];
  snapshot: WorkspaceHookBundleSnapshot;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
}): Promise<WorkspaceHookReviewCommandResult> {
  const policy = input.coordinator.getPolicy(input.snapshot.workspaceIdentity);
  if (policy.mode !== "user_decides") {
    return {
      accepted: false,
      reasonCode:
        policy.mode === "allow_trusted_only"
          ? "workspace_hooks_policy_requires_pretrust"
          : "workspace_hooks_blocked_by_policy",
    };
  }
  try {
    const file = await (
      await input.store
    ).revoke({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigests: input.digests,
    });
    input.coordinator.replacePersistentTrustRecords(file.records, { status: "ok" });
    input.coordinator.revoke({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigests: input.digests,
    });
    return { accepted: true, reviewItemIds: [...input.reviewItemIds] };
  } catch {
    return { accepted: false, reasonCode: "workspace_hooks_trust_store_corrupt" };
  }
}
