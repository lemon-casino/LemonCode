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
import { type LCodeWorkspaceRef } from "@lcode/shared";

import { createExternalTurnFaultError } from "@lcode/core";

import { V4_NOTIFICATIONS } from "@lcode/shared/lcode-protocol-v4";

import { V4CommandExecutor } from "../lcode-protocol-v4/commands/executor.js";

import { lookupGlobalCreateSessionCommand } from "../lcode-protocol-v4/create-session-command-fact.js";

import type { V4CommandCoreHost } from "../lcode-protocol-v4/commands/types.js";

import { PersistentCommandIndex } from "../lcode-protocol-v4/persistent-command-index.js";

import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
} from "../lcode-protocol-v4/persistent-command-facts.js";

import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../lcode-protocol-v4/v4-gateway.js";

import type { SessionId } from "@lcode/contracts";

import { activateSessionForResume } from "./server-operations.js";

import type { LCodeProtocolAgentServerContext } from "./server-types.js";

import { createProtocolLogger } from "./server-types.js";

import { createV4QueueAutoDrain } from "./v4-bridge-queue-drain.js";

import { createV4QueryHost } from "./v4-bridge-query-host.js";

import { createV4AdmissionHost } from "./v4-bridge-admission-host.js";

import { createV4SessionHost } from "./v4-bridge-session-host.js";

import { createV4ForkHost } from "./v4-bridge-fork-host.js";

import { createV4SessionIndexHost } from "./v4-bridge-session-index.js";

import { isConversationInputAdmissionCommand } from "./v4-bridge-admission-input.js";

import { createV4ReadHost } from "./v4-bridge-read-host.js";

import { createV4HydrationHost } from "./v4-bridge-hydration.js";

export function createConversationV4Gateway(
  context: LCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.lcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const autoDrainV4QueueIfReady = createV4QueueAutoDrain(context, (...args) =>
    nativeExecutor.execute(...args),
  );
  const coreHost: V4CommandCoreHost = {
    // 同一注册表对象引用：view 是旧 record 的结构化窄视图，字段变更双向可见。
    getRecord: (sessionId) => context.sessions.get(sessionId),
    // 同一登记表实例：broker（旧目录）注册反向请求 deferred，
    // v4 resolveInteraction handler 经此投递应答（v4 原生基础设施，非过渡钩子）。
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    ...createV4QueryHost(context),
    ...createV4AdmissionHost(context),
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
    ...createV4SessionHost(context, autoDrainV4QueueIfReady),
    ...createV4ForkHost(context),
  };
  nativeExecutor = new V4CommandExecutor(coreHost);
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    sessionExists: (sessionId) => context.sessions.has(sessionId),
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    // Gateway 的单一 READY promise 负责并发与水位；binder 只恢复 runtime。
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: LCodeWorkspaceRef,
    ) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!persisted) {
        context.logger?.warn("LCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "lcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.lcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const activated = await activateSessionForResume(
        context,
        {
          sessionId,
          // session.path 可能是规范化后的执行 cwd，不能覆盖当前 attachment
          // 已知的 workspace 身份。旧 session 没有 attachment 上下文时仍走原有持久化回退。
          ...(workspace ? { workspace } : {}),
          ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
        },
        { reusePersistedMessages: true },
      );
      return {
        status: "resumed",
        persistedMessages: activated.persistedMessages,
      };
    },
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    ...createV4SessionIndexHost(context),
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),
    admitCommandInput: async (envelope, admission) => {
      // 仅隐藏 composer 不能阻止旧 child 标签页续聊。类型准入必须早于
      // ledger/输入历史写入；detached child 没有 record 时只查元数据，不激活第二个 runtime。
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (taskType === "subagent_child") {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // 投影越过 16MiB 后继续生成只会让所有后续 snapshot 都无法编码。
      // gateway 先原子拒绝越界事件并登记 protocol fault，再单次调用这里中止模型 turn；
      // abort 的正常终态负责释放 active lock，不能在 gateway 里越层伪造 TurnError。
      controller.abort(createExternalTurnFaultError(reasonCode));
    },
    // commands/query 持久化 fallback：同 session 首次查询惰性建索引，后续四个来源
    // 共用该索引；anchor/marker/child/discarded 写入走 record 增量更新。
    lookupTranscriptCommand: (key) =>
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    ...createV4ReadHost(context),
    ...createV4HydrationHost(context, log),
    onError: (scope, error, errorContext) =>
      context.logger?.warn("LCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "lcode_protocol.v4.gateway_error",
        module: "bootstrap.lcode_protocol",
        scope,
      }),
  });
}
