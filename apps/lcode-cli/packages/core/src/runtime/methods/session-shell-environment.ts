import type { EnvInfo, ExecutionShellSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  persistBashShellSelectionSnapshot,
  readPersistedBashShellSelectionSnapshot,
  resolveBashShellSnapshotForResume,
  type BashShellSnapshotRestore,
} from "./bash-shell-snapshot.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "./shell-environment.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";
import { createTurnCancelledError, throwIfTurnAborted } from "../helpers/index.js";

export async function refreshSessionShellEnvironmentForExecution(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!runtime.resolveSessionShellSelection) return false;
  throwIfTurnAborted(signal);
  const owner = runtime.activeForegroundExecution;
  const preparationRevision = ++runtime.sessionShellPreparationRevision;
  const branchGeneration = runtime.branchGeneration;
  const turnNumber = runtime.turnNumber;
  const selection = await runtime.resolveSessionShellSelection(traceContext);
  throwIfTurnAborted(signal);
  // 设置读取是异步的；已关闭、换分支或失去前台所有权的结果不得覆盖后续任务。
  if (
    runtime.shuttingDown ||
    runtime.activeTurn ||
    runtime.sessionShellPreparationRevision !== preparationRevision ||
    runtime.activeForegroundExecution !== owner ||
    runtime.branchGeneration !== branchGeneration ||
    runtime.turnNumber !== turnNumber
  )
    throw createTurnCancelledError("Shell execution boundary changed");
  const previous = getSessionShellSelection(runtime);
  if (sameExecutionShell(previous, selection)) return false;
  applySessionShellEnvironment(runtime, selection);
  if (previous && runtime.contextInitialized) {
    runtime.messageHistory.addAttachment(
      "shell_environment_change",
      buildShellChangeNotice(selection),
    );
  }
  if (runtime.sessionPersisted) await persistSessionShellEnvironmentSnapshot(runtime, traceContext);
  return true;
}

function sameExecutionShell(
  previous: ExecutionShellSelection | undefined,
  next: ExecutionShellSelection,
): boolean {
  return (
    previous?.dialect === next.dialect &&
    previous.path === next.path &&
    previous.display.name === next.display.name
  );
}

function buildShellChangeNotice(selection: ExecutionShellSelection): string {
  const executable = selection.path ? ` (${selection.path})` : "";
  return `The Bash tool shell has changed to ${selection.display.name}${executable}. Use ${selection.dialect} shell syntax for subsequent commands.`;
}

type SessionShellConfig = Pick<AgentRuntimeConfig, "bashShellSelection">;

export type SessionShellEnvironmentCandidate =
  | ExecutionShellSelection
  | (() => ExecutionShellSelection);

interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellSelectionFromConfig(
  config: SessionShellConfig,
): ExecutionShellSelection | undefined {
  return config.bashShellSelection;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = getSessionShellSelectionFromConfig(runtime.config);
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: SessionShellEnvironmentCandidate,
): boolean {
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }

  // 无宿主 resolver 的子 runtime 仍可继承父任务的 Shell；根会话的后续任务
  // 通过统一执行边界刷新，不能把首次初始化当作会话永久选择。
  applySessionShellEnvironment(runtime, resolveSessionShellCandidate(candidate), {
    refreshContext: true,
  });
  return true;
}

function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options: { refreshContext?: boolean } = {},
): void {
  runtime.config.bashShellSelection = selection;
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  refreshBranchAwareBuiltInTools(runtime);

  if (options.refreshContext !== false) {
    refreshSessionShellContext(runtime, selection);
  }
}

function resolveSessionShellCandidate(
  candidate: SessionShellEnvironmentCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T,
  selection: ExecutionShellSelection | undefined,
): T;
function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  if (!envInfo || !selection?.display.name) {
    return envInfo;
  }
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

export async function persistSessionShellEnvironmentSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  await persistBashShellSelectionSnapshot({
    logger: runtime.logger,
    selection: getSessionShellSelection(runtime),
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    traceContext,
  });
}

export async function restoreSessionShellEnvironmentSelectionForResume(
  runtime: AgentRuntimeInternal,
  options: {
    currentSelection: ExecutionShellSelection | undefined;
    traceContext: TraceContext;
  },
): Promise<BashShellSnapshotRestore> {
  const restore = resolveBashShellSnapshotForResume({
    currentSelection: options.currentSelection,
    logger: runtime.logger,
    restore: await readPersistedBashShellSelectionSnapshot({
      logger: runtime.logger,
      sessionId: runtime.sessionId,
      sessionStore: runtime.sessionStore,
      traceContext: options.traceContext,
    }),
    traceContext: options.traceContext,
  });

  // 旧实现总用创建时的 entry 覆盖 Host 当前选择，导致继续旧会话无法切换。
  // entry 现在只作 fallback；当前候选优先，并保留旧值供历史 hydration 后提醒模型。
  if (
    options.currentSelection &&
    (restore.status !== "restored" ||
      !sameExecutionShell(restore.selection, options.currentSelection))
  ) {
    applySessionShellEnvironment(runtime, options.currentSelection, { refreshContext: false });
    // 恢复先采用当前候选，后续执行读到相同值会跳过刷新；此处同步覆盖 entry，避免每次恢复都重复迁移。
    await persistSessionShellEnvironmentSnapshot(runtime, options.traceContext);
    return {
      status: "refreshed",
      selection: options.currentSelection,
      previousSelection: restore.status === "restored" ? restore.selection : undefined,
    };
  }

  if (restore.status === "restored" || restore.status === "fallback") {
    applySessionShellEnvironment(runtime, restore.selection, {
      refreshContext: false,
    });
  }

  return restore;
}

export function announceSessionShellEnvironmentNoticeAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
    restore: BashShellSnapshotRestore;
  },
): void {
  const selection = getSessionShellSelection(runtime);
  if (selection && options.restore.status === "refreshed" && options.restore.previousSelection) {
    runtime.messageHistory.addAttachment(
      "shell_environment_change",
      buildShellChangeNotice(selection),
    );
    return;
  }
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: options.persistedEnvInfo?.shell,
    restoreStatus: options.restore.status,
    selection,
  });
  if (!selection || !noticeKind) {
    return;
  }

  const notice = buildShellEnvironmentResumeNotice(noticeKind, selection);
  if (hasShellEnvironmentChangeAttachment(runtime, notice)) {
    return;
  }

  // 旧 Windows 会话没有可用 shell snapshot 时，升级后可能由 auto Git Bash
  // 接管 Bash 执行。历史上下文仍可能让模型继续沿用旧 shell 习惯，因此必须在
  // resume 后补一个 provider-visible shell 提醒；恢复同一个可用 Shell 时不重复插入。
  runtime.messageHistory.addAttachment("shell_environment_change", notice);
}

function hasShellEnvironmentChangeAttachment(
  runtime: AgentRuntimeInternal,
  content: string,
): boolean {
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some(
      (entry) =>
        entry.kind === "attachment" &&
        entry.metadata?.source === "shell_environment_change" &&
        entry.content === content,
    );
}

function refreshSessionShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot
  ) {
    return;
  }
  // 切换时同步 Environment 前缀并保留 conversation，避免模型提示与实际 Bash 方言分叉。
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection),
  };
  rebuildContextPrefix(runtime);
}
