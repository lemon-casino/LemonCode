import { randomUUID } from "node:crypto";
import {
  BrowserScopeError,
  type BrowserCleanupPending,
  type BrowserControlListInput,
  type BrowserControlPort,
  type BrowserScopeCloseResult,
  type TraceContext,
} from "@lcode/contracts";
import {
  lcodeBrowserExecuteResultSchema,
  lcodeBrowserListResultSchema,
  lcodeProtocolErrorCodes,
  lcodeProtocolMethods,
} from "@lcode/shared";
import {
  protocolTraceFromTraceContext,
  ProtocolRequestError,
  type LCodeProtocolAgentServerContext,
  type LCodeProtocolSessionRecord,
} from "./server-types.js";
import {
  BROWSER_LIFECYCLE_ACK_TIMEOUT_MS,
  cancelBrowserRequest,
  createBrowserCleanupJob,
  type BrowserCleanupJob,
  type BrowserCleanupTarget,
  type BrowserRequestRoute,
} from "./browser-control-lifecycle.js";

interface BrowserScope {
  sessionId: string;
  parentSessionId?: string;
  rootSessionId: string;
  rootRecord: WeakRef<LCodeProtocolSessionRecord>;
  routeKey: string;
  phase: "active" | "revoking" | "cleanup_pending" | "closed";
  controller: AbortController;
  pending: Set<{ turnId?: string; controller: AbortController }>;
  connections: Map<string, BrowserCleanupTarget>;
  cleanup: Map<string, BrowserCleanupJob>;
  closePromise?: Promise<BrowserScopeCloseResult>;
}

/** 唯一注册表同时拥有 lease、连接和 retiring cleanup，不持有关闭 runtime/store。 */
export function createProtocolBrowserControlBroker(
  context: Pick<LCodeProtocolAgentServerContext, "sessions" | "requestClient">,
  options: { ackTimeoutMs?: number } = {},
): BrowserControlPort {
  const scopes = new Map<string, BrowserScope>();
  const closedRoots = new WeakSet<LCodeProtocolSessionRecord>();
  const endedTurns = new WeakMap<LCodeProtocolSessionRecord, Map<string, Set<string>>>();
  const timeoutMs = options.ackTimeoutMs ?? BROWSER_LIFECYCLE_ACK_TIMEOUT_MS;
  const inactive = (sessionId: string) =>
    new BrowserScopeError("scope_inactive", `Browser scope is not active: ${sessionId}`);
  const targetKey = (target: Pick<BrowserCleanupTarget, "browserId" | "browserGeneration">) =>
    `${target.browserId}\u0000${target.browserGeneration}`;
  const makeScope = (
    sessionId: string,
    rootSessionId: string,
    record: LCodeProtocolSessionRecord,
    parentSessionId?: string,
  ): BrowserScope => ({
    sessionId,
    rootSessionId,
    parentSessionId,
    rootRecord: new WeakRef(record),
    routeKey: routingKey(record),
    phase: "active",
    controller: new AbortController(),
    pending: new Set(),
    connections: new Map(),
    cleanup: new Map(),
  });
  const resolveRoute = (sessionId: string, expected?: BrowserScope) => {
    let scope = scopes.get(sessionId);
    if ((expected && scope !== expected) || (scope && scope.phase !== "active"))
      throw inactive(sessionId);
    const rootSessionId = scope?.rootSessionId ?? sessionId;
    const record = context.sessions.get(rootSessionId);
    if (!record)
      throw new ProtocolRequestError(
        lcodeProtocolErrorCodes.sessionUnavailable,
        `Session is not active: ${rootSessionId}`,
      );
    // 历史 child record/publisher 不能变成可执行 root；metadata 不授予 Browser lease。
    if (
      record.taskType === "subagent_child" ||
      record.taskType === "workflow_child" ||
      closedRoots.has(record) ||
      (scope && (scope.rootRecord.deref() !== record || scope.routeKey !== routingKey(record)))
    )
      throw inactive(sessionId);
    if (!scope) {
      scope = makeScope(sessionId, rootSessionId, record);
      scopes.set(sessionId, scope);
    }
    return { scope, record, rootSessionId };
  };
  const cancelPending = (scope: BrowserScope, turnId?: string) => {
    for (const request of scope.pending)
      if (turnId === undefined || request.turnId === turnId) request.controller.abort();
  };
  const retireTurn = (
    record: LCodeProtocolSessionRecord | undefined,
    sessionId: string,
    turnId?: string,
  ) => {
    if (!record || !turnId) return;
    const sessions = endedTurns.get(record) ?? new Map<string, Set<string>>();
    const turns = sessions.get(sessionId) ?? new Set<string>();
    turns.add(turnId);
    sessions.set(sessionId, turns);
    endedTurns.set(record, sessions);
  };
  const tryRetire = (scope: BrowserScope): void => {
    if (
      scope.phase === "active" ||
      scope.connections.size ||
      scope.cleanup.size ||
      [...scopes.values()].some((child) => child.parentSessionId === scope.sessionId)
    )
      return;
    scope.phase = "closed";
    if (scopes.get(scope.sessionId) === scope) scopes.delete(scope.sessionId);
    const parent = scope.parentSessionId ? scopes.get(scope.parentSessionId) : undefined;
    if (parent) tryRetire(parent);
  };
  const cleanupJob = (
    scope: BrowserScope,
    target: BrowserCleanupTarget,
    command: BrowserCleanupJob["command"],
    traceContext?: TraceContext,
  ) => {
    const key = `${command.method}\u0000${targetKey(target)}\u0000${command.method === "turnEnded" ? (command.turnId ?? "") : ""}`;
    let job = scope.cleanup.get(key);
    if (!job) {
      job = createBrowserCleanupJob({
        host: context,
        target,
        command,
        timeoutMs,
        traceContext,
        confirmed: () => {
          if (scope.cleanup.get(key) !== job) return;
          scope.cleanup.delete(key);
          if (command.method === "closeSession") scope.connections.delete(targetKey(target));
          tryRetire(scope);
        },
      });
      scope.cleanup.set(key, job);
    }
    return job;
  };
  const runRequest = async <T>(
    input: BrowserControlListInput,
    operation: (
      scope: BrowserScope,
      record: LCodeProtocolSessionRecord,
      signal: AbortSignal,
    ) => Promise<T>,
  ) => {
    const { scope, record } = resolveRoute(input.sessionId);
    const turnId = input.turnId ?? input.traceContext?.turnId;
    if (turnId && endedTurns.get(record)?.get(input.sessionId)?.has(turnId))
      throw new BrowserScopeError("turn_inactive", `Browser turn is not active: ${turnId}`);
    const controller = new AbortController();
    const request = { turnId, controller };
    scope.pending.add(request);
    const signal = AbortSignal.any([
      controller.signal,
      scope.controller.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      signal.throwIfAborted();
      const result = await operation(scope, record, signal);
      signal.throwIfAborted();
      resolveRoute(input.sessionId, scope);
      return result;
    } finally {
      scope.pending.delete(request);
    }
  };
  const port: BrowserControlPort = {
    createChildScope({ parentSessionId, sessionId }) {
      const parent = resolveRoute(parentSessionId);
      const existing = scopes.get(sessionId);
      if (existing || context.sessions.has(sessionId))
        throw new BrowserScopeError(
          existing && existing.phase !== "active" ? "cleanup_pending" : "active_duplicate",
          existing && existing.phase !== "active"
            ? `Browser scope cleanup is pending: ${sessionId}`
            : `Browser scope is already active: ${sessionId}`,
        );
      const scope = makeScope(sessionId, parent.rootSessionId, parent.record, parentSessionId);
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
          return port.turnEnded!(input);
        },
        async closeSession(input) {
          if (input.sessionId !== sessionId)
            throw new Error(`Browser scope cannot close session: ${input.sessionId}`);
          // 原 wrapper 不得关闭同 ID 新代。
          if (scopes.get(sessionId) !== scope) return { phase: "closed" };
          return port.closeSession!(input);
        },
      };
    },
    async list(input) {
      return runRequest(input, async (_scope, record, signal) => {
        const result = await context.requestClient(
          lcodeProtocolMethods.interactionBrowserList,
          buildRoute(record, input),
          lcodeBrowserListResultSchema,
          requestOptions(input.traceContext, signal),
        );
        return result.browsers;
      });
    },
    async execute(input) {
      return runRequest(input, async (scope, record, signal) => {
        const key = targetKey(input);
        if (
          [...scope.cleanup.values()].some(
            (job) => job.command.method === "turnEnded" && targetKey(job.target) === key,
          )
        )
          throw new BrowserScopeError(
            "turn_cleanup_pending",
            `Browser turn cleanup is pending for backend: ${input.browserId}`,
          );
        const params = buildRoute(record, input);
        const target = {
          browserId: input.browserId,
          browserGeneration: input.browserGeneration,
          route: buildRoute(record, { sessionId: input.sessionId }),
        };
        scope.connections.set(key, target);
        const cancel = () =>
          cancelBrowserRequest(context, target, params.requestId, input.traceContext);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          return await context.requestClient(
            lcodeProtocolMethods.interactionBrowserExecute,
            {
              ...params,
              browserId: input.browserId,
              browserGeneration: input.browserGeneration,
              command: input.command,
            },
            lcodeBrowserExecuteResultSchema,
            requestOptions(input.traceContext, signal),
          );
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      });
    },
    async turnEnded(input) {
      const { scope, record } = resolveRoute(input.sessionId);
      const turnId = input.turnId ?? input.traceContext?.turnId;
      const alreadyEnded = turnId && endedTurns.get(record)?.get(input.sessionId)?.has(turnId);
      retireTurn(record, input.sessionId, turnId);
      cancelPending(scope, turnId);
      const jobs = alreadyEnded
        ? [...scope.cleanup.values()].filter(
            (job) => job.command.method === "turnEnded" && job.command.turnId === turnId,
          )
        : [...scope.connections.values()].map((target) =>
            cleanupJob(scope, target, { method: "turnEnded", turnId }, input.traceContext),
          );
      const results = await Promise.all(jobs.map((job) => job.run()));
      return (
        results.find(
          (result): result is BrowserCleanupPending => result.phase === "cleanup_pending",
        ) ?? { phase: "completed" }
      );
    },
    async closeSession(input) {
      const scope = scopes.get(input.sessionId);
      if (!scope) {
        const record = context.sessions.get(input.sessionId);
        if (record) closedRoots.add(record);
        return { phase: "closed" };
      }
      if (scope.closePromise) return scope.closePromise;
      const affected = [scope];
      for (let i = 0; i < affected.length; i++)
        for (const child of scopes.values())
          if (child.parentSessionId === affected[i].sessionId) affected.push(child);
      // 第一次 await 前撤销完整子树。没有连接的构造失败在同一拍直接释放身份。
      for (const entry of affected) {
        entry.phase = "revoking";
        const record = entry.rootRecord.deref();
        if (!entry.parentSessionId && record) closedRoots.add(record);
        for (const request of entry.pending) retireTurn(record, entry.sessionId, request.turnId);
        entry.controller.abort();
        cancelPending(entry);
      }
      const jobs = affected.flatMap((entry) => {
        for (const target of entry.connections.values())
          cleanupJob(entry, target, { method: "closeSession" }, input.traceContext);
        return [...entry.cleanup.values()];
      });
      for (const entry of [...affected].reverse()) tryRetire(entry);
      const closePromise = Promise.all(jobs.map((job) => job.run()))
        .then((results): BrowserScopeCloseResult => {
          for (const entry of [...affected].reverse()) {
            tryRetire(entry);
            if (entry.phase !== "closed") entry.phase = "cleanup_pending";
          }
          return scope.phase === "closed"
            ? { phase: "closed" }
            : (results.find(
                (result): result is BrowserCleanupPending => result.phase === "cleanup_pending",
              ) ?? { phase: "cleanup_pending", reason: "ack_timeout" });
        })
        .finally(() => {
          if (scope.closePromise === closePromise) scope.closePromise = undefined;
        });
      scope.closePromise = closePromise;
      return closePromise;
    },
  };
  return port;
}

function buildRoute(
  record: LCodeProtocolSessionRecord,
  input: BrowserControlListInput,
): BrowserRequestRoute {
  const workspaceIdentity = record.workspace.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = record.workspace.remoteSessionId?.trim() || undefined;
  const workspacePath = record.workspace.workspacePath;
  const turnId = input.turnId ?? input.traceContext?.turnId;
  return {
    requestId: randomUUID(),
    sessionId: input.sessionId,
    ...(turnId ? { turnId: String(turnId) } : {}),
    workspaceKey: workspaceIdentity ?? workspacePath,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    clientMode: record.deliveryKind ?? "desktop-continuous",
    sessionContext: "live",
  };
}
function routingKey(record: LCodeProtocolSessionRecord): string {
  const route = buildRoute(record, { sessionId: "" });
  return [
    route.workspaceKey,
    route.workspacePath,
    route.remoteSessionId ?? "",
    route.clientMode,
  ].join("\u0000");
}
function requestOptions(traceContext: TraceContext | undefined, signal: AbortSignal) {
  return {
    signal,
    ...(traceContext ? { trace: protocolTraceFromTraceContext(traceContext) } : {}),
  };
}
