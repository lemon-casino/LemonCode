import { randomUUID } from "node:crypto";
import type { BrowserControlListInput, BrowserControlPort, TraceContext } from "@lcode/contracts";
import {
  lcodeBrowserExecuteResultSchema,
  lcodeBrowserListResultSchema,
  lcodeProtocolMethods,
} from "@lcode/shared";
import {
  protocolTraceFromTraceContext,
  requireSession,
  type LCodeProtocolAgentServerContext,
  type LCodeProtocolClientRequestOptions,
  type LCodeProtocolSessionRecord,
} from "./server-types.js";

interface ChildScope {
  sessionId: string;
  parentSessionId: string;
  rootSessionId: string;
  rootRecord: LCodeProtocolSessionRecord;
  controller: AbortController;
  closePromise?: Promise<void>;
}

/** Browser 资源归属 child，workspace/attachment 路由由活跃 root record 提供。 */
export function createProtocolBrowserControlBroker(
  context: LCodeProtocolAgentServerContext,
): BrowserControlPort {
  const scopes = new Map<string, ChildScope>();
  const closedRoots = new WeakSet<LCodeProtocolSessionRecord>();
  // 结束 turn 的拒绝记录随根 record 生存，child resume 不能重新接纳旧内核的迟到调用。
  const endedTurns = new WeakMap<LCodeProtocolSessionRecord, Map<string, Set<string>>>();
  const pending = new Map<string, Set<{ turnId?: string; controller: AbortController }>>();
  const connectionsBySession = new Map<
    string,
    Map<string, { browserId: string; browserGeneration: number }>
  >();

  const resolveRoute = (sessionId: string, expected?: ChildScope) => {
    const scope = scopes.get(sessionId);
    if (expected && scope !== expected)
      throw new Error(`Browser scope is not active: ${sessionId}`);
    if (scope?.controller.signal.aborted)
      throw new Error(`Browser scope is not active: ${sessionId}`);
    const rootSessionId = scope?.rootSessionId ?? sessionId;
    const record = requireSession(context, rootSessionId);
    // 同 ID 的根 runtime 重建后，旧 child lease 不能漂移到新 attachment。
    if (closedRoots.has(record) || (scope && scope.rootRecord !== record))
      throw new Error(`Browser scope is not active: ${sessionId}`);
    return { record, scope, rootSessionId };
  };

  const requestContext = (input: BrowserControlListInput, expected?: ChildScope) => {
    const { record } = resolveRoute(input.sessionId, expected);
    return buildBrowserRequestContext(record, input);
  };

  const runRequest = async <T>(
    input: BrowserControlListInput,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => {
    const { scope, record } = resolveRoute(input.sessionId);
    const turnId = input.turnId ?? input.traceContext?.turnId;
    if (turnId && endedTurns.get(record)?.get(input.sessionId)?.has(turnId))
      throw new Error(`Browser turn is not active: ${turnId}`);
    const controller = new AbortController();
    const request = { turnId, controller };
    const requests = pending.get(input.sessionId) ?? new Set();
    requests.add(request);
    pending.set(input.sessionId, requests);
    const signal = AbortSignal.any([
      controller.signal,
      ...(scope ? [scope.controller.signal] : []),
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      signal.throwIfAborted();
      const result = await operation(signal);
      // requestClient 可能在 abort 后仍返回结果；关闭作用域后绝不接受迟到成功。
      signal.throwIfAborted();
      if (resolveRoute(input.sessionId, scope).record !== record)
        throw new Error(`Browser scope is not active: ${input.sessionId}`);
      return result;
    } finally {
      requests.delete(request);
      if (requests.size === 0 && pending.get(input.sessionId) === requests)
        pending.delete(input.sessionId);
    }
  };

  const cancelPending = (sessionId: string, turnId?: string) => {
    for (const request of pending.get(sessionId) ?? [])
      if (turnId === undefined || request.turnId === turnId) request.controller.abort();
  };

  const retireTurn = (record: LCodeProtocolSessionRecord, sessionId: string, turnId?: string) => {
    if (!turnId) return;
    const sessions = endedTurns.get(record) ?? new Map<string, Set<string>>();
    const turns = sessions.get(sessionId) ?? new Set<string>();
    turns.add(turnId);
    sessions.set(sessionId, turns);
    endedTurns.set(record, sessions);
  };

  const sendLifecycle = async (
    sessionId: string,
    params: ReturnType<typeof buildBrowserRequestContext>,
    command: { method: "turnEnded"; turnId?: string } | { method: "closeSession" },
  ) => {
    const connections = [...(connectionsBySession.get(sessionId)?.values() ?? [])];
    if (command.method === "closeSession") connectionsBySession.delete(sessionId);
    await Promise.allSettled(
      connections.map(({ browserId, browserGeneration }) =>
        context.requestClient(
          lcodeProtocolMethods.interactionBrowserExecute,
          { ...params, requestId: randomUUID(), browserId, browserGeneration, command },
          lcodeBrowserExecuteResultSchema,
        ),
      ),
    );
  };

  const port: BrowserControlPort = {
    createChildScope({ parentSessionId, sessionId }) {
      const parent = resolveRoute(parentSessionId);
      if (scopes.has(sessionId) || context.sessions.has(sessionId))
        throw new Error(`Browser scope is already active: ${sessionId}`);
      const scope: ChildScope = {
        sessionId,
        parentSessionId,
        rootSessionId: parent.rootSessionId,
        rootRecord: parent.record,
        controller: new AbortController(),
      };
      scopes.set(sessionId, scope);
      const assertOwn = (actual: string) => {
        if (actual !== sessionId) throw new Error(`Browser scope cannot access session: ${actual}`);
        resolveRoute(sessionId, scope);
      };
      return {
        createChildScope(input) {
          assertOwn(input.parentSessionId);
          return port.createChildScope!(input);
        },
        async list(input) {
          assertOwn(input.sessionId);
          return port.list(input);
        },
        async execute(input) {
          assertOwn(input.sessionId);
          return port.execute(input);
        },
        async turnEnded(input) {
          assertOwn(input.sessionId);
          await port.turnEnded!(input);
        },
        async closeSession(input) {
          if (input.sessionId !== sessionId)
            throw new Error(`Browser scope cannot close session: ${input.sessionId}`);
          // 旧 runtime 的重复 dispose 不能撤销同 ID 后续 resume 铸造的新 lease。
          if (scopes.get(sessionId) !== scope) return;
          await port.closeSession!(input);
        },
      };
    },
    async list(input) {
      const params = requestContext(input);
      return runRequest(input, async (signal) => {
        const result = await context.requestClient(
          lcodeProtocolMethods.interactionBrowserList,
          params,
          lcodeBrowserListResultSchema,
          buildRequestOptions(input.traceContext, signal),
        );
        return result.browsers;
      });
    },
    async execute(input) {
      const params = requestContext(input);
      const { sessionId, browserId, browserGeneration, command, traceContext } = input;
      return runRequest(input, async (signal) => {
        const connections = connectionsBySession.get(sessionId) ?? new Map();
        connections.set(`${browserId}\u0000${browserGeneration}`, { browserId, browserGeneration });
        connectionsBySession.set(sessionId, connections);
        const cancelBackendRequest = () => {
          // 保存撤销前的路由；重新 require 已关闭 child 会漏掉 host/main 的取消。
          void context
            .requestClient(
              lcodeProtocolMethods.interactionBrowserExecute,
              {
                ...params,
                requestId: randomUUID(),
                browserId,
                browserGeneration,
                command: { method: "cancelRequest", requestId: params.requestId },
              },
              lcodeBrowserExecuteResultSchema,
              buildRequestOptions(traceContext, undefined),
            )
            .catch(() => undefined);
        };
        signal.addEventListener("abort", cancelBackendRequest, { once: true });
        try {
          return await context.requestClient(
            lcodeProtocolMethods.interactionBrowserExecute,
            { ...params, browserId, browserGeneration, command },
            lcodeBrowserExecuteResultSchema,
            buildRequestOptions(traceContext, signal),
          );
        } finally {
          signal.removeEventListener("abort", cancelBackendRequest);
        }
      });
    },
    async turnEnded(input) {
      const params = requestContext(input);
      const turnId = input.turnId ?? input.traceContext?.turnId;
      retireTurn(resolveRoute(input.sessionId).record, input.sessionId, turnId);
      cancelPending(input.sessionId, turnId);
      await sendLifecycle(input.sessionId, params, { method: "turnEnded", turnId });
    },
    async closeSession(input) {
      const existing = scopes.get(input.sessionId);
      if (existing?.closePromise) return existing.closePromise;
      // 根 record 可能已移除，清理仍使用铸造时的 workspace；不得冷恢复 session。
      const record =
        existing?.rootRecord ??
        context.sessions.get(input.sessionId) ??
        [...scopes.values()].find((scope) => scope.rootSessionId === input.sessionId)?.rootRecord;
      if (!record) return;
      const affected = [input.sessionId];
      for (let i = 0; i < affected.length; i++)
        for (const scope of scopes.values())
          if (scope.parentSessionId === affected[i]) affected.push(scope.sessionId);
      const owned = affected.map((sessionId) => ({ sessionId, scope: scopes.get(sessionId) }));
      const priorCloses = owned.flatMap(({ scope }) =>
        scope?.closePromise ? [scope.closePromise] : [],
      );
      if (!existing) closedRoots.add(record);
      // 先同步撤销后代再发异步清理；siblings 的 tab/request 不进入该集合。
      for (const { sessionId, scope } of owned) {
        const rootRecord = scope?.rootRecord ?? record;
        for (const request of pending.get(sessionId) ?? [])
          retireTurn(rootRecord, sessionId, request.turnId);
        scope?.controller.abort();
        cancelPending(sessionId);
      }
      const closePromise = Promise.allSettled([
        ...priorCloses,
        ...owned.map(({ sessionId, scope }) =>
          sendLifecycle(
            sessionId,
            buildBrowserRequestContext(scope?.rootRecord ?? record, { ...input, sessionId }),
            { method: "closeSession" },
          ),
        ),
      ]).then(() => {
        for (const { sessionId, scope } of owned) {
          if (scope && scopes.get(sessionId) === scope) scopes.delete(sessionId);
        }
      });
      for (const { scope } of owned) if (scope) scope.closePromise = closePromise;
      await closePromise;
    },
  };
  return port;
}

function buildBrowserRequestContext(
  record: LCodeProtocolSessionRecord,
  input: BrowserControlListInput,
) {
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;
  const turnId = input.turnId ?? input.traceContext?.turnId;
  return {
    requestId: randomUUID(),
    sessionId: input.sessionId,
    ...(turnId ? { turnId: String(turnId) } : {}),
    // 相同路径的 remote workspace 也必须按 identity 隔离资源。
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live" as const,
  };
}

function buildRequestOptions(
  traceContext: TraceContext | undefined,
  signal: AbortSignal | undefined,
): LCodeProtocolClientRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
