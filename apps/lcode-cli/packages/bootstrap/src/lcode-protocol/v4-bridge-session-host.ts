import type { V4CommandCoreHost } from "../lcode-protocol-v4/commands/types.js";

import { resolveWorkspaceRefFromId } from "./mapper.js";

import { hasSessionModelProvider } from "./workspace-model-runtime.js";

import {
  afterStateMutation,
  createSessionRecordForV4,
  createWorktreeRepairRecord,
  ensureSessionModelAvailableForNextTurn,
} from "./server-operations.js";
import { createWorktreeRepairRunner } from "./worktree-repair.js";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export function createV4SessionHost(
  context: LCodeProtocolAgentServerContext,
  autoDrainV4QueueIfReady: (record: LCodeProtocolSessionRecord) => Promise<void>,
): Pick<
  V4CommandCoreHost,
  | "ensureModelReady"
  | "ensureProviderAvailable"
  | "afterLegacyStateMutation"
  | "closeSession"
  | "createSessionRecord"
  | "resolveWorktreeConflicts"
> {
  return {
    resolveWorktreeConflicts: createWorktreeRepairRunner(context, (parent, repair, sessionId) =>
      createWorktreeRepairRecord(context, parent, repair, sessionId),
    ),
    // ── 过渡钩子──────────────────────────────
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as LCodeProtocolSessionRecord),

    // 切模型前确认目标 Provider 已存在于当前 Environment Registry。普通模型命令只提交
    // Selection；Provider 事实始终由 Worker 自己的 Registry 解释。
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },

    afterLegacyStateMutation: async (record, reason) => {
      await afterStateMutation(context, record as LCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as LCodeProtocolSessionRecord);
    },

    // deleteSession 的执行面：内联旧 closeSession op 的 4 步（不 import 旧 op——
    // 语义与 server-operations.ts closeSession 对齐，随会话注册表归 v4 后收编）。
    closeSession: async (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        // handler 已校验存在性；此处只兜并发竞态（重复删除幂等成功）。
        return;
      }
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 通道：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
      // disposeSession 必须在注册表删除之前调用——
      // gateway 靠 getSessionWorkspaceId（读 context.sessions）定位 workspace 才能把
      // session.removed 推给 sessions-index 订阅者；先 delete 再 dispose 时 workspaceId
      // 恒为 null，删除会话后侧栏列表项永不消失（e2e conversation-session-v4-sidebar 抓出）。
      context.v4Gateway?.disposeSession(sessionId);
      context.sessions.delete(sessionId);
    },

    // createSession 的执行面：record 建立/事件接线/catalog 同步/失败自清理全在旧
    // createSession op 内（半初始化 record 的回收顺序修过 bug，不重复实现）。
    // 语义决策（draft persistence / firstInput 走原生 prompt turn）在原生 handler。
    createSessionRecord: async ({
      workspaceId,
      execution,
      executionRequestId,
      mcpServers,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
    }) => {
      // workspaceId 双形态（Workspace Identity 约束）：
      // - 本地工作区 = workspacePath（identity 缺省时的 fallback）；
      // - 远程 pane（跨 workspace 分屏）= 远程 identity
      //   （remote:ssh/wsl/docker:...:<path>，UI buildRemoteWorkspaceIdentity 构造）。
      //   经统一解析工具还原真实 workspacePath 作 workingDirectory——CLI 本就跑在
      //   远端机器上，path 即本机路径；identity 原样保留进 workspace ref
      //   （workspaceKey = identity，sessions-index topic / 隔离语义不变）。
      // shared parser 统一兼容 WSL legacy 与显式 user identity；非远程格式继续按
      // 本地 workspacePath 处理。
      const created = await createSessionRecordForV4(context, {
        workspace: resolveWorkspaceRefFromId(workspaceId),
        execution,
        executionRequestId,
        // 一律 deferred（draft 不进 sqlite）；提升时机归原生 prompt-turn。
        persistence: "deferred",
        // MCP 是 runtime 创建期配置；v4 createSession 必须与 legacy
        // session/create 等价透传，否则创建的 session 永远不会启动这些工具。
        mcpServers,
        // Off-Peak 工具面 flag 同为 runtime 创建期配置，必须随 create 进入 record。
        ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
        // 动态工作流灰度门同为 runtime 创建期配置：
        // v4 createSession 必须与 legacy session/create 等价透传，否则无界面创建的会话
        // 会绕过 Host 的灰度判定，只剩进程级缺省。
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
      });
      return { sessionId: created.sessionId };
    },
  };
}
