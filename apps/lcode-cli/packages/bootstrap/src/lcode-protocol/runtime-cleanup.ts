import type { Logger, McpPort, ProtocolShutdownContext } from "@lcode/contracts";
import { redactTelemetryText } from "@lcode/shared";
import type { McpConnectionPool, McpTelemetryTracker } from "@lcode/adapters/mcp";
import type { SqliteSessionStore } from "@lcode/adapters/storage";
import { shutdownPreparedModelTelemetry } from "@lcode/telemetry";
import { closeSessionStore } from "../app/session-store.js";
import type { NodeReplBrowserBroker } from "../app/node-repl-browser-broker.js";
import type { LCodeProcessResourceSampler } from "../process-resource-sampler.js";
import type { LCodeProtocolAgentServer } from "./server.js";

const DEFAULT_CLEANUP_BUDGET_MS = 1_200;
const CLEANUP_STEP_BUDGET_MS = 400;
const CLEANUP_PENDING = Symbol("cleanup_pending");
const CLEANUP_CAUSE_LIMIT = 4;
const CLEANUP_CODE_LIMIT = 128;

export async function cleanupProtocolRuntime(options: {
  logger: Logger;
  deadlineAt?: number;
  shutdownContext?: ProtocolShutdownContext;
  server?: Pick<LCodeProtocolAgentServer, "shutdown" | "disposeProjections">;
  processResourceSampler?: Pick<LCodeProcessResourceSampler, "stop">;
  mcpTelemetryTracker?: Pick<McpTelemetryTracker, "stop">;
  nodeReplBrowserBroker?: Pick<NodeReplBrowserBroker, "close">;
  mcpPort?: Pick<McpPort, "close">;
  mcpConnectionPool?: Pick<McpConnectionPool, "close">;
  sessionStore?: SqliteSessionStore;
  providerRegistryRuntime?: { dispose(): unknown };
}): Promise<void> {
  const deadline = options.deadlineAt ?? Date.now() + DEFAULT_CLEANUP_BUDGET_MS;
  const closeContext = options.shutdownContext ?? { origin: "unknown", processId: process.pid };
  const results: Array<{ resource: string; status: "completed" | "failed" | "pending" }> = [];
  const summary = () =>
    options.logger.info("Protocol cleanup summary", {
      ...closeContext,
      event: "lcode_protocol.close.summary",
      results,
      remainingMs: Math.max(0, deadline - Date.now()),
    });
  options.logger.info("Protocol cleanup started", {
    ...closeContext,
    event: "lcode_protocol.close.requested",
    phase: "quiescing",
  });
  const warnCleanupFailure = (resource: string, error: unknown): void => {
    options.logger.warn(`LCode Protocol ${resource} shutdown failed`, {
      errorType: error instanceof Error ? error.name : typeof error,
      errorDetail: redactTelemetryText(error instanceof Error ? error.message : String(error)),
      ...(error instanceof Error && "code" in error && typeof error.code === "string"
        ? { errorCode: error.code.slice(0, CLEANUP_CODE_LIMIT) }
        : {}),
      causes: cleanupCauses(error),
      event: `lcode_protocol.${resource}.shutdown.failed`,
      module: "bootstrap.lcode_protocol",
      ...closeContext,
    });
  };
  const step = async (resource: string, cleanup: () => unknown | Promise<unknown>) => {
    let timeout: NodeJS.Timeout | undefined;
    let status: "completed" | "failed" | "pending" = "completed";
    try {
      // 共用绝对 deadline；某项失败/挂起不阻止其余资源被尝试，也不逐项续时。
      const outcome = await Promise.race([
        Promise.resolve().then(cleanup),
        new Promise<typeof CLEANUP_PENDING>((resolve) => {
          timeout = setTimeout(
            () => resolve(CLEANUP_PENDING),
            Math.max(0, Math.min(CLEANUP_STEP_BUDGET_MS, deadline - Date.now())),
          );
        }),
      ]);
      if (outcome === CLEANUP_PENDING) {
        status = "pending";
        options.logger.warn("Protocol cleanup remains pending", {
          ...closeContext,
          event: `lcode_protocol.${resource}.shutdown.pending`,
          phase: "draining",
          remainingMs: Math.max(0, deadline - Date.now()),
        });
        return { status: "pending" as const };
      }
      return { status: "completed" as const };
    } catch (error) {
      status = "failed";
      warnCleanupFailure(resource, error);
      return { error, status: "failed" as const };
    } finally {
      results.push({ resource, status });
      if (timeout) clearTimeout(timeout);
    }
  };
  let sessionShutdown: Promise<unknown> | undefined;
  const shutdownSessions = (): Promise<unknown> => {
    sessionShutdown ??= Promise.resolve().then(() => options.server?.shutdown());
    return sessionShutdown;
  };
  await Promise.all([
    step("sampler", () => options.processResourceSampler?.stop()),
    step("mcp_telemetry", () => options.mcpTelemetryTracker?.stop()),
  ]);
  const sessionStepResult = await step("sessions", shutdownSessions);
  await step("projections", () => options.server?.disposeProjections());
  await Promise.all([
    step("node_repl_browser_broker", () => options.nodeReplBrowserBroker?.close()),
    // 不能在同一个 finally 内 await：port 挂起时 pool 仍必须得到 close。
    step("mcp", () => options.mcpPort?.close()),
    step("mcp_pool", () => options.mcpConnectionPool?.close()),
  ]);
  await Promise.all([
    step("provider_registry", () => options.providerRegistryRuntime?.dispose()),
    step("telemetry", () => shutdownPreparedModelTelemetry()),
  ]);
  let shutdownFailure: { error: unknown } | undefined;
  try {
    // 单步 budget 只负责让其它资源继续关闭；store 必须等同一个 shutdown 真正 settle，
    // 否则 session finalizer 可能在 SQLite 已关闭后继续写入。
    await shutdownSessions();
  } catch (error) {
    // 若第一次只记录了 budget 超时，最终 reject 也要落日志；同一即时 reject 不重复记录。
    if (sessionStepResult.status !== "failed" || sessionStepResult.error !== error) {
      warnCleanupFailure("sessions", error);
    }
    shutdownFailure = { error };
  }
  // App 关闭失败时原 owner 仍可能需要此共享连接重试退休，不能绕过 facade 保护关库。
  if (shutdownFailure) {
    summary();
    throw shutdownFailure.error;
  }
  const storeResult = await step("session_store", () => {
    if (options.sessionStore) closeSessionStore(options.sessionStore);
  });
  summary();
  if (storeResult.status === "failed") throw storeResult.error;
}

function cleanupCauses(error: unknown): string[] {
  const pending: unknown[] =
    error instanceof AggregateError
      ? [...error.errors].slice(0, CLEANUP_CAUSE_LIMIT)
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  const seen = new Set<unknown>([error]);
  const causes: string[] = [];
  while (pending.length && causes.length < CLEANUP_CAUSE_LIMIT) {
    const cause = pending.shift();
    if (seen.has(cause)) continue;
    seen.add(cause);
    causes.push(redactTelemetryText(cause instanceof Error ? cause.message : String(cause)));
    if (cause instanceof Error && cause.cause !== undefined) pending.push(cause.cause);
  }
  return causes;
}
