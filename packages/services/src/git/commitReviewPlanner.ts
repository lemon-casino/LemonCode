import type { GitFileMutation, GitFileMutationJournal } from "@lcode/shared";

export interface CommitReviewContent {
  path: string;
  mode: string;
  headMode?: string | null;
  headContent: string | null;
  content: string | null;
}
export interface PlannedCommitGroup {
  id: string;
  sessionIds: string[];
  label: string;
  dependsOn: string[];
  files: CommitReviewContent[];
  requiresConfirmation: boolean;
}
export interface SessionCommitPlan {
  mode: "split" | "ordered" | "merged";
  warnings: string[];
  groups: PlannedCommitGroup[];
}

export function mergedSessionCommitPlan(
  files: readonly CommitReviewContent[],
  warning: string,
): SessionCommitPlan {
  return {
    mode: "merged",
    warnings: [warning],
    groups: [
      {
        id: "merged",
        sessionIds: [],
        label: "",
        dependsOn: [],
        files: [...files],
        requiresConfirmation: true,
      },
    ],
  };
}

export function planSessionCommits(
  files: readonly CommitReviewContent[],
  journal: GitFileMutationJournal,
): SessionCommitPlan {
  if (!journal.complete) return mergedSessionCommitPlan(files, "incomplete-journal");
  const chains = new Map<string, GitFileMutation[]>();
  const sessions = new Map<string, string>();
  const dependencies = new Map<string, Set<string>>();
  const ids = new Map<string, string>();
  for (const mutation of journal.mutations) {
    const value = JSON.stringify(mutation);
    if (ids.has(mutation.id) && ids.get(mutation.id) !== value)
      return mergedSessionCommitPlan(files, "ambiguous-version-chain");
    ids.set(mutation.id, value);
  }
  for (const file of files) {
    const byId = new Map(
      journal.mutations
        .filter(
          (mutation) =>
            mutation.path === file.path && mutation.beforeContent !== mutation.afterContent,
        )
        .map((mutation) => [mutation.id, mutation]),
    );
    const mutations = [...byId.values()];
    const chain: GitFileMutation[] = [];
    let content = file.headContent;
    const used = new Set<string>();
    // 中文依据：before/after 是版本锚，不是行号或时间戳；分叉或缺链时不能猜测作者。
    while (content !== file.content) {
      const next = mutations.filter(
        (mutation) => mutation.beforeContent === content && !used.has(mutation.id),
      );
      if (next.length !== 1) return mergedSessionCommitPlan(files, "ambiguous-version-chain");
      const mutation = next[0]!;
      if (mutation.toolName !== "Edit" && mutation.toolName !== "Write")
        return mergedSessionCommitPlan(files, "unattributed-write");
      used.add(mutation.id);
      chain.push(mutation);
      content = mutation.afterContent;
      sessions.set(mutation.sessionId, mutation.sessionTitle ?? mutation.sessionId);
      const deps = dependencies.get(mutation.sessionId) ?? new Set<string>();
      const prior = chain.at(-2)?.sessionId;
      if (prior && prior !== mutation.sessionId) deps.add(prior);
      dependencies.set(mutation.sessionId, deps);
    }
    chains.set(file.path, chain);
  }
  const ordered: string[] = [];
  const remaining = new Set(sessions.keys());
  while (remaining.size > 0) {
    const next = [...remaining]
      .sort()
      .find((session) =>
        [...(dependencies.get(session) ?? [])].every((dependency) => ordered.includes(dependency)),
      );
    if (!next) return mergedSessionCommitPlan(files, "dependency-cycle");
    ordered.push(next);
    remaining.delete(next);
  }
  const contents = new Map(files.map((file) => [file.path, file.headContent]));
  const groups: PlannedCommitGroup[] = [];
  for (const session of ordered) {
    const changes: CommitReviewContent[] = [];
    for (const file of files) {
      const before = contents.get(file.path) ?? null;
      let after = before;
      for (const mutation of chains.get(file.path) ?? []) {
        if (mutation.sessionId !== session) continue;
        if (mutation.beforeContent !== after)
          return mergedSessionCommitPlan(files, "ambiguous-version-chain");
        after = mutation.afterContent;
      }
      // A 新建后 B 修改时，B 的前置文件已经存在；预览模式也必须锚定中间版本。
      if (before !== after)
        changes.push({
          ...file,
          headMode: before === null ? null : file.mode,
          headContent: before,
          content: after,
        });
      contents.set(file.path, after);
    }
    if (changes.length > 0)
      groups.push({
        id: session,
        sessionIds: [session],
        label: sessions.get(session) ?? session,
        dependsOn: [...(dependencies.get(session) ?? [])],
        files: changes,
        requiresConfirmation: false,
      });
  }
  if (groups.length === 0 || groups.length > 20)
    return mergedSessionCommitPlan(files, "incomplete-journal");
  return {
    mode: groups.some((group) => group.dependsOn.length > 0) ? "ordered" : "split",
    warnings: [],
    groups,
  };
}
