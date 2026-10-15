import type { Logger, ProtocolShutdownContext } from "@lcode/contracts";
import { isClosableSessionStore } from "./session-store.js";
import type { CreateSessionFacadeDeps } from "./session-facade-types.js";

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;
const MEMORY_EXTRACTION_DRAIN_MS = 60_000;
const SESSION_STORE_RESOURCE = "session_store";
type SessionCloseDeps = Pick<
  CreateSessionFacadeDeps,
  | "runtime"
  | "closeDynamicWorkflowRuns"
  | "ownsSessionStore"
  | "sessionStore"
  | "ownsExecutionPort"
  | "executionPort"
  | "ownsMcpPort"
  | "mcpPort"
  | "closeNodeReplBrowserBroker"
  | "closeModelAdapter"
  | "logger"
  | "sessionResourceCloseTimeoutMs"
>;
type ResourceOutcome = { type: "completed" | "pending" } | { type: "failed"; error: unknown };
interface ResourceCloseState {
  work: Promise<void>;
  failure?: { error: unknown };
}

/** 每个 facade 的唯一关闭 owner：保存原在途句柄和成功进度，失败后仅重试未完成项。 */
export function createSessionResourceCloser(deps: SessionCloseDeps) {
  const resources = new Map<string, ResourceCloseState>();
  let closing: Promise<void> | undefined;
  let started = false;
  let firstContext: ProtocolShutdownContext | undefined;
  const run = (name: string, close: () => void | Promise<void>): Promise<void> => {
    const existing = resources.get(name);
    if (existing && !existing.failure) return existing.work;
    let state: ResourceCloseState;
    const work = Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        // 旧 facade 缓存 rejected close，外层即使保留 App 也无法再次到达资源 owner。
        state.failure = { error };
        throw error;
      });
    state = { work };
    resources.set(name, state);
    return work;
  };
  return (context?: ProtocolShutdownContext): Promise<void> => {
    if (!started) {
      started = true;
      firstContext = context;
    }
    closing ??= closeResources(deps, firstContext, run, resources).catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
}

/** 单次嵌入调用仍复用同一个关闭实现；需要重试的宿主应持有 createSessionResourceCloser。 */
export function closeSessionFacadeResources(
  deps: SessionCloseDeps,
  context?: ProtocolShutdownContext,
): Promise<void> {
  return createSessionResourceCloser(deps)(context);
}

async function closeResources(
  deps: SessionCloseDeps,
  context: ProtocolShutdownContext | undefined,
  run: (name: string, close: () => void | Promise<void>) => Promise<void>,
  resources: ReadonlyMap<string, ResourceCloseState>,
): Promise<void> {
  deps.runtime.beginShutdown();
  const critical: Promise<void>[] = [];
  const retain = (name: string, close: () => void | Promise<void>) => {
    const work = run(name, close);
    deps.runtime.retainSessionStoreDependentCloseWork(work);
    critical.push(work);
  };
  if (deps.closeModelAdapter) retain("model", deps.closeModelAdapter);
  retain("memory", () => deps.runtime.drainMemoryExtractions(MEMORY_EXTRACTION_DRAIN_MS));
  if (deps.closeDynamicWorkflowRuns)
    retain("workflow", () => deps.closeDynamicWorkflowRuns!(context));
  // 提前观察拒绝，但不吞错误；Core 的另一条 drain 也可能先消费同一个 retained work。
  const criticalResults = Promise.allSettled(critical);
  const timeoutMs = Math.max(
    1,
    Math.trunc(deps.sessionResourceCloseTimeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const candidates: Array<[string, (() => void | Promise<void>) | undefined]> = [
    ["browser_session", () => deps.runtime.closeBrowserSession()],
    [
      "execution",
      deps.ownsExecutionPort && deps.executionPort.close
        ? () => deps.executionPort.close?.()
        : undefined,
    ],
    ["mcp", deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined],
    ["node_repl_browser_broker", deps.closeNodeReplBrowserBroker],
  ];
  const outcomes = await Promise.all(
    candidates.flatMap(([name, close]) =>
      close ? [withinDeadline(name, run(name, close), timeoutMs, deps.logger)] : [],
    ),
  );
  const drained = await Promise.allSettled([deps.runtime.drainSessionStoreDependentCloseWork()]);
  const failures = new Set<unknown>();
  for (const outcome of [...(await criticalResults), ...drained])
    if (outcome.status === "rejected") failures.add(outcome.reason);
  for (const outcome of outcomes) if (outcome.type === "failed") failures.add(outcome.error);
  // 超时仅停止本轮等待；若原 close 在 critical drain 期间迟到拒绝，仍不能误报成功关库。
  for (const [name, state] of resources)
    if (name !== SESSION_STORE_RESOURCE && state.failure) failures.add(state.failure.error);
  // owner 退休/资源拒绝曾被 warn 后吞掉，导致 App 被摘除而 lease 仍 active。
  // 先让独立资源与 stable drain 都结束，再保留全部失败，失败时不关闭 store。
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1) throw new AggregateError([...failures], "Session resource close failed");
  if (deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)) {
    const store = deps.sessionStore;
    await run(SESSION_STORE_RESOURCE, () => store.close());
  }
}

async function withinDeadline(
  name: string,
  work: Promise<void>,
  timeoutMs: number,
  logger: Logger,
): Promise<ResourceOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    work.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "pending" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "pending" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.type !== "completed")
    logger.warn(
      outcome.type === "pending"
        ? "Session resource close timed out"
        : "Session resource close failed",
      {
        event: `session.resource_close.${outcome.type === "pending" ? "timed_out" : "failed"}`,
        resource: name,
        timeoutMs,
        ...(outcome.type === "failed"
          ? {
              error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            }
          : {}),
      },
    );
  return outcome;
}
