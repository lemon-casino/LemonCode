export interface CommitMessageDraft {
  message: string;
  previousMessage: string | null;
  edited: boolean;
  requiresRegeneration: boolean;
}

export function commitDraftScopeKey(
  workspacePath: string,
  workspaceIdentity?: string,
  dialogScopeKey?: string,
): string {
  return JSON.stringify([workspaceIdentity?.trim() || workspacePath, dialogScopeKey ?? ""]);
}

export function commitSubjectLength(message: string): number {
  return Array.from(message.replace(/\r\n/g, "\n").split(/\n[\t ]*\n/, 1)[0] ?? "").length;
}

export function insertConventionalType(message: string, type: string): string {
  return /^[a-z]+(?:\([^\r\n)]*\))?!?:/.test(message)
    ? message.replace(/^[a-z]+/, type)
    : `${type}: ${message}`;
}

export function filterExcludedCommitFiles<
  T extends { stagePath: string; repoRelativePath: string },
>(files: readonly T[], excluded: readonly string[]): T[] {
  // 排除集与正向 session scope 分开：全排除必须保留空数组，绝不能回退到全仓。
  const paths = new Set(excluded);
  return files.filter((file) => !paths.has(file.repoRelativePath) && !paths.has(file.stagePath));
}
