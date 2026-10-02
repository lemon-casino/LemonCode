import { type Logger } from "@lcode/contracts";
import { isClosableSessionStore } from "./session-store.js";
import type { CreateSessionFacadeDeps } from "./session-facade-types.js";

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  drainSessionStoreDependentCloseWork: () => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}

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
  | "logger"
  | "sessionResourceCloseTimeoutMs"
>;

export async function closeSessionFacadeResources(deps: SessionCloseDeps): Promise<void> {
  // 第一拍封闭新准入；随后立即启动各 owner 的收口，不能先等待某一项而饿死其它资源。
  deps.runtime.beginShutdown();
  const memoryDrain = deps.runtime.drainMemoryExtractions(60_000);
  deps.runtime.retainSessionStoreDependentCloseWork(memoryDrain);
  const workflowClose = (async () => {
    if (deps.closeDynamicWorkflowRuns === undefined) return;
    try {
      await deps.closeDynamicWorkflowRuns();
    } catch (error: unknown) {
      deps.logger.warn?.("Closing dynamic workflow runs failed; continuing to close resources", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.service.close_failed",
        module: "bootstrap.app",
      });
    }
  })();
  deps.runtime.retainSessionStoreDependentCloseWork(workflowClose);
  const closableSessionStore =
    deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
      ? deps.sessionStore
      : undefined;
  await closeSessionResources({
    beginShutdown: () => deps.runtime.beginShutdown(),
    closeBrowserSession: () => deps.runtime.closeBrowserSession(),
    closeExecution:
      deps.ownsExecutionPort && deps.executionPort.close
        ? () => deps.executionPort.close?.()
        : undefined,
    closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
    closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
    closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
    drainSessionStoreDependentCloseWork: () => deps.runtime.drainSessionStoreDependentCloseWork(),
    logger: deps.logger,
    timeoutMs: deps.sessionResourceCloseTimeoutMs,
  });
}

async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // 第一拍先关闭 runtime admission；后续 execution cancel 只能收口状态，不能再唤醒模型。
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  let browserCloseFailure: unknown;
  const closeBrowserSession = async (): Promise<void> => {
    try {
      await input.closeBrowserSession();
    } catch (error) {
      // Browser facade 的 ephemeral backend 错误已在 Runtime 内收敛；这里剩下的拒绝来自
      // session-store-dependent release/drain，不能在 helper 记录后静默关 store。
      browserCloseFailure = error;
      throw error;
    }
  };
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // 旧关闭链串行 await；Browser close 永不 settle 时，Execution/MCP 永远不会执行。
  // 各 owner 并行、独立带 deadline；它们都启动并越过同步 retain 点后才 stable drain，
  // 否则空集合会先返回，资源随后登记的 store work 就会落到已关闭 store。
  const resourceCloses = Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );
  await resourceCloses;
  await input.drainSessionStoreDependentCloseWork();
  if (browserCloseFailure !== undefined) throw browserCloseFailure;

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}
