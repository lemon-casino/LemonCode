import type { V4GatewayHost } from "../lcode-protocol-v4/v4-gateway.js";

// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（lcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
import { parseRemoteWorkspaceIdentity } from "@lcode/shared";

import { type SessionSummary } from "@lcode/shared/lcode-protocol-v4";

import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../lcode-protocol-v4/task-list-session-membership.js";

import type { SessionId, WorkspaceId } from "@lcode/contracts";

import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";

import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";

import { readSessionContextUsage } from "./server-operations.js";

import type { LCodeProtocolAgentServerContext } from "./server-types.js";

import { cloneModelSelection } from "./v4-bridge-model-selection.js";

import { sessionUsageSeedFromRuntimeContextUsage } from "./v4-bridge-hydration.js";

function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

export function createV4SessionIndexHost(
  context: LCodeProtocolAgentServerContext,
): Pick<
  V4GatewayHost,
  | "getSessionMemoryEnabled"
  | "getSessionConfigSeed"
  | "getSessionUsageSeed"
  | "getSessionWorkspaceId"
  | "getSessionIndexMeta"
  | "listWorkspaceSessionIds"
  | "isDraftSession"
  | "getWorkspaceConfig"
  | "getStoredSessionSummaries"
  | "refreshLegacySessionSummaries"
> {
  const loadStoredSessionSummaries = createStoredSessionSummaryReader(context);
  return {
    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,

    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },

    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
        persistedMessages,
      );
    },

    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },

    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },

    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),

    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",

    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),

    getStoredSessionSummaries: loadStoredSessionSummaries,

    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
  };
}

function createStoredSessionSummaryReader(context: LCodeProtocolAgentServerContext) {
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // 未加载会话的轻量摘要：store 元信息 → SessionSummary（phase 取空闲完成态默认、
    // sessionEnded=true 对齐 「成功轮收口即 true」口径；加载后的准确
    // phase/preview/backgroundWork 由 gateway 用 live 投影覆盖）。
    // workspaceKey 的本地 fallback = workspacePath，故用它作 listSessions 的 directory 过滤。
    if (!context.deps.sessionStore) return [];
    try {
      // 远端 sessions-index 的 workspaceId 是隔离 identity，而 session store 的
      // directory 是实际文件路径。查询必须同时带路径和 identity；否则同一路径下其他
      // authority 的会话会被误标成当前 workspace。legacy 空 identity 不能只凭路径
      // claim，只允许使用 host task-index 给出的精确 taskId 归属证明。
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "lcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.lcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // claim 只是旧数据兼容步骤；失败后仍要读取已有完整 identity 的会话。
          // 后续携带 allowlist 的订阅会再次进入这里，不能用失败结果封死迁移。
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "lcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.lcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        includeArchived: false,
        limit: 200,
        // parentID 只表达会话层级，不能作为左侧任务 membership。
        // 显式 fork 必然带 parentID，但重启后仍应由 taskType 投影进 sessions-index。
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase: "completedSuccess" as const,
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "lcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.lcode_protocol",
      });
      return [];
    }
  };
  return loadStoredSessionSummaries;
}
