import type { ReactNode } from "react";
import type { GitCommitReview, SessionExecutionMode } from "@lcode/shared";
import type { WorktreeIntegration } from "@lcode/services";
import type { GitCommitDialogState } from "./commitDialogModel.js";
import type { PublishOptionsPanelProps } from "./GitPublishOptionsPanel.js";
import type { PublishPlan } from "./publishModel.js";
import type { PublishRun } from "./publishExecution.js";

export interface GitCommitDialogProps {
  open: boolean;
  failureAction?: ReactNode;
  worktreeActions?: ReactNode;
  worktreeMergeActions?: ReactNode;
  mergeOperationId?: string;
  mergeOperationStatus?: WorktreeIntegration["status"];
  mergeTargetBranch?: string;
  mergeView?: { operationId: string; source: boolean } | null;
  onMergeViewChange?: (value: { operationId: string; source: boolean } | null) => void;
  syncBlocked?: boolean;
  syncStatus?: ReactNode;
  onOpenFiles: (readOnly?: boolean) => void;
  onOpenScopeFiles: () => void;
  canOpenFiles: boolean;
  executionMode?: SessionExecutionMode;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  previousMessage: string | null;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  requiresRegeneration: boolean;
  reviewError: string | null;
  review: GitCommitReview | null;
  reviewPosition: number;
  browsePosition: number;
  excludedFiles: string[];
  reviewAcknowledged: boolean;
  reviewCanSubmit: boolean;
  publish: Omit<
    PublishOptionsPanelProps,
    "canCommit" | "remainingGroups" | "disabled" | "branchName"
  >;
  plan: PublishPlan | null;
  run: PublishRun | null;
  onReviewAcknowledge: (value: boolean) => void;
  onBrowse: (position: number) => void;
  onManualFallback: () => void;
  onRefreshGit: () => void;
  onOpenChange: (open: boolean) => void;
  onMessageChange: (message: string) => void;
  onIncludeUnstagedChange: (value: boolean) => void;
  onGenerateMessage: () => void;
  onCopyMessage: () => void;
  onRestoreMessage: () => void;
  onSubmit: () => void;
  onVisible: () => void;
  onRetryLoad: () => void;
  onConfirmPublish: () => void;
  onCancelPreview: () => void;
  onRetryPublish: (id: string) => void;
  onResetPublish: () => void;
}
