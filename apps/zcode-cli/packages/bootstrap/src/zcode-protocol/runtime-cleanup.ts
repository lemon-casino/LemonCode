import type { Logger, McpPort } from "@zcode/contracts";
import type { McpConnectionPool, McpTelemetryTracker } from "@zcode/adapters/mcp";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { shutdownPreparedModelTelemetry } from "@zcode/telemetry";
import { closeSessionStore } from "../app/session-store.js";
import type { NodeReplBrowserBroker } from "../app/node-repl-browser-broker.js";
import type { ZCodeProcessResourceSampler } from "../process-resource-sampler.js";
import type { ZCodeProtocolAgentServer } from "./server.js";

const DEFAULT_CLEANUP_BUDGET_MS = 1_200;
const CLEANUP_STEP_BUDGET_MS = 400;

export async function cleanupProtocolRuntime(options: {
  logger: Logger;
  deadlineAt?: number;
  server?: Pick<ZCodeProtocolAgentServer, "shutdown" | "disposeProjections">;
  processResourceSampler?: Pick<ZCodeProcessResourceSampler, "stop">;
  mcpTelemetryTracker?: Pick<McpTelemetryTracker, "stop">;
  nodeReplBrowserBroker?: Pick<NodeReplBrowserBroker, "close">;
  mcpPort?: Pick<McpPort, "close">;
  mcpConnectionPool?: Pick<McpConnectionPool, "close">;
  sessionStore?: SqliteSessionStore;
  providerRegistryRuntime?: { dispose(): unknown };
}): Promise<void> {
  const deadline = options.deadlineAt ?? Date.now() + DEFAULT_CLEANUP_BUDGET_MS;
  const warnCleanupFailure = (resource: string, error: unknown): void => {
    options.logger.warn(`ZCode Protocol ${resource} shutdown failed`, {
      errorType: error instanceof Error ? error.name : typeof error,
      event: `zcode_protocol.${resource}.shutdown.failed`,
      module: "bootstrap.zcode_protocol",
    });
  };
  const step = async (resource: string, cleanup: () => unknown | Promise<unknown>) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      // 共用绝对 deadline；某项失败/挂起不阻止其余资源被尝试，也不逐项续时。
      await Promise.race([
        Promise.resolve().then(cleanup),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Protocol cleanup timed out")),
            Math.max(0, Math.min(CLEANUP_STEP_BUDGET_MS, deadline - Date.now())),
          );
        }),
      ]);
      return { status: "completed" as const };
    } catch (error) {
      warnCleanupFailure(resource, error);
      return { error, status: "failed" as const };
    } finally {
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
  try {
    // 单步 budget 只负责让其它资源继续关闭；store 必须等同一个 shutdown 真正 settle，
    // 否则 session finalizer 可能在 SQLite 已关闭后继续写入。
    await shutdownSessions();
  } catch (error) {
    // 若第一次只记录了 budget 超时，最终 reject 也要落日志；同一即时 reject 不重复记录。
    if (sessionStepResult.status !== "failed" || sessionStepResult.error !== error) {
      warnCleanupFailure("sessions", error);
    }
  }
  await step("session_store", () => {
    if (options.sessionStore) closeSessionStore(options.sessionStore);
  });
}
