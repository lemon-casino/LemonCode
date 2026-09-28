import { useCallback, useRef, useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import type { LCodeProvider } from "@lcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildWorkspaceSessionReloadDraftError,
  shouldDebounceWorkspaceSessionReload,
} from "@/lib/workspaceSessionReloadPlan.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { prepareWorkspaceWithLCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { logger } from "@/logger.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function useWorkspaceSessionReload({
  intl,
  services,
  workspaceAbsPath,
  reloadSessionDisabled,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  services: IServiceAccessor;
  workspaceAbsPath: string;
  reloadSessionDisabled: boolean;
}) {
  const [reloadSessionPending, setReloadSessionPending] = useState(false);
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspaceAbsPath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const lastReloadSessionTriggeredAtRef = useRef<number | null>(null);

  const handleReloadSession = useCallback(
    async (options?: { resumeTaskId?: string | null; provider?: LCodeProvider | null }) => {
      if (reloadSessionDisabled || reloadSessionPending) {
        return;
      }

      const now = Date.now();
      if (shouldDebounceWorkspaceSessionReload(lastReloadSessionTriggeredAtRef.current, now)) {
        // Header 与错误条都可触发 reload，会出现短时间双击/连点并发重建。
        // 这里在入口做时间窗防抖，避免并发调用 restartWorkspaceProcess 抢占同一 provider-workspace。
        logger.info(`[App] 忽略重复 workspace session 重建请求 workspace=${workspaceAbsPath}`);
        return;
      }
      lastReloadSessionTriggeredAtRef.current = now;
      setReloadSessionPending(true);

      const lcodeSessionStore = useLCodeSessionStore.getState();
      const latestWorkspaceState = lcodeSessionStore.getWorkspaceState(
        workspaceAbsPath,
        workspaceIdentity,
      );
      const actionScope = resolveWorkspaceModelConfigSyncScope(latestWorkspaceState);
      const provider: LCodeProvider = options?.provider ?? actionScope.provider;
      const resumeTaskId =
        options?.resumeTaskId?.trim() || latestWorkspaceState.activeTaskId || undefined;
      const shouldPrepareWorkspace = !resumeTaskId;

      // Reload session 之前只调用了服务层重建流程，没有同步 workspaceInit 状态到 UI store。
      // 草稿态下后续准备流程会继续读到旧状态，用户会误判本次重建没有生效。
      // 这里显式写入 initializing/ready/failed，保证重建状态和会话流程保持一致。
      lcodeSessionStore.setWorkspaceInitState(
        workspaceAbsPath,
        "initializing",
        null,
        workspaceIdentity,
      );
      if (shouldPrepareWorkspace) {
        lcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "loading", workspaceIdentity);
        // 草稿态点击 reload 后若不清空旧错误，输入区会继续显示上一轮失败提示，
        // 用户会误判本次重建仍失败。这里在新一轮重建开始时先清空草稿错误。
        lcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
        lcodeSessionStore.setTaskState(workspaceAbsPath, "idle", null, workspaceIdentity);
      }

      try {
        await services.lcodeTaskService.restartWorkspaceProcess({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
          resumeTaskId,
        });

        if (shouldPrepareWorkspace) {
          const prepareResult = await prepareWorkspaceWithLCodeSessionService({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            provider,
            lcodeSessionService: services.lcodeSessionService,
          });

          const latestAfterPrepare = lcodeSessionStore.getWorkspaceState(
            workspaceAbsPath,
            workspaceIdentity,
          );
          if (latestAfterPrepare.selectedProvider === provider) {
            const latestAfterResolve = lcodeSessionStore.getWorkspaceState(
              workspaceAbsPath,
              workspaceIdentity,
            );
            if (latestAfterResolve.selectedProvider === provider) {
              lcodeSessionStore.setConfigOptions(
                workspaceAbsPath,
                prepareResult.configOptions ?? [],
                workspaceIdentity,
              );
              lcodeSessionStore.setConfigOptionsStatus(
                workspaceAbsPath,
                "ready",
                workspaceIdentity,
              );
              lcodeSessionStore.setSlashCommands(
                workspaceAbsPath,
                prepareResult.slashCommands ?? [],
                workspaceIdentity,
              );
              lcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
            }
          }
        }

        lcodeSessionStore.setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
        lcodeSessionStore.setWorkspaceInitState(workspaceAbsPath, "ready", null, workspaceIdentity);

        logger.info(
          `[App] workspace session 重建完成 workspace=${workspaceAbsPath} provider=${provider} resumeTaskId=${resumeTaskId ?? "<none>"}`,
        );
        toast(intl.formatMessage({ id: "appHeader.reloadSessionSuccess" }));
      } catch (error) {
        const reloadDraftError = buildWorkspaceSessionReloadDraftError(error, {
          workspacePath: workspaceAbsPath,
          provider,
        });
        const message = reloadDraftError.message;
        logger.warn(
          `[App] workspace session 重建失败 workspace=${workspaceAbsPath} provider=${provider}`,
          {
            resumeTaskId: resumeTaskId ?? null,
            message,
          },
        );
        lcodeSessionStore.setWorkspaceInitState(
          workspaceAbsPath,
          "failed",
          message,
          workspaceIdentity,
        );
        if (shouldPrepareWorkspace) {
          lcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "error", workspaceIdentity);
          // 草稿态下 reload 前会先清空旧错误；如果失败后不回填 draftError，
          // 聊天区只剩 toast，用户看不到可重试的详细报错。这里统一回填标准化错误到输入区。
          lcodeSessionStore.setDraftError(workspaceAbsPath, reloadDraftError, workspaceIdentity);
        }
        toast(intl.formatMessage({ id: "appHeader.reloadSessionFailed" }));
      } finally {
        setReloadSessionPending(false);
      }
    },
    [
      intl,
      reloadSessionDisabled,
      reloadSessionPending,
      services.lcodeTaskService,
      services.lcodeSessionService,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  return {
    reloadSessionPending,
    handleReloadSession,
  };
}
