import { useEffect, useMemo, useRef, useState } from "react";
import type { IDisposable } from "@lcode/rpc";
import type { GitRepositorySummary } from "@lcode/shared";
import {
  buildGitAutoRefreshWatchPaths,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";
import { logger } from "@/logger.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

// 原 60s 尾沿防抖被每次写入重置，连续任务永远无法刷新。短批合并并限制最大等待。
const GIT_AUTO_REFRESH_DEBOUNCE_MS = 400;
const GIT_AUTO_REFRESH_MAX_WAIT_MS = 2_000;

interface GitWatcherRegistration {
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export function useGitAutoRefresh({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  gitSummaryWorkspaceKey,
  enabled,
  onRefreshGit,
  livePanelVisible = false,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  gitSummary: GitRepositorySummary;
  gitSummaryWorkspaceKey: string;
  enabled: boolean;
  onRefreshGit: () => void;
  livePanelVisible?: boolean;
}) {
  const workspaceServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const { fileWatcherService, systemService } = workspaceServices;
  const refreshRef = useRef(onRefreshGit);
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const canWatchCurrentWorkspace = shouldEnableGitAutoRefreshForWorkspace({
    enabled,
    currentWorkspaceKey,
    summaryWorkspaceKey: gitSummaryWorkspaceKey,
  });
  const [workspacePlatformState, setWorkspacePlatformState] = useState<{
    service: typeof systemService;
    platform: string;
  } | null>(null);
  // workspaceScopedServices 在远程 workspace 下指向远端 Host，因此这里获取的是
  // WSL/SSH/Docker 的真实运行平台，而不是桌面应用本身的平台。service identity
  // 参与状态匹配，避免 Windows workspace 的旧 platform 泄漏到刚切换的 Linux workspace。
  const workspacePlatform =
    workspacePlatformState?.service === systemService ? workspacePlatformState.platform : null;
  useEffect(() => {
    if (!canWatchCurrentWorkspace || !gitSummary.isGitAvailable || !gitSummary.isRepository) {
      return;
    }

    let cancelled = false;
    void systemService
      .info()
      .then((info) => {
        if (!cancelled) {
          setWorkspacePlatformState({ service: systemService, platform: info.platform });
        }
      })
      .catch(() => {
        // 平台信息不可用时由路径构造器采用 metadata-only 保守策略；手动刷新链路不受影响。
      });

    return () => {
      cancelled = true;
    };
  }, [canWatchCurrentWorkspace, gitSummary.isGitAvailable, gitSummary.isRepository, systemService]);
  const watchPathSignature = useMemo(
    () =>
      stringifyGitAutoRefreshWatchPaths(
        canWatchCurrentWorkspace
          ? buildGitAutoRefreshWatchPaths(
              gitSummary,
              workspacePlatform ? { platform: workspacePlatform } : null,
            )
          : [],
      ),
    [
      canWatchCurrentWorkspace,
      gitSummary.isGitAvailable,
      gitSummary.isRepository,
      gitSummary.repoRoot,
      gitSummary.workspacePath,
      gitSummary.autoRefreshWatchPaths,
      workspacePlatform,
    ],
  );
  const watchPaths = useMemo(
    () => parseGitAutoRefreshWatchPaths(watchPathSignature),
    [watchPathSignature],
  );

  refreshRef.current = onRefreshGit;

  useEffect(() => {
    if (
      !canWatchCurrentWorkspace ||
      !livePanelVisible ||
      workspacePlatform !== "linux" ||
      !gitSummary.isRepository ||
      !gitSummary.isGitAvailable
    )
      return;
    // Linux 禁止大型目录递归 watcher，metadata 无法覆盖普通编辑；仅审查可见时补充有界轮询。
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshRef.current();
    }, 2_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshRef.current();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [
    canWatchCurrentWorkspace,
    currentWorkspaceKey,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    livePanelVisible,
    workspacePlatform,
  ]);

  useEffect(() => {
    let cancelled = false;
    const registrations: GitWatcherRegistration[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      if (maxWaitTimer !== null) clearTimeout(maxWaitTimer);
      debounceTimer = maxWaitTimer = null;
    };
    const flushRefresh = () => {
      clearTimers();
      if (!cancelled) refreshRef.current();
    };

    const scheduleRefresh = (path: string) => {
      if (cancelled) return;
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.debug("[GitAutoRefresh] Git 状态变更，刷新仓库状态", {
          workspacePath,
          path,
        });
        flushRefresh();
      }, GIT_AUTO_REFRESH_DEBOUNCE_MS);
      maxWaitTimer ??= setTimeout(flushRefresh, GIT_AUTO_REFRESH_MAX_WAIT_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") flushRefresh();
    };
    // 首次快照由仓库 hook 读取；注册 watcher 只观察，不反向触发刷新。
    // 原建立时 flush 与执行目录失效组合后会产生无文件事件的 watch/unwatch 循环。
    // 后台期间文件事件可能丢失，重新显示/聚焦仍走同一刷新路径。
    if (watchPaths.length > 0) {
      window.addEventListener("focus", onVisible);
      document.addEventListener("visibilitychange", onVisible);
    }

    // Git summary 每次刷新都会带回新的 autoRefreshWatchPaths 数组引用。
    // 监听路径内容没变时不能重建 watcher，否则 agent 批量写文件会出现 unwatch/watch 风暴。
    for (const watchPath of watchPaths) {
      void fileWatcherService
        .watch({
          path: watchPath.path,
          recursive: watchPath.recursive,
        })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            scheduleRefresh(event.dirPath);
          });
          registrations.push({
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          // Git 实时刷新只是加速 UI 状态同步；监听失败时保留原有手动刷新和操作后刷新链路。
          logger.warn("[GitAutoRefresh] 监听 Git 工作区失败", {
            workspacePath,
            path: watchPath.path,
            recursive: watchPath.recursive,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      clearTimers();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      for (const registration of registrations) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[GitAutoRefresh] 停止监听 Git 工作区失败", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [currentWorkspaceKey, fileWatcherService, watchPaths, workspacePath]);
}
