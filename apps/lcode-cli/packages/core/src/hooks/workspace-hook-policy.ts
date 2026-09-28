import type { WorkspaceHookPolicy } from "@lcode/contracts";
import { workspaceHookPolicySchema } from "@lcode/contracts";

const DEFAULT_POLICY: WorkspaceHookPolicy = Object.freeze({
  mode: "user_decides",
  policyRevision: "builtin:user-decides:v1",
});

export interface WorkspaceHookPolicyChange {
  workspaceIdentity?: string;
  policy: WorkspaceHookPolicy;
}

export interface WorkspaceHookPolicyProvider {
  getPolicy(workspaceIdentity: string): WorkspaceHookPolicy;
  subscribe(listener: (change: WorkspaceHookPolicyChange) => void): () => void;
}

export class InMemoryWorkspaceHookPolicyProvider implements WorkspaceHookPolicyProvider {
  private defaultPolicy: WorkspaceHookPolicy;
  private readonly policies = new Map<string, WorkspaceHookPolicy>();
  private readonly listeners = new Set<(change: WorkspaceHookPolicyChange) => void>();

  constructor(defaultPolicy: WorkspaceHookPolicy = DEFAULT_POLICY) {
    this.defaultPolicy = workspaceHookPolicySchema.parse(defaultPolicy);
  }

  getPolicy(workspaceIdentity: string): WorkspaceHookPolicy {
    return this.policies.get(workspaceIdentity) ?? this.defaultPolicy;
  }

  subscribe(listener: (change: WorkspaceHookPolicyChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setWorkspacePolicy(workspaceIdentity: string, policy: WorkspaceHookPolicy): void {
    const next = workspaceHookPolicySchema.parse(policy);
    if (samePolicy(this.policies.get(workspaceIdentity), next)) return;
    this.policies.set(workspaceIdentity, next);
    this.emit({ workspaceIdentity, policy: next });
  }

  clearWorkspacePolicy(workspaceIdentity: string): void {
    if (!this.policies.delete(workspaceIdentity)) return;
    this.emit({ workspaceIdentity, policy: this.defaultPolicy });
  }

  setDefaultPolicy(policy: WorkspaceHookPolicy): void {
    const next = workspaceHookPolicySchema.parse(policy);
    if (samePolicy(this.defaultPolicy, next)) return;
    this.defaultPolicy = next;
    this.emit({ policy: next });
  }

  private emit(change: WorkspaceHookPolicyChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

function samePolicy(current: WorkspaceHookPolicy | undefined, next: WorkspaceHookPolicy): boolean {
  return current !== undefined && JSON.stringify(current) === JSON.stringify(next);
}
