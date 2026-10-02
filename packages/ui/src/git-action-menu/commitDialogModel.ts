import type { GitIdentity, GitRepositorySummary, LCodeTaskChangeSummary } from "@lcode/shared";
import type { GitBranchCommitPreviewFile } from "../git-branch-switcher/display.js";
import { filterExcludedCommitFiles } from "./commitDraft.js";

export interface GitCommitDialogState {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  activeTaskChangeSummary: LCodeTaskChangeSummary | null;
  currentSessionFilePaths?: string[];
  stagedFiles: GitBranchCommitPreviewFile[];
  unstagedFiles: GitBranchCommitPreviewFile[];
}

export function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
  excluded: readonly string[] = [],
): GitBranchCommitPreviewFile[] {
  return filterExcludedCommitFiles(
    includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles,
    excluded,
  );
}

export function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
  excluded: readonly string[] = [],
): string[] {
  return [
    ...new Set(
      getCommitDialogFiles(state, includeUnstaged, excluded).map((file) => file.stagePath),
    ),
  ];
}
