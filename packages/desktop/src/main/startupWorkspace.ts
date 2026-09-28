import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import {
  appSettingsSchema,
  formatZodError,
  resolveStartupLocalWorkspaceSessionIndex,
  type WorkspacePurpose,
} from "@lcode/shared";

interface StartupWorkspaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

async function readStartupSettings(settingsFile: string, logger?: StartupWorkspaceLogger) {
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const result = appSettingsSchema.safeParse(parsed);

    if (!result.success) {
      logger?.warn?.(
        "[startup-workspace] invalid settings file, falling back to default workspace:",
        formatZodError(result.error),
      );
      return appSettingsSchema.parse({});
    }

    return result.data;
  } catch {
    return appSettingsSchema.parse({});
  }
}

export interface StartupWorkspaceWarmupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

const STARTUP_AGENT_WARMUP_LIMIT = 3;

export interface StartupWindowBootstrap {
  restoreSession?: boolean;
  initialWorkspacePath?: string;
  initialWorkspacePurpose?: WorkspacePurpose;
  unavailableWorkspacePath?: string;
  agentWarmupTargets?: StartupWorkspaceWarmupTarget[];
}

async function isAvailableWorkspaceDirectory(workspacePath: string): Promise<boolean> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) {
      return false;
    }
    await access(workspacePath, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePersistedActiveSession(
  sessions: NonNullable<ReturnType<typeof appSettingsSchema.parse>["lastWorkspaceSession"]>,
  lastActiveTabIndex: number | undefined,
) {
  if (sessions.length === 0) {
    return undefined;
  }
  const activeIndex = Math.min(Math.max(lastActiveTabIndex ?? 0, 0), sessions.length - 1);
  return sessions[activeIndex];
}

function resolveStartupAgentWarmupTargets(
  settings: Pick<ReturnType<typeof appSettingsSchema.parse>, "recentProjects">,
  activeTarget: StartupWorkspaceWarmupTarget,
): StartupWorkspaceWarmupTarget[] {
  const candidates: StartupWorkspaceWarmupTarget[] = [
    activeTarget,
    ...(settings.recentProjects ?? []).map((workspacePath) => ({
      workspacePath,
    })),
  ];
  const seen = new Set<string>();
  const targets: StartupWorkspaceWarmupTarget[] = [];

  for (const candidate of candidates) {
    const workspaceKey = candidate.workspaceIdentity?.trim() || candidate.workspacePath;
    if (!workspaceKey || seen.has(workspaceKey)) {
      continue;
    }
    seen.add(workspaceKey);
    targets.push(candidate);
    if (targets.length === STARTUP_AGENT_WARMUP_LIMIT) {
      break;
    }
  }

  return targets;
}

export function createOpenWorkspaceStartupBootstrap(workspacePath: string): StartupWindowBootstrap {
  return {
    initialWorkspacePath: workspacePath,
    initialWorkspacePurpose: "project",
    agentWarmupTargets: [{ workspacePath }],
  };
}

export async function resolveStartupWindowBootstrap({
  settingsFile,
  conversationWorkspaceDir,
  logger,
}: {
  settingsFile: string;
  conversationWorkspaceDir: string;
  logger?: StartupWorkspaceLogger;
}): Promise<StartupWindowBootstrap> {
  const settings = await readStartupSettings(settingsFile, logger);
  const sessions = settings.lastWorkspaceSession ?? [];

  if (sessions.length > 0) {
    const persistedActiveSession = resolvePersistedActiveSession(
      sessions,
      settings.lastActiveTabIndex,
    );
    const unavailableWorkspacePath =
      persistedActiveSession?.kind === "local" &&
      !(await isAvailableWorkspaceDirectory(persistedActiveSession.workspacePath))
        ? persistedActiveSession.workspacePath
        : undefined;
    if (unavailableWorkspacePath) {
      // 上次激活 workspace 被移动或删除后，Agent 仍需保留原业务路径读取历史，
      // 但子进程 cwd 必须落在真实存在的目录；conversation backing workspace 只承担 cwd 兜底。
      await mkdir(conversationWorkspaceDir, { recursive: true });
      logger?.warn?.(
        "[startup-workspace] active local workspace unavailable; using read-only restore:",
        unavailableWorkspacePath,
      );
    }
    const localActiveSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
      sessions,
      settings.lastActiveTabIndex,
    );
    const activeSession =
      localActiveSessionIndex == null ? undefined : sessions[localActiveSessionIndex];
    if (activeSession?.kind === "local") {
      // 被动 sessions-index 全量恢复不能再启动全部 workspace，但只预热当前一个又让
      // 用户在最近项目间切换重新承担完整冷启动。Main 在唯一启动边界固定选出最近 3 个，
      // Host 仍走原 initializeWorkspace 路径；失败不继续扫描第 4 个补位。
      const agentWarmupTargets = resolveStartupAgentWarmupTargets(settings, {
        workspacePath: activeSession.workspacePath,
      });
      return {
        ...(unavailableWorkspacePath ? { unavailableWorkspacePath } : {}),
        agentWarmupTargets,
      };
    }
    return unavailableWorkspacePath ? { unavailableWorkspacePath } : {};
  }

  // UI 可以没有项目，但 Agent 必须始终有真实 cwd。首次启动统一预热
  // app-managed conversation backing workspace，不能再创建会被误认成项目的 LCodeProject。
  await mkdir(conversationWorkspaceDir, { recursive: true });
  logger?.info?.("[startup-workspace] using conversation workspace:", conversationWorkspaceDir);
  return {
    initialWorkspacePath: conversationWorkspaceDir,
    initialWorkspacePurpose: "conversation",
    agentWarmupTargets: [{ workspacePath: conversationWorkspaceDir }],
  };
}
