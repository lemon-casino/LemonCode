import { ProjectRemoteSyncGroup } from "@/WorkspaceSidebar/ProjectRemoteSyncGroup.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { findProjectDefinition } from "@lcode/shared";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { SidebarPlacementItems } from "@/WorkspaceSidebar/SidebarPlacementItems.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import { SidebarSourceReadError } from "@/WorkspaceSidebar/SidebarSourceReadError.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
/* eslint-disable max-lines -- workspace 行同时承载折叠、远端状态和快捷操作，先保持同文件收口。 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import {
  CheckIcon,
  CircleAlert,
  Cloud,
  CopyIcon,
  Ellipsis,
  Folder,
  FolderOpen,
  GitBranchIcon,
  House,
  ListTree,
  LoaderCircle,
  RefreshCwIcon,
  MessageCirclePlus,
  XIcon,
} from "lucide-react";
import type { useSortable } from "@dnd-kit/sortable";
import { BorderBeam } from "border-beam";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import { Button, buttonVariants } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildWorkspaceSessionKey,
  formatRemoteWorkspaceDisplayLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { TaskList } from "@/TaskList.js";
import { selectWorkspaceLCodeState, useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { ReconnectingRemoteWorkspaceLogTooltip } from "@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_FILE_TREE_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@lcode/shared";
import type { LCodeTaskMeta } from "@lcode/shared";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import {
  applyTaskQueryCacheMutation,
  invalidateTaskQueryCacheByScopes,
} from "@/store/taskQueryCacheStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { logger } from "@/logger.js";
import { RemoteSyncDialogs, shouldShowRemoteSyncActions } from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/lcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import {
  hasRunningWorkspaceChat,
  scanWindowsReservedDeviceNameFiles,
} from "@/lib/workspaceRemovalSafety.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOpenWorktreeSettings } from "@/hooks/useOpenWorktreeSettings.js";

export type SortableBindings = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

// workspace 行在流式工具事件期间会因父级刷新而重渲染；
// TaskList 如果每次收到新的空数组，会把等价数据误判成变化并连带刷新任务行。
const EMPTY_PINNED_TASKS: LCodeTaskMeta[] = [];

function isHomeWorkspacePath(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath);
}

type SshRemoteTarget = Extract<NonNullable<WorkspaceTabState["remoteTarget"]>, { kind: "ssh" }>;

interface SshWorkspaceTooltipDetails {
  alias: string | null;
  hostLabel: string;
  workspacePath: string;
}

function formatSshRemoteHostLabel(target: SshRemoteTarget): string {
  const username = target.username.trim();
  const host = target.host.trim();
  const port = target.port ?? 22;
  return `${username}@${host}:${port}`;
}

function getSshWorkspaceTooltipDetails(tab: WorkspaceTabState): SshWorkspaceTooltipDetails | null {
  if (tab.remoteTarget?.kind !== "ssh") {
    return null;
  }

  return {
    alias: tab.remoteTarget.sshConfigAlias?.trim() || null,
    hostLabel: formatSshRemoteHostLabel(tab.remoteTarget),
    workspacePath: tab.workspacePath,
  };
}

export const WorkspaceSidebarItem = memo(function WorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  closeTab,
  onRemoveLocalProject,
  onRemoveRemoteProject,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  onStartCollaboration,
  taskItems,
  showTaskList = true,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  onShowMoreTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
  onOpenWorktrees,
  preserveOrigin = false,
  removalBlockedReason,
  sourceReadError,
  sourceRefreshing,
  onRefreshSource,
  groupByDate = false,
  taskSortBy = "updated",
  itemRef,
  itemStyle,
  sortableBindings,
  isDragging = false,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  onRemoveLocalProject?: (
    request: import("@lcode/shared").LocalProjectRemoveRequest,
  ) => Promise<void>;
  onRemoveRemoteProject?: (workspaceKey: string) => Promise<void>;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onStartCollaboration?: () => void;
  taskItems: LCodeTaskMeta[];
  showTaskList?: boolean;
  taskListLoading: boolean;
  onOpenWorktrees?: () => void;
  preserveOrigin?: boolean;
  removalBlockedReason?: string;
  sourceReadError?: string;
  sourceRefreshing?: boolean;
  onRefreshSource?: () => void;
  groupByDate?: boolean;
  taskSortBy?: "created" | "updated";
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  /** 组内在跑的工作流 run 数；项目收起时在未读点旁画脉冲灯（>1 带数量）。 */
  taskListLiveWorkflowCount?: number;
  onShowMoreTasks: () => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (
    workspaceKey: string,
    options?: { cancelPending?: boolean },
  ) => Promise<void>;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
  itemRef?: (node: HTMLLIElement | null) => void;
  itemStyle?: CSSProperties;
  sortableBindings?: SortableBindings;
  isDragging?: boolean;
}) {
  const { intl } = useLCodeIntl();
  const workspaceLCodeState = useLCodeSessionStore((state) =>
    selectWorkspaceLCodeState(state, tab.workspacePath, tab.workspaceIdentity),
  );
  const activeTaskId = workspaceLCodeState.activeTaskId;
  const removeTaskState = useLCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useLCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useLCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useLCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const resolution = useWorkspaceServicesResolution(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.remoteTarget,
  );
  const services = resolution.services;
  const confirmDialog = useConfirmDialog();
  const sidebarText = useSidebarText();
  const organization = useSidebarOrganization();
  const { copyAbsolutePath } = useFileContextActions();
  const [projectContextOpen, setProjectContextOpen] = useState(false);
  const baseServices = useBaseWorkspaceServices();
  const { settings: projectSettings } = useSettings(baseServices);
  const projectDefinition = findProjectDefinition(
    projectSettings?.projectDefinitions?.projects ?? projectSettings?.localProjects ?? [],
    tab.workspacePath,
    tab.workspaceIdentity,
    tab.localProjectId,
  );
  const lcodeTaskService = services.lcodeTaskService;
  const taskItemsRef = useRef(taskItems);
  taskItemsRef.current = taskItems;
  const workspaceLCodeStateRef = useRef(workspaceLCodeState);
  workspaceLCodeStateRef.current = workspaceLCodeState;
  const findCurrentTaskItem = useCallback((taskId: string) => {
    // 流式刷新会重建 taskItems 数组，任务操作回调如果直接依赖数组，
    // 即使任务语义没变也会换引用，继续击穿 TaskListItem 的 memo。
    // 用 ref 在调用时读取最新列表，既保持回调稳定，也避免乐观更新拿到过期 meta。
    return taskItemsRef.current.find((task) => task.taskId === taskId) ?? null;
  }, []);
  const isHomeWorkspace = isHomeWorkspacePath(tab.workspacePath);
  const readOnlyReason =
    tab.availability === "unavailable-local-directory"
      ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
      : undefined;
  const remoteWorkspaceKey = buildWorkspaceSessionKey(tab);
  const isRemoteWorkspace = Boolean(
    tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity,
  );
  // tab 保留恢复用 sessionId，不代表连接注册表仍有该 attachment；断连门禁必须读取当前 resolver。
  const isDisconnectedRemoteWorkspace = Boolean(isRemoteWorkspace && !resolution.rpcReady);
  const isReconnectPending = Boolean(
    isDisconnectedRemoteWorkspace && reconnectingRemoteWorkspaceKeys.includes(remoteWorkspaceKey),
  );
  const remoteWorkspaceError = remoteWorkspaceErrorByWorkspaceKey[remoteWorkspaceKey];
  const workspaceSidebarLabel = formatRemoteWorkspaceDisplayLabel(tab.label, tab.remoteTarget);
  const sshWorkspaceTooltipDetails = getSshWorkspaceTooltipDetails(tab);
  const reconnectRuntimeLogs =
    reconnectingRemoteWorkspaceLogsByWorkspaceKey[remoteWorkspaceKey] ?? [];
  const showRemoteConnectionErrorNotice = Boolean(
    // 远程项目只要处于“断连”就显示叹号，会把“尚未连接/已断开但无错误”和“真实连接失败”混在一起，
    // 用户看到列表里的 warning 图标时无法判断是否真有故障。
    // 这里收敛成只有存在连接错误正文时才显示叹号，普通未连接状态仅保留重连入口。
    isDisconnectedRemoteWorkspace && !isReconnectPending && remoteWorkspaceError?.trim(),
  );
  const showReconnectAction = Boolean(isDisconnectedRemoteWorkspace);
  const showFileTreeAction = Boolean(onOpenFileTree && !isDisconnectedRemoteWorkspace);
  const remoteSyncEligible = shouldShowRemoteSyncActions({
    remoteSessionId: tab.remoteSessionId,
    remoteTarget: tab.remoteTarget,
    clientMode:
      organization && !organization.isDesktop
        ? ("web-remote-replayable" as const)
        : ("desktop-continuous" as const),
    hasLocalSourceService: Boolean(baseServices.skillSyncService),
  });
  const showRemoteSkillSyncAction = remoteSyncEligible && resolution.rpcReady;
  // 远端工作区在“重连中”时，之前只有轻微背景呼吸效果，
  // 在侧边栏高密度列表里不够醒目，用户很难快速判断哪个容器仍在连接。
  // 这里复用 BorderBeam，只在重连进行中激活，让连接态反馈更清晰，
  // 同时避免在普通空闲态或断连态误显示为“仍在运行”。
  const shouldShowRemoteConnectingBorderBeam = isReconnectPending;
  const [isRemoteErrorCopied, setIsRemoteErrorCopied] = useState(false);
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const openWorktreeSettings = useOpenWorktreeSettings();
  const showProjectWorktrees =
    tab.workspacePurpose !== "conversation" &&
    Boolean(services.worktreeService) &&
    !isDisconnectedRemoteWorkspace;
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  useEffect(() => {
    if (!resolution.rpcReady) {
      setRemoteSkillSyncOpen(false);
      setRemoteMcpSyncOpen(false);
      setRemotePluginSyncOpen(false);
    }
  }, [resolution.rpcReady]);
  const [workspaceRowHovered, setWorkspaceRowHovered] = useState(false);
  const [workspaceRowFocusWithin, setWorkspaceRowFocusWithin] = useState(false);
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const shouldMountWorkspaceRowActions =
    // workspace action 以前常驻 DOM，仅靠 opacity 隐藏；相邻 tooltip 会在
    // 浮层定位完成前误认隐藏 trigger，短暂显示到错误位置。改为交互时挂载，菜单打开时保活。
    // 读取错误行需要稳定的操作区宽度，防止错误入口在按下与抬起之间因聚焦挂载按钮而移位。
    Boolean(sourceReadError) ||
    workspaceRowHovered ||
    workspaceRowFocusWithin ||
    workspaceActionMenuOpen ||
    projectContextOpen ||
    isHoverNone;
  const remoteErrorCopyResetRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
    };
  }, []);

  const handleWorkspaceOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isDisconnectedRemoteWorkspace) {
        return;
      }

      // 展开只改变导航偏好；原实现会创建草稿并切换当前会话，右键整理后尤其容易误导航。
      if (nextOpen !== isExpanded) toggleWorkspaceExpanded(tab.workspacePath);
    },
    [
      isDisconnectedRemoteWorkspace,
      isExpanded,
      onStartDraftInWorkspace,
      tab.workspaceIdentity,
      tab.workspacePath,
      toggleWorkspaceExpanded,
    ],
  );

  const handleSelectTask = useCallback(
    (taskId: string) => {
      // 性能优化：上层 handleSelectTask 已经会按 workspacePath 激活 tab。
      // 这里重复 activate 会额外触发一轮 tab store 更新，把整列 workspace 行都带着重渲染一次。
      onSelectTask(tab.workspacePath, taskId, tab.workspaceIdentity);
    },
    [onSelectTask, tab.workspaceIdentity, tab.workspacePath],
  );

  const handleActionMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleActionMenuClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // DropdownMenuContent 虽然通过 Portal 渲染到行外，React 合成 click 仍会沿组件树
    // 冒泡到外层 CollapsibleTrigger。收起的 workspace 点“移除”时，会先 closeTab，再被展开回调
    // 当成“打开 workspace”重新 addTab，表现为删不掉。菜单层统一截断 click，保留菜单选择与键盘语义。
    event.stopPropagation();
  }, []);

  const handleCreateThreadClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
    },
    [onStartDraftInWorkspace, readOnlyReason, tab.workspaceIdentity, tab.workspacePath],
  );

  const handleRemoveWorkspace = useCallback(async () => {
    if (preserveOrigin) {
      toast(removalBlockedReason ?? sidebarText("activeBinding"), { variant: "warning" });
      return;
    }
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    logger.debug("[WorkspaceSidebarItem] 移除 workspace", {
      isExpanded,
      workspaceKey,
    });

    if (
      hasRunningWorkspaceChat({
        workspaceState: workspaceLCodeStateRef.current,
        taskItems: taskItemsRef.current,
      })
    ) {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.title" }),
        description: intl.formatMessage({
          id: "workspaceSidebar.removeRunningWorkspace.description",
        }),
        confirmLabel: intl.formatMessage({ id: "workspaceSidebar.removeRunningWorkspace.confirm" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) {
        logger.debug("[WorkspaceSidebarItem] 用户取消移除运行中 workspace", { workspaceKey });
        return;
      }
    }

    if (!isRemoteWorkspace && onRemoveLocalProject) {
      try {
        // 多文件夹项目的 tab 和项目定义是两份状态。旧版/迁移 tab 可能没有
        // localProjectId，因此删除必须同时传 workspacePath 作为兼容识别键。
        // 否则左侧虽然消失，选择器和创建冲突校验仍会读到残留定义。
        await onRemoveLocalProject({
          ...(tab.localProjectId ? { projectId: tab.localProjectId } : {}),
          workspacePath: tab.workspacePath,
        });
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] 删除本地项目定义失败", {
          error,
          localProjectId: tab.localProjectId,
          workspaceKey,
        });
        toast(intl.formatMessage({ id: "workspaceSidebar.removeProjectFailed" }), {
          variant: "warning",
        });
        return;
      }
    }

    if (isRemoteWorkspace && onRemoveRemoteProject) {
      try {
        // 历史投影行可能没有真实 tab；显式移除必须先提交 owner，不能依赖 closeTab observer。
        await onRemoveRemoteProject(workspaceKey);
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] 移除远程项目历史失败", { error, workspaceKey });
        toast(intl.formatMessage({ id: "workspaceSidebar.removeProjectFailed" }), {
          variant: "warning",
        });
        return;
      }
    }
    closeTab(tab.id);
    if (
      organization?.sectionFor({
        kind: "project",
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      })
    )
      void organization.run(
        [
          {
            type: "forget",
            entries: [
              {
                kind: "project",
                workspacePath: tab.workspacePath,
                ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
              },
            ],
          },
        ],
        false,
        true,
      );
    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      },
      lcodeTaskService,
    });
    // 移除 workspace 只是移除入口和连接历史，不代表用户要隐藏历史任务：
    // 这里只失效缓存，保留 sqlite 任务索引原状态，避免重连同一 SSH workspace 后任务像“丢了”。
    invalidateTaskQueryCacheByScopes([
      {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      },
    ]);

    if (!isRemoteWorkspace) {
      void scanWindowsReservedDeviceNameFiles(baseServices.fileService, tab.workspacePath)
        .then((result) => {
          if (result.findings.length === 0) {
            return;
          }
          const firstFinding = result.findings[0] ?? tab.workspacePath;
          toast(
            intl.formatMessage(
              { id: "workspaceSidebar.windowsReservedNameRisk" },
              { count: result.findings.length, path: firstFinding },
            ),
            { durationMs: 8_000, variant: "warning" },
          );
        })
        .catch((error: unknown) => {
          // Windows 保留设备名扫描只是移除后的兼容风险提示，失败不能影响 workspace 生命周期释放。
          logger.debug("[WorkspaceSidebarItem] Windows 保留名风险扫描失败", {
            workspaceKey,
            error,
          });
        });
    }
  }, [
    baseServices.fileService,
    preserveOrigin,
    removalBlockedReason,
    sidebarText,
    organization,
    closeTab,
    confirmDialog,
    intl,
    isExpanded,
    isRemoteWorkspace,
    onRemoveLocalProject,
    onRemoveRemoteProject,
    tab.id,
    tab.localProjectId,
    tab.workspaceIdentity,
    tab.workspacePath,
    lcodeTaskService,
  ]);

  const handleReconnectRemoteWorkspace = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isDisconnectedRemoteWorkspace || isReconnectPending) {
        return;
      }

      void onReconnectRemoteWorkspace(remoteWorkspaceKey);
    },
    [
      isDisconnectedRemoteWorkspace,
      isReconnectPending,
      onReconnectRemoteWorkspace,
      remoteWorkspaceKey,
    ],
  );

  const handleOpenWorkspaceFileTree = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDisconnectedRemoteWorkspace || readOnlyReason || !onOpenFileTree) {
        return;
      }

      onOpenFileTree({
        workspacePath: tab.workspacePath,
        workspaceName: tab.label,
        workspaceIdentity: tab.workspaceIdentity,
        workspaceRemoteSessionId: tab.remoteSessionId,
      });
    },
    [
      isDisconnectedRemoteWorkspace,
      onOpenFileTree,
      readOnlyReason,
      tab.label,
      tab.remoteSessionId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // 这些 TaskList 操作以前在 JSX 中每次 render 都创建新闭包。
  // 流式事件刷新 workspace 行时，即使任务数据没变，也会穿透 TaskList/TaskListItem 的 memo。
  const handleRenameTask = useCallback(
    async (taskId: string, title: string) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      logger.info("[WorkspaceSidebarItem] rename service call start", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        previousTitleLength: previousTask?.title.length,
        nextTitleLength: title.length,
      });
      let meta: LCodeTaskMeta;
      try {
        meta = await lcodeTaskService.renameTask({
          taskId,
          workspacePath: tab.workspacePath,
          title,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
      } catch (error) {
        logger.error("[WorkspaceSidebarItem] rename service call failed", {
          taskId,
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[WorkspaceSidebarItem] rename service call resolved", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        resolvedTitleLength: meta.title.length,
      });
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      logger.info("[WorkspaceSidebarItem] rename cache mutation applied", {
        taskId,
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
      });
      return meta;
    },
    [
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      readOnlyReason,
      upsertOptimisticTaskListItem,
      lcodeTaskService,
    ],
  );

  const handleSetTaskPinned = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      if (previousTask) {
        // workspace 内 pin 以前等远端/本地 RPC 返回后才更新全局 pinned 缓存，
        // pin 区会先消失再补回来。这里先乐观同步列表成员关系，失败时回滚。
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(previousTask);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
        }
        applyTaskQueryCacheMutation({
          previousTask,
          nextTask: previousTask,
          previousState: { pinned: false, archived: false },
          nextState: { pinned, archived: false },
        });
      }
      try {
        const meta = await lcodeTaskService.setTaskPinned({
          taskId,
          workspacePath: tab.workspacePath,
          pinned,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        });
        removeOptimisticTaskListItem(tab.workspacePath, taskId, tab.workspaceIdentity);
        if (tab.workspaceIdentity && pinned) {
          useRemotePinnedTaskStore.getState().upsertTask(meta);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        }
        if (tab.workspaceIdentity && !pinned) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          useRemoteTimelineTaskStore.getState().upsertTask(meta);
        }
        applyTaskQueryCacheMutation({
          previousTask: previousTask ?? meta,
          nextTask: meta,
          previousState: { pinned, archived: false },
          nextState: { pinned, archived: false },
        });
        return meta;
      } catch (error) {
        if (previousTask) {
          if (tab.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
            useRemoteTimelineTaskStore.getState().upsertTask(previousTask);
          }
          if (tab.workspaceIdentity && !pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(previousTask);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: previousTask,
            previousState: { pinned, archived: false },
            nextState: { pinned: false, archived: false },
          });
        }
        throw error;
      }
    },
    [
      removeOptimisticTaskListItem,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      lcodeTaskService,
    ],
  );

  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await lcodeTaskService.archiveTask({
        taskId,
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      removeTaskState(tab.workspacePath, taskId, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
        useRemotePinnedTaskStore
          .getState()
          .removeTask(tab.workspacePath, taskId, tab.workspaceIdentity);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: true },
      });
      return meta;
    },
    [
      removeTaskState,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      lcodeTaskService,
    ],
  );

  const handleSetTaskUnread = useCallback(
    async (taskId: string, unread: boolean) => {
      if (readOnlyReason) {
        return null;
      }
      const previousTask = findCurrentTaskItem(taskId);
      const meta = await lcodeTaskService.setTaskUnread({
        taskId,
        workspacePath: tab.workspacePath,
        unread,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      });
      setTaskUnreadIndicator(tab.workspacePath, taskId, unread, tab.workspaceIdentity);
      upsertOptimisticTaskListItem(tab.workspacePath, meta, tab.workspaceIdentity);
      if (tab.workspaceIdentity) {
        useRemoteTimelineTaskStore.getState().upsertTask(meta);
      }
      applyTaskQueryCacheMutation({
        previousTask: previousTask ?? meta,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
      });
      return meta;
    },
    [
      setTaskUnreadIndicator,
      readOnlyReason,
      tab.workspaceIdentity,
      tab.workspacePath,
      findCurrentTaskItem,
      upsertOptimisticTaskListItem,
      lcodeTaskService,
    ],
  );

  const handleCopyRemoteWorkspaceError = useCallback(() => {
    if (!remoteWorkspaceError || remoteWorkspaceError.trim().length === 0) {
      return;
    }

    navigator.clipboard.writeText(remoteWorkspaceError).then(() => {
      setIsRemoteErrorCopied(true);
      if (remoteErrorCopyResetRef.current !== null) {
        window.clearTimeout(remoteErrorCopyResetRef.current);
      }
      remoteErrorCopyResetRef.current = window.setTimeout(() => {
        setIsRemoteErrorCopied(false);
        remoteErrorCopyResetRef.current = null;
      }, 1500);
    });
  }, [remoteWorkspaceError]);
  const renderWorkspaceIcon = () => {
    // workspace 行之前在 hover/展开时会把目录图标切成箭头，
    // 视觉上会多出一层“树形展开控件”的暗示；当前交互只需要保留项目图标本身，
    // 这样能减少噪音，也避免用户把它理解成独立的箭头开关。
    if (isExpanded && !isDisconnectedRemoteWorkspace) {
      return isRemoteWorkspace ? (
        <Cloud className="h-4 w-4 text-foreground-subtle" />
      ) : isHomeWorkspace ? (
        <House className="h-4 w-4 text-foreground-subtle" />
      ) : (
        <FolderOpen className="h-4 w-4 text-foreground-subtle" />
      );
    }

    return isRemoteWorkspace ? (
      <Cloud className="h-4 w-4 text-foreground-subtle" />
    ) : isHomeWorkspace ? (
      <House className="h-4 w-4 text-foreground-subtle" />
    ) : (
      <Folder className="h-4 w-4 text-foreground-subtle" />
    );
  };

  const workspaceLabelContent = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {renderWorkspaceIcon()}
      </span>
      <div className="min-w-0 truncate text-ui-base text-foreground-subtle">
        {workspaceSidebarLabel}
      </div>
      {projectDefinition && projectDefinition.sourceFolderPaths.length > 1 ? (
        <span
          className="shrink-0 rounded-md bg-surface px-1.5 text-ui-xs text-foreground-subtlest"
          title={projectDefinition.sourceFolderPaths.join("\n")}
          data-project-folder-count
        >
          {projectDefinition.sourceFolderPaths.length}
        </span>
      ) : null}
      {!isExpanded && taskListHasUnread ? (
        <span
          aria-hidden="true"
          data-workspace-unread-indicator="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400"
        />
      ) : null}
      {!isExpanded && taskListLiveWorkflowCount > 0 ? (
        // 工作流运行行的组头汇总：
        // 只汇总在跑的 run；已结束未确认的行不上卷。
        <span
          data-workspace-workflow-indicator="true"
          data-count={String(taskListLiveWorkflowCount)}
          aria-label={intl.formatMessage(
            { id: "taskList.workflowRun.liveCount" },
            { count: String(taskListLiveWorkflowCount) },
          )}
          className="flex shrink-0 items-center gap-1 text-ui-xs leading-none text-foreground-subtle"
        >
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
          {taskListLiveWorkflowCount > 1 ? taskListLiveWorkflowCount : null}
        </span>
      ) : null}
      {readOnlyReason && !sourceReadError ? (
        <ControlHintTooltip title={readOnlyReason} side="right" align="center">
          <span
            role="img"
            aria-label={readOnlyReason}
            tabIndex={0}
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <CircleAlert className="size-3.5 text-destructive" />
          </span>
        </ControlHintTooltip>
      ) : null}
      {sourceReadError ? (
        <SidebarSourceReadError
          label={tab.label}
          workspacePath={tab.workspacePath}
          error={sourceReadError}
          refreshing={sourceRefreshing}
          onRefresh={onRefreshSource}
        />
      ) : null}
    </div>
  );

  const projectMenuItems = (
    Item: typeof DropdownMenuItem | typeof ContextMenuItem,
    Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator,
  ) => (
    <>
      {isRemoteWorkspace ? (
        <Item disabled>
          {sidebarText("remoteProject")} · {workspaceSidebarLabel}
          {isDisconnectedRemoteWorkspace ? ` · ${sidebarText("offline")}` : ""}
        </Item>
      ) : null}
      {isDisconnectedRemoteWorkspace ? (
        <Item
          disabled={isReconnectPending && organization?.isDesktop === false}
          onSelect={() => {
            if (isReconnectPending)
              void onReconnectRemoteWorkspace(remoteWorkspaceKey, { cancelPending: true });
            else if (!isReconnectPending) void onReconnectRemoteWorkspace(remoteWorkspaceKey);
          }}
        >
          {sidebarText(isReconnectPending ? "cancelConnection" : "reconnect")}
        </Item>
      ) : null}
      <Item
        disabled={Boolean(readOnlyReason) || isDisconnectedRemoteWorkspace}
        title={
          readOnlyReason ?? (isDisconnectedRemoteWorkspace ? sidebarText("offline") : undefined)
        }
        onSelect={() => {
          if (!readOnlyReason && !isDisconnectedRemoteWorkspace)
            onStartDraftInWorkspace(tab.workspacePath, tab.workspaceIdentity);
        }}
      >
        {sidebarText(isRemoteWorkspace ? "remoteNew" : "projectNew")}
      </Item>
      {onStartCollaboration &&
      (projectDefinition?.members?.filter((member) => member.enabled).length ??
        projectDefinition?.sourceFolderPaths.length ??
        0) > 1 ? (
        <Item
          disabled={Boolean(readOnlyReason) || isDisconnectedRemoteWorkspace}
          title={
            readOnlyReason ?? (isDisconnectedRemoteWorkspace ? sidebarText("offline") : undefined)
          }
          onSelect={onStartCollaboration}
        >
          {sidebarText("newExecutionSet")}
        </Item>
      ) : null}
      <Item
        disabled={Boolean(readOnlyReason) || isDisconnectedRemoteWorkspace || !onOpenFileTree}
        title={readOnlyReason}
        onSelect={() =>
          onOpenFileTree?.({
            workspacePath: tab.workspacePath,
            workspaceName: tab.label,
            workspaceIdentity: tab.workspaceIdentity,
            workspaceRemoteSessionId: tab.remoteSessionId,
          })
        }
      >
        {sidebarText(isRemoteWorkspace ? "remoteFiles" : "files")}
      </Item>
      <Item onSelect={() => void copyAbsolutePath({ path: tab.workspacePath, kind: "directory" })}>
        {sidebarText(isRemoteWorkspace ? "remotePath" : "copyPath")}
      </Item>
      <Item
        data-testid={testId(
          "project-worktrees-menu",
          tab.workspaceIdentity?.trim() || tab.workspacePath,
        )}
        disabled={Boolean(readOnlyReason) || isDisconnectedRemoteWorkspace || !showProjectWorktrees}
        title={readOnlyReason}
        onSelect={() => (onOpenWorktrees ? onOpenWorktrees() : openWorktreeSettings(tab))}
      >
        <GitBranchIcon className="size-3.5" />
        {sidebarText("manage")}
      </Item>
      {remoteSyncEligible ? (
        <>
          <Separator />
          <ProjectRemoteSyncGroup
            dropdown={Item === DropdownMenuItem}
            disabled={!resolution.rpcReady}
          >
            <Item onSelect={() => setRemoteSkillSyncOpen(true)}>
              {intl.formatMessage({ id: "settings.skills.remoteSync.open" })}
            </Item>
            <Item onSelect={() => setRemoteMcpSyncOpen(true)}>
              {intl.formatMessage({ id: "settings.mcp.remoteSync.open" })}
            </Item>
            <Item onSelect={() => setRemotePluginSyncOpen(true)}>
              {intl.formatMessage({ id: "settings.plugins.remoteSync.open" })}
            </Item>
          </ProjectRemoteSyncGroup>
        </>
      ) : null}
      <SidebarPlacementItems
        entry={{
          kind: "project",
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        }}
        Item={Item}
        Separator={Separator}
      />
      <Separator />
      <Item
        data-testid={testId(TID_WORKSPACE_CLOSE, tab.workspacePath)}
        disabled={preserveOrigin}
        title={preserveOrigin ? (removalBlockedReason ?? sidebarText("activeBinding")) : undefined}
        onSelect={() => void handleRemoveWorkspace()}
      >
        <XIcon className="size-3.5" />
        {intl.formatMessage({ id: "workspaceSidebar.remove" })}
      </Item>
    </>
  );
  return (
    <li ref={itemRef} style={itemStyle} className="space-y-2">
      <Collapsible
        className="flex flex-col gap-1"
        open={isExpanded && !isDisconnectedRemoteWorkspace}
        onOpenChange={handleWorkspaceOpenChange}
      >
        <ContextMenu onOpenChange={setProjectContextOpen}>
          <ContextMenuTrigger asChild>
            <div onContextMenu={(event) => event.stopPropagation()}>
              <BorderBeam
                size="line"
                colorVariant="colorful"
                duration={1.96}
                active={shouldShowRemoteConnectingBorderBeam}
                borderRadius={8}
              >
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-lg transition-[background-color,box-shadow]",
                    isReconnectPending
                      ? "bg-brand/10 workspace-remote-connecting-breathe"
                      : isDisconnectedRemoteWorkspace
                        ? "bg-warning/8"
                        : null,
                    // "sticky top-0 z-10", // TODO: 拖拽时让 workspace 项悬浮 不要抹掉
                    isDragging && "bg-selected shadow-xl",
                  )}
                >
                  <CollapsibleTrigger asChild>
                    <div
                      role="button"
                      aria-label={workspaceSidebarLabel}
                      tabIndex={0}
                      data-testid={testId(TID_WORKSPACE_ITEM, tab.workspacePath)}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "default" }),
                        /*
                         * CollapsibleTrigger 会自动注入 aria-expanded。
                         * 这里复用了 ghost button 变体后，会命中全局 aria-expanded:bg-surface-hover
                         * 导致 workspace 项一展开就像"被选中"一样出现背景色。
                         * 局部把 aria-expanded 样式覆盖掉，只保留 hover，避免误导激活态。
                         * 断连的 remote workspace 不能展开任务列表，因此这里也要禁掉 hover 展开态提示，
                         * 避免用户看到“可展开”的反馈却点不开，只保留 warning 背景提示当前需要先重连。
                         */
                        "flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                        "hover:bg-surface-hover hover:text-foreground",
                        isDisconnectedRemoteWorkspace &&
                          "hover:bg-transparent aria-expanded:bg-transparent",
                        sortableBindings && "cursor-grab active:cursor-grabbing",
                      )}
                      onMouseEnter={() => setWorkspaceRowHovered(true)}
                      onMouseLeave={() => setWorkspaceRowHovered(false)}
                      onFocusCapture={() => setWorkspaceRowFocusWithin(true)}
                      onBlurCapture={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setWorkspaceRowFocusWithin(false);
                        }
                      }}
                      {...(sortableBindings?.attributes ?? {})}
                      {...(sortableBindings?.listeners ?? {})}
                    >
                      {/* 错误详情优先，不能把它嵌进普通 SSH 提示而同时打开两层浮层。 */}
                      {sshWorkspaceTooltipDetails && !sourceReadError ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>{workspaceLabelContent}</TooltipTrigger>
                            <TooltipContent
                              side="right"
                              align="start"
                              sideOffset={6}
                              className="max-w-80 flex-col items-start gap-2 p-2.5 text-left"
                            >
                              <span className="text-ui-sm font-medium text-tooltip-foreground">
                                {intl.formatMessage({
                                  id: "workspaceSidebar.sshConnectionTitle",
                                })}
                              </span>
                              <dl className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-ui-sm/relaxed text-tooltip-foreground">
                                {sshWorkspaceTooltipDetails.alias ? (
                                  <>
                                    <dt className="font-medium">
                                      {intl.formatMessage({
                                        id: "workspaceSidebar.sshConnectionAlias",
                                      })}
                                    </dt>
                                    <dd className="min-w-0 break-all font-mono">
                                      {sshWorkspaceTooltipDetails.alias}
                                    </dd>
                                  </>
                                ) : null}
                                <dt className="font-medium">
                                  {intl.formatMessage({
                                    id: "workspaceSidebar.sshConnectionHost",
                                  })}
                                </dt>
                                <dd className="min-w-0 break-all font-mono">
                                  {sshWorkspaceTooltipDetails.hostLabel}
                                </dd>
                                <dt className="font-medium">
                                  {intl.formatMessage({
                                    id: "workspaceSidebar.sshConnectionPath",
                                  })}
                                </dt>
                                <dd className="min-w-0 break-all font-mono">
                                  {sshWorkspaceTooltipDetails.workspacePath}
                                </dd>
                              </dl>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        workspaceLabelContent
                      )}

                      <div className="flex shrink-0 items-center gap-2">
                        {/* {isRemoteWorkspace && isReconnectPending ? (
                    <ReconnectingRemoteWorkspaceLogTooltip
                      logs={reconnectRuntimeLogs}
                    />
                  ) : null} */}
                        <div className="flex shrink-0 items-center gap-1">
                          {shouldMountWorkspaceRowActions ? (
                            <DropdownMenu
                              open={workspaceActionMenuOpen}
                              onOpenChange={setWorkspaceActionMenuOpen}
                            >
                              <ControlHintTooltip title={intl.formatMessage({ id: "common.more" })}>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                                    onMouseDown={handleActionMouseDown}
                                    aria-label={intl.formatMessage({ id: "common.more" })}
                                  >
                                    <Ellipsis className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </ControlHintTooltip>
                              <DropdownMenuContent align="end" onClick={handleActionMenuClick}>
                                {projectMenuItems(DropdownMenuItem, DropdownMenuSeparator)}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                          {shouldMountWorkspaceRowActions && showFileTreeAction ? (
                            <span className="shrink-0">
                              {/* Project 文件树入口以前单独覆盖 hover:bg-surface-hover，
                            与 Pinned / Grouped 的 bg-hover 不一致；三种入口统一复用同一 action。 */}
                              <TaskRowActionButton
                                // 该按钮默认继承 ghost 的主前景色，导致同组的三个图标明暗不一致。
                                className="text-foreground-subtle hover:text-foreground"
                                label={intl.formatMessage({
                                  id: "workspaceSidebar.showFileTree",
                                })}
                                onClick={handleOpenWorkspaceFileTree}
                                showTooltip
                                disabledReason={readOnlyReason}
                                testId={testId(TID_WORKSPACE_FILE_TREE_BUTTON, tab.workspacePath)}
                              >
                                <ListTree className="h-3.5 w-3.5" />
                              </TaskRowActionButton>
                            </span>
                          ) : null}
                          {showRemoteConnectionErrorNotice ? (
                            remoteWorkspaceError ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div
                                      role="img"
                                      tabIndex={0}
                                      className="flex size-6 shrink-0 items-center justify-center !text-warning cursor-help"
                                      aria-label={intl.formatMessage({
                                        id: "workspaceSidebar.notConnected",
                                      })}
                                    >
                                      <CircleAlert className="h-3.5 w-3.5" />
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent
                                    side="top"
                                    align="center"
                                    sideOffset={4}
                                    className="w-72 max-w-72 items-center gap-2 p-2.5"
                                  >
                                    {/*
                                     * 远端连接失败 tooltip 之前拆成“标题 + 内层卡片”两段结构，
                                     * 在 sidebar 这种高密度区域里会显得层级过多，像一个迷你弹窗，不够轻。
                                     * 这里收敛回普通 tooltip 语义：一层浮层里直接放错误正文和复制按钮，
                                     * 保留可读性与复制能力，同时避免视觉上过度设计。
                                     */}
                                    <pre className="max-h-32 min-w-0 flex-1 overflow-auto text-ui-sm/relaxed whitespace-pre-wrap break-words font-mono text-tooltip-foreground">
                                      {remoteWorkspaceError}
                                    </pre>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-md"
                                      className="mt-0.5 size-6 shrink-0 text-tooltip-foreground/80 hover:bg-tooltip-tag hover:text-tooltip-foreground"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        handleCopyRemoteWorkspaceError();
                                      }}
                                      title={intl.formatMessage({
                                        id: isRemoteErrorCopied
                                          ? "chat.toolCall.copyError.copied"
                                          : "chat.toolCall.copyError",
                                      })}
                                      aria-label={intl.formatMessage({
                                        id: isRemoteErrorCopied
                                          ? "chat.toolCall.copyError.copied"
                                          : "chat.toolCall.copyError",
                                      })}
                                    >
                                      {isRemoteErrorCopied ? (
                                        <CheckIcon className="size-3" />
                                      ) : (
                                        <CopyIcon className="size-3" />
                                      )}
                                    </Button>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <ControlHintTooltip
                                title={intl.formatMessage({
                                  id: "workspaceSidebar.notConnected",
                                })}
                              >
                                <div
                                  className="flex size-6 shrink-0 items-center justify-center !text-warning"
                                  aria-label={intl.formatMessage({
                                    id: "workspaceSidebar.notConnected",
                                  })}
                                >
                                  <CircleAlert className="h-3.5 w-3.5" />
                                </div>
                              </ControlHintTooltip>
                            )
                          ) : null}
                          {showReconnectAction ? (
                            isReconnectPending ? (
                              <ReconnectingRemoteWorkspaceLogTooltip logs={reconnectRuntimeLogs}>
                                {/* SSH workspace 重连中时，右侧原本只有 spinning 图标，
                              用户无法在聊天页任务列表里确认连接卡在哪一步。这里复用 SSH dialog 的连接日志 tooltip，
                              保持行内布局稳定，同时把诊断信息放到 hover 浮层里。 */}
                                <div
                                  role="status"
                                  className={cn(
                                    buttonVariants({ variant: "ghost", size: "icon-sm" }),
                                    "shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground",
                                  )}
                                  onMouseDown={handleActionMouseDown}
                                  aria-label={intl.formatMessage({
                                    id: "workspaceSidebar.connecting",
                                  })}
                                >
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                </div>
                              </ReconnectingRemoteWorkspaceLogTooltip>
                            ) : (
                              <ControlHintTooltip
                                title={intl.formatMessage({
                                  id: "workspaceSidebar.reconnect",
                                })}
                                side="right"
                                align="center"
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  className="shrink-0 text-foreground opacity-100 hover:bg-surface-hover hover:text-foreground disabled:opacity-100"
                                  onMouseDown={handleActionMouseDown}
                                  onClick={handleReconnectRemoteWorkspace}
                                  aria-label={intl.formatMessage({
                                    id: "workspaceSidebar.reconnect",
                                  })}
                                >
                                  <RefreshCwIcon className="h-3.5 w-3.5" />
                                </Button>
                              </ControlHintTooltip>
                            )
                          ) : shouldMountWorkspaceRowActions ? (
                            <ControlHintTooltip
                              title={
                                readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })
                              }
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                                onMouseDown={handleActionMouseDown}
                                onClick={handleCreateThreadClick}
                                disabled={Boolean(readOnlyReason)}
                                aria-label={intl.formatMessage({
                                  id: "taskList.newThread",
                                })}
                              >
                                <MessageCirclePlus className="h-3.5 w-3.5" />
                              </Button>
                            </ControlHintTooltip>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </CollapsibleTrigger>
                </div>
              </BorderBeam>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent onClick={(event) => event.stopPropagation()}>
            {projectMenuItems(ContextMenuItem, ContextMenuSeparator)}
          </ContextMenuContent>
        </ContextMenu>

        {showTaskList ? (
          <CollapsibleContent className="ml-4 border-l border-border/60 pl-1">
            <TaskList
              workspacePath={tab.workspacePath}
              remoteSessionId={tab.remoteSessionId}
              workspaceIdentity={tab.workspaceIdentity}
              tasks={taskItems}
              groupByDate={groupByDate}
              sortBy={taskSortBy}
              pinnedTasks={EMPTY_PINNED_TASKS}
              activeTaskId={isActiveWorkspace ? activeTaskId : null}
              onSelectTask={handleSelectTask}
              showCreateButton={false}
              showFooter={false}
              loading={taskListLoading}
              hasMore={taskListHasMore}
              onShowMore={onShowMoreTasks}
              onRenameTask={handleRenameTask}
              onSetTaskPinned={handleSetTaskPinned}
              onArchiveTask={handleArchiveTask}
              onSetTaskUnread={handleSetTaskUnread}
              readOnlyReason={readOnlyReason}
            />
          </CollapsibleContent>
        ) : null}
      </Collapsible>
      <RemoteSyncDialogs
        canSyncSkills={showRemoteSkillSyncAction}
        canSyncMcp={showRemoteSkillSyncAction}
        canSyncPlugins={showRemoteSkillSyncAction}
        skillOpen={remoteSkillSyncOpen}
        mcpOpen={remoteMcpSyncOpen}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localSkillSyncService={baseServices.skillSyncService}
        remoteSkillSyncService={services.skillSyncService}
        localMcpSyncService={baseServices.mcpSyncService}
        remoteMcpSyncService={services.mcpSyncService}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={services.pluginSyncService}
        localLCodeAgentService={baseServices.lcodeAgentService}
        remoteLCodeAgentService={services.lcodeAgentService}
        remoteTarget={tab.remoteTarget}
        skillWorkspacePath={tab.workspacePath}
        mcpWorkspacePath={tab.workspacePath}
        pluginWorkspacePath={tab.workspacePath}
        pluginLocalWorkspacePath={tab.localWorkspacePath}
        mcpLocalWorkspacePath={tab.localWorkspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        onSkillsSynced={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            lcodeSessionService: services.lcodeSessionService,
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            reason: "sidebar-remote-skill-sync",
          });
          await refreshSharedSkillStoreForWorkspace({
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            skillsService: services.skillsService,
          });
        }}
        onMcpSynced={async () => {
          await useMcpStore
            .getState()
            .ensureLoadedForWorkspace(
              tab.workspacePath,
              services.mcpSyncService,
              tab.workspaceIdentity,
            );
        }}
        onPluginsSynced={async () => {
          await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
            commandsService: services.commandsService,
            mcpSyncService: services.mcpSyncService,
            reason: "sidebar-remote-plugin-sync",
            skillsService: services.skillsService,
            workspaceIdentity: tab.workspaceIdentity,
            workspacePath: tab.workspacePath,
            lcodeAgentService: services.lcodeAgentService,
            lcodeSessionService: services.lcodeSessionService,
          });
        }}
      />
    </li>
  );
});
WorkspaceSidebarItem.displayName = "WorkspaceSidebarItem";
