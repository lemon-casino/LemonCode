/* eslint-disable max-lines */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranchComparison,
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@lcode/shared";
import { createGitRefreshScheduler } from "@/hooks/gitRefreshScheduler.js";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";

type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;

interface RepositoryDatasets {
  unstaged: GitPaneDataset;
  staged: GitPaneDataset;
  branch: GitPaneDataset;
}

const EMPTY_BRANCH_COMPARISON: GitBranchComparison = {
  baseRef: null,
  headRef: null,
  comparisonLabel: null,
  changes: [],
};

interface GitLiveDataRefreshInput {
  workspacePath: string;
  workspaceKey: string;
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
}

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

export interface GitPaneDataset {
  id: GitChangeSourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  error?: string | null;
  turnIndex?: number | null;
  loading?: boolean;
  isSelectedTurn?: boolean;
}

export interface GitPaneSourceOption {
  id: GitChangeSourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitChangeSourceId, GitPaneDataset>;
}

const SECTION_ORDER_BY_SOURCE: Record<GitRepositorySourceId, readonly GitChangeSectionId[]> = {
  unstaged: ["unstaged", "untracked", "conflicted"],
  staged: ["staged"],
  branch: ["branch"],
};

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function sumSectionCount(sections: readonly GitPaneSection[]): number {
  return sections.reduce((count, section) => count + section.changes.length, 0);
}

function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(id: GitChangeSourceId, readonly: boolean): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitChangeSourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
    "last-turn": createEmptyDataset("last-turn", true),
  };
}

function buildSourceOptions(
  datasets: Record<GitChangeSourceId, GitPaneDataset>,
): GitPaneSourceOption[] {
  return [
    {
      id: "unstaged",
      count: sumSectionCount(datasets.unstaged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "staged",
      count: sumSectionCount(datasets.staged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "branch",
      count: sumSectionCount(datasets.branch.sections),
      readonly: true,
      disabled: false,
      comparisonLabel: datasets.branch.comparisonLabel,
    },
    {
      id: "last-turn",
      count: sumSectionCount(datasets["last-turn"].sections),
      readonly: true,
      disabled: false,
    },
  ];
}

function createInitialState(
  workspacePath: string,
  options?: {
    workspaceKey?: string;
    loading?: boolean;
    error?: string | null;
    revision?: number;
  },
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey: options?.workspaceKey ?? workspacePath,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: options?.loading ?? true,
    error: options?.error ?? null,
    revision: options?.revision ?? 0,
    sourceOptions: buildSourceOptions(datasets),
    datasets,
  };
}

function toPaneFileChange(
  change: GitFileChange,
  diff: GitDiffResult | null = null,
): GitPaneFileChange {
  return {
    ...change,
    diff,
  };
}

function buildSectionsForSource(
  sourceId: GitRepositorySourceId,
  changes: GitFileChange[],
): GitPaneSection[] {
  const grouped = new Map<GitChangeSectionId, GitPaneFileChange[]>();
  for (const change of changes) {
    const sectionChanges = grouped.get(change.section) ?? [];
    sectionChanges.push(toPaneFileChange(change));
    grouped.set(change.section, sectionChanges);
  }

  return SECTION_ORDER_BY_SOURCE[sourceId]
    .map((sectionId) => {
      const sectionChanges = grouped.get(sectionId);
      if (!sectionChanges || sectionChanges.length === 0) {
        return null;
      }

      sectionChanges.sort((left, right) =>
        left.workspaceRelativePath.localeCompare(right.workspaceRelativePath),
      );

      return {
        id: sectionId,
        changes: sectionChanges,
      };
    })
    .filter((section): section is GitPaneSection => Boolean(section));
}

function buildRepositoryDatasets(options: {
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison;
  branchComparisonError?: string;
}): RepositoryDatasets {
  return {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: buildSectionsForSource("unstaged", options.unstagedChanges),
    },
    staged: {
      id: "staged",
      readonly: false,
      sections: buildSectionsForSource("staged", options.stagedChanges),
    },
    branch: {
      id: "branch",
      readonly: true,
      sections: buildSectionsForSource("branch", options.branchComparison.changes),
      comparisonLabel: options.branchComparison.comparisonLabel,
      error: options.branchComparisonError ?? null,
    },
  };
}

function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) {
    return false;
  }

  if (!previous || !previous.workspaceRpcEnabled) {
    return true;
  }

  if (previous.workspacePath !== next.workspacePath) {
    return true;
  }

  if (previous.workspaceKey !== next.workspaceKey) {
    return true;
  }

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // 关键业务逻辑：Git pane 关闭时不应该因为“少拿 branch/identity”反向触发一轮真实 Git。
  // 只有从关闭 -> 打开时，才补拉扩展数据；task/last-turn 的切换则只走本地数据重组。
  return !previous.includeExtendedData && next.includeExtendedData;
}

export function useGitRepository(options: {
  enabled?: boolean;
  workspacePath: string;
  activeTaskId: string | null;
  lastTurnDataset?: GitPaneDataset;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled =
    options.enabled !== false &&
    Boolean(workspacePath) &&
    shouldEnableWorkspaceRpc({
      workspaceIdentity,
      remoteSessionId,
      remoteTarget,
    });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const [repositoryState, setRepositoryState] = useState<GitPaneRepositoryState>(() =>
    createInitialState(workspacePath, { workspaceKey }),
  );
  const revisionRef = useRef(0);
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);
  const schedulerRef = useRef<ReturnType<typeof createGitRefreshScheduler> | null>(null);

  useEffect(() => {
    lastLiveRefreshInputRef.current = null;
    if (!workspaceRpcEnabled) {
      setRepositoryState(createInitialState(workspacePath, { workspaceKey, loading: false }));
      return;
    }
    const scheduler = createGitRefreshScheduler({
      // 单次 RPC 同时提供 summary/staged/unstaged，避免一轮三次 git status。
      read: (extended: boolean) =>
        gitService.refresh({
          workspacePath,
          includeIdentity: extended,
          includeBranchComparison: extended,
        }),
      onStart: () =>
        setRepositoryState((current) =>
          current.workspaceKey === workspaceKey && current.summary.workspacePath === workspacePath
            ? { ...current, loading: true, error: null }
            : createInitialState(workspacePath, { workspaceKey }),
        ),
      onResult: ({
        summary,
        identity,
        unstagedChanges,
        stagedChanges,
        branchComparison,
        branchComparisonError,
      }) => {
        const datasets = {
          ...buildRepositoryDatasets({
            unstagedChanges,
            stagedChanges,
            branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
            branchComparisonError,
          }),
          "last-turn": createEmptyDataset("last-turn", true),
        };
        setRepositoryState({
          workspaceKey,
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: { enabled: false },
          loading: false,
          error: null,
          revision: ++revisionRef.current,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      },
      onError: (error: unknown) => {
        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", { workspacePath, error: message });
        setRepositoryState(
          createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: ++revisionRef.current,
          }),
        );
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      // owner 切换才废弃请求；刷新 token 的变化仅合并后续读取，避免慢请求一直无法落地。
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
      lastLiveRefreshInputRef.current = null;
    };
  }, [gitService, workspaceKey, workspacePath, workspaceRpcEnabled]);

  useEffect(() => {
    const next: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };
    if (shouldRefreshLiveGitData(lastLiveRefreshInputRef.current, next)) {
      schedulerRef.current?.request(includeExtendedData);
    }
    lastLiveRefreshInputRef.current = next;
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  return useMemo(() => {
    // useEffect 在 workspace 切换后的 commit 才会清理旧状态。render 阶段先按
    // workspaceKey 投影为空状态，避免旧机器的 Git 路径通过新远端 fileWatcherService 注册。
    const currentRepositoryState =
      repositoryState.workspaceKey === workspaceKey &&
      repositoryState.summary.workspacePath === workspacePath
        ? repositoryState
        : createInitialState(workspacePath, { workspaceKey });
    const datasets = {
      ...currentRepositoryState.datasets,
    };
    // 历史来源由 V4 只读查询提供，不能从当前 Git 状态或已废弃的 task map 推导。
    datasets["last-turn"] = options.lastTurnDataset ?? createEmptyDataset("last-turn", true);

    return {
      ...currentRepositoryState,
      sourceOptions: buildSourceOptions(datasets),
      datasets,
    };
  }, [options.lastTurnDataset, repositoryState, workspaceKey, workspacePath]);
}
