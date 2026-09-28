import type { ILCodeTaskService } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

export function releaseWorkspaceRuntimeAfterProjectRemoval({
  tab,
  lcodeTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  lcodeTaskService: Pick<ILCodeTaskService, "releaseWorkspacePreparation">;
}): void {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  void lcodeTaskService
    .releaseWorkspacePreparation({
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .catch((error: unknown) => {
      // Windows 会把 Agent/终端子进程 cwd 视为目录占用；移除项目必须主动释放 runtime。
      // 释放失败不能回滚 UI 移除，只记录 workspace key 方便定位残留进程。
      logger.error("[WorkspaceSidebarItem] 移除 workspace 后释放 runtime 失败", {
        workspaceKey: workspaceIdentity ?? tab.workspacePath,
        error,
      });
    });
}
