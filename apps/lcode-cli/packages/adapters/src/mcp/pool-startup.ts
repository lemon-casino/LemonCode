import type { McpServerConfig, McpServerStatus } from "@lcode/contracts";

/** 工具已注册但尚未使用不是启动失败；统计只能派生自原 pool/adapter owner 的状态。 */
export function summarizeMcpPoolStartup(
  servers: ReadonlyMap<string, McpServerConfig>,
  statuses: Record<string, McpServerStatus>,
) {
  const enabled = [...servers].filter(([, config]) => config.enabled !== false);
  const connectedCount = enabled.filter(([name]) => statuses[name]?.status === "connected").length;
  const deferredCount = enabled.filter(
    ([name, config]) =>
      config.source?.kind === "builtin" &&
      config.onDemandTools &&
      statuses[name]?.status === "disconnected" &&
      !statuses[name]?.error,
  ).length;
  return {
    configuredCount: enabled.length,
    connectedCount,
    failedCount: enabled.length - connectedCount - deferredCount,
    processCount: enabled.filter(
      ([name, config]) => config.type === "stdio" && statuses[name]?.status === "connected",
    ).length,
  };
}
