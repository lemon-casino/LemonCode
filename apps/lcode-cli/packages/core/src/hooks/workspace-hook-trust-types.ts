import type {
  WorkspaceHookEffectiveState,
  WorkspaceHookPolicy,
  WorkspaceHookReasonCode,
  WorkspaceHookSecurityRevision,
} from "@lcode/contracts";

export type WorkspaceHookTrustStoreStatus = "missing" | "ok" | "corrupt";

export interface WorkspaceHookTrustStoreState {
  status: WorkspaceHookTrustStoreStatus;
  recoveredCorruptPath?: string;
}

export interface WorkspaceHookSnapshotEvaluation {
  workspaceIdentity: string;
  bundleDigest: string;
  policy: WorkspaceHookPolicy;
  securityRevision: WorkspaceHookSecurityRevision;
  storeStatus: WorkspaceHookTrustStoreStatus;
  reasonCode?: WorkspaceHookReasonCode;
  items: WorkspaceHookEffectiveState[];
}
