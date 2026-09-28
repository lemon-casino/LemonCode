import type {
  WorkspaceHookBundleSnapshot,
  WorkspaceHookPolicy,
  WorkspaceHookReasonCode,
  WorkspaceHookSecurityRevision,
  WorkspaceHookTrustRecord,
} from "@lcode/contracts";
import {
  workspaceHookPolicySchema,
  workspaceHookTrustRecordSchema,
} from "@lcode/contracts";
import { evaluateWorkspaceHookEntry, trustKey } from "./workspace-hook-trust-evaluation.js";
import {
  InMemoryWorkspaceHookPolicyProvider,
  type WorkspaceHookPolicyProvider,
} from "./workspace-hook-policy.js";
import type {
  WorkspaceHookSnapshotEvaluation,
  WorkspaceHookTrustStoreState,
} from "./workspace-hook-trust-types.js";

export interface WorkspaceHookTrustCoordinatorOptions {
  coordinatorEpoch: string;
  policyProvider?: WorkspaceHookPolicyProvider;
}

export class WorkspaceHookTrustCoordinator {
  private readonly coordinatorEpoch: string;
  private readonly policyProvider: WorkspaceHookPolicyProvider;
  private readonly revisions = new Map<string, number>();
  private readonly persistentRecords = new Map<string, WorkspaceHookTrustRecord>();
  private readonly revokedKeys = new Set<string>();
  private storeState: WorkspaceHookTrustStoreState = { status: "missing" };

  constructor(options: WorkspaceHookTrustCoordinatorOptions) {
    if (!options.coordinatorEpoch.trim()) throw new Error("coordinatorEpoch must not be empty");
    this.coordinatorEpoch = options.coordinatorEpoch;
    this.policyProvider = options.policyProvider ?? new InMemoryWorkspaceHookPolicyProvider();
    this.policyProvider.subscribe((change) => {
      if (change.workspaceIdentity) {
        this.bumpRevision(change.workspaceIdentity);
        return;
      }
      for (const workspaceIdentity of this.listKnownWorkspaceIdentities()) {
        this.bumpRevision(workspaceIdentity);
      }
    });
  }

  getPolicy(workspaceIdentity: string): WorkspaceHookPolicy {
    return this.resolvePolicy(workspaceIdentity).policy;
  }

  assertPersistentTrustMutationAllowed(workspaceIdentity: string): void {
    const policy = this.resolvePolicy(workspaceIdentity).policy;
    if (policy.mode !== "user_decides") {
      throw new Error(`Policy ${policy.mode} does not allow persistent Trust mutation`);
    }
  }

  /**
   * 非抛错版资格判定：controller 的 respond 在 mutation 前用它返回精确 reasonCode
   * （策略拒绝不得被 catch-all 误报为 trust_store_corrupt）；
   * applyDecision 内的 assert 版保留作为纵深第二道。
   */
  canMutatePersistentTrust(workspaceIdentity: string): boolean {
    return this.resolvePolicy(workspaceIdentity).policy.mode === "user_decides";
  }

  replacePersistentTrustRecords(
    records: readonly WorkspaceHookTrustRecord[],
    state: WorkspaceHookTrustStoreState,
  ): void {
    const previousWorkspaces = new Set(
      Array.from(this.persistentRecords.values(), (record) => record.workspaceIdentity),
    );
    this.persistentRecords.clear();
    for (const value of records) {
      const record = workspaceHookTrustRecordSchema.parse(value);
      this.persistentRecords.set(
        trustKey(record.workspaceIdentity, record.hookDeclarationDigest),
        record,
      );
      this.revokedKeys.delete(trustKey(record.workspaceIdentity, record.hookDeclarationDigest));
      previousWorkspaces.add(record.workspaceIdentity);
    }
    this.storeState = { ...state };
    if (state.status === "corrupt") {
      for (const workspaceIdentity of this.listKnownWorkspaceIdentities()) {
        previousWorkspaces.add(workspaceIdentity);
      }
    }
    for (const workspaceIdentity of previousWorkspaces) this.bumpRevision(workspaceIdentity);
  }

  revoke(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
  }): WorkspaceHookSecurityRevision {
    const digests = unique(input.hookDeclarationDigests);
    for (const digest of digests) {
      const key = trustKey(input.workspaceIdentity, digest);
      this.persistentRecords.delete(key);
      this.revokedKeys.add(key);
    }
    return this.bumpRevision(input.workspaceIdentity);
  }

  evaluateSnapshot(input: { snapshot: WorkspaceHookBundleSnapshot }): WorkspaceHookSnapshotEvaluation {
    const workspaceIdentity = input.snapshot.workspaceIdentity;
    this.ensureRevision(workspaceIdentity);
    const policyResult = this.resolvePolicy(workspaceIdentity);
    const items = input.snapshot.hooks.map((entry) =>
      evaluateWorkspaceHookEntry({
        entry,
        snapshot: input.snapshot,
        policy: policyResult.policy,
        persistentRecords: this.persistentRecords,
        revokedKeys: this.revokedKeys,
        storeStatus: this.storeState.status,
      }),
    );
    return {
      workspaceIdentity,
      bundleDigest: input.snapshot.bundleDigest,
      policy: policyResult.policy,
      securityRevision: this.getSecurityRevision(workspaceIdentity),
      storeStatus: this.storeState.status,
      ...(policyResult.reasonCode
        ? { reasonCode: policyResult.reasonCode }
        : this.storeState.status === "corrupt"
          ? { reasonCode: "workspace_hooks_trust_store_corrupt" as const }
          : {}),
      items,
    };
  }

  getSecurityRevision(workspaceIdentity: string): WorkspaceHookSecurityRevision {
    return {
      coordinatorEpoch: this.coordinatorEpoch,
      counter: this.ensureRevision(workspaceIdentity),
    };
  }

  validateSecurityRevision(
    workspaceIdentity: string,
    revision: WorkspaceHookSecurityRevision,
  ): boolean {
    return (
      revision.coordinatorEpoch === this.coordinatorEpoch &&
      revision.counter === this.ensureRevision(workspaceIdentity)
    );
  }

  private resolvePolicy(workspaceIdentity: string): {
    policy: WorkspaceHookPolicy;
    reasonCode?: WorkspaceHookReasonCode;
  } {
    try {
      return {
        policy: workspaceHookPolicySchema.parse(this.policyProvider.getPolicy(workspaceIdentity)),
      };
    } catch {
      return {
        policy: {
          mode: "deny",
          reason: "Workspace Hook policy provider unavailable",
          policyRevision: "provider-error:fail-closed",
        },
        reasonCode: "workspace_hooks_blocked_by_policy",
      };
    }
  }

  private bumpRevision(workspaceIdentity: string): WorkspaceHookSecurityRevision {
    const counter = this.ensureRevision(workspaceIdentity) + 1;
    this.revisions.set(workspaceIdentity, counter);
    return { coordinatorEpoch: this.coordinatorEpoch, counter };
  }

  private ensureRevision(workspaceIdentity: string): number {
    const current = this.revisions.get(workspaceIdentity);
    if (current !== undefined) return current;
    this.revisions.set(workspaceIdentity, 0);
    return 0;
  }

  private listKnownWorkspaceIdentities(): Set<string> {
    const result = new Set(this.revisions.keys());
    for (const record of this.persistentRecords.values()) result.add(record.workspaceIdentity);
    return result;
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
