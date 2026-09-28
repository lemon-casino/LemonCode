import { accessSync, constants as fsConstants } from "node:fs";
import {
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  traceContextToLogContext,
} from "../deps.js";
import type {
  ExecutionShellSelection,
  Logger,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "../deps.js";

const BASH_SHELL_SELECTION_ENTRY_ID_SUFFIX = "runtime:bash_shell_selection";

export type BashShellSnapshotRestore =
  | { status: "restored"; selection: ExecutionShellSelection }
  | {
      status: "fallback";
      reason: "stale_snapshot";
      selection: ExecutionShellSelection;
      staleSelection: ExecutionShellSelection;
    }
  | { status: "stale"; staleSelection: ExecutionShellSelection }
  | { status: "missing" | "invalid" | "read_failed" };

export async function persistBashShellSelectionSnapshot(options: {
  logger?: Logger;
  selection: ExecutionShellSelection | undefined;
  sessionId: SessionId;
  sessionStore: SessionStorePort | undefined;
  traceContext: TraceContext;
}): Promise<void> {
  if (!options.selection || !options.sessionStore?.saveSessionEntry) {
    return;
  }

  try {
    const timestamp = Date.now();
    await options.sessionStore.saveSessionEntry({
      id: `${options.sessionId}:${BASH_SHELL_SELECTION_ENTRY_ID_SUFFIX}`,
      sessionID: options.sessionId,
      type: SESSION_ENTRY_BASH_SHELL_SELECTION,
      time: {
        created: timestamp,
        updated: timestamp,
      },
      // Bash shell 设置变更只影响新 session；必须把创建时快照落库，
      // 冷恢复时才能继续使用同一个 shell 执行，而不是重新读取最新 settings。
      data: serializeBashShellSelection(options.selection),
    });
  } catch (error) {
    options.logger?.warn("Failed to persist Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.bash_shell_selection.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function readPersistedBashShellSelectionSnapshot(options: {
  logger?: Logger;
  sessionId: SessionId;
  sessionStore: SessionStorePort | undefined;
  traceContext: TraceContext;
}): Promise<BashShellSnapshotRestore> {
  if (!options.sessionStore?.sessionEntries) {
    return { status: "missing" };
  }

  try {
    const entries = await options.sessionStore.sessionEntries({
      sessionID: options.sessionId,
      type: SESSION_ENTRY_BASH_SHELL_SELECTION,
    });
    const latestEntry = entries.at(-1);
    if (!latestEntry) {
      return { status: "missing" };
    }
    const selection = parsePersistedBashShellSelection(latestEntry?.data);
    if (selection) {
      return { selection, status: "restored" };
    }
    options.logger?.warn("Ignored invalid persisted Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      event: "session_entry.bash_shell_selection.invalid",
      module: "core.runtime",
    });
    return { status: "invalid" };
  } catch (error) {
    options.logger?.warn("Failed to read persisted Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.bash_shell_selection.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return { status: "read_failed" };
  }
}

export function resolveBashShellSnapshotForResume(options: {
  currentSelection: ExecutionShellSelection | undefined;
  logger?: Logger;
  restore: BashShellSnapshotRestore;
  traceContext: TraceContext;
}): BashShellSnapshotRestore {
  const { currentSelection, logger, restore, traceContext } = options;
  if (restore.status !== "restored" || isPersistedBashShellSelectionUsable(restore.selection)) {
    return restore;
  }

  logger?.warn("Ignored stale persisted Bash shell selection snapshot", {
    ...traceContextToLogContext(traceContext),
    event: "session_entry.bash_shell_selection.stale",
    module: "core.runtime",
    persistedShellName: restore.selection.display.name,
    persistedShellPath: restore.selection.path,
  });

  if (currentSelection) {
    return {
      reason: "stale_snapshot",
      selection: currentSelection,
      staleSelection: restore.selection,
      status: "fallback",
    };
  }
  return { staleSelection: restore.selection, status: "stale" };
}

function serializeBashShellSelection(selection: ExecutionShellSelection): ExecutionShellSelection {
  return { ...selection, display: { ...selection.display } };
}

function parsePersistedBashShellSelection(value: unknown): ExecutionShellSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const display = record.display;
  if (!display || typeof display !== "object" || Array.isArray(display)) {
    return undefined;
  }
  const displayName = (display as Record<string, unknown>).name;
  const dialect = record.dialect;
  const source = record.source;
  if (
    typeof displayName !== "string" ||
    !isExecutionShellDialect(dialect) ||
    !isExecutionShellSource(source)
  ) {
    return undefined;
  }

  const selection: ExecutionShellSelection = {
    dialect,
    display: { name: displayName },
    source,
  };
  if (typeof record.id === "string") {
    selection.id = record.id;
  }
  if (typeof record.label === "string") {
    selection.label = record.label;
  }
  if (typeof record.path === "string") {
    selection.path = record.path;
  }
  return selection;
}

function isPersistedBashShellSelectionUsable(selection: ExecutionShellSelection): boolean {
  if (selection.dialect === "legacy-shell") {
    return selection.path === undefined || selection.path.trim().length === 0;
  }

  if (!selection.path) {
    return false;
  }

  if (isWindowsCmdFallbackSelection(selection)) {
    return true;
  }

  try {
    accessSync(selection.path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWindowsCmdFallbackSelection(selection: ExecutionShellSelection): boolean {
  const shellPath = selection.path;
  return (
    selection.dialect === "cmd" &&
    shellPath !== undefined &&
    !shellPath.includes("\\") &&
    !shellPath.includes("/") &&
    shellPath.toLowerCase() === "cmd.exe"
  );
}

function isExecutionShellDialect(value: unknown): value is ExecutionShellSelection["dialect"] {
  return value === "cmd" || value === "posix" || value === "git-bash" || value === "legacy-shell";
}

function isExecutionShellSource(value: unknown): value is ExecutionShellSelection["source"] {
  return value === "auto-detected" || value === "user-config" || value === "legacy-fallback";
}
