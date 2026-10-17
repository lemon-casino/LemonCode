import type { ProjectContextSnapshot } from "@lcode/shared";
import type { TraceContext, McpServerConfig } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

/** 只在既有 turn admission 后收敛本会话 MCP；不使用设置页的进程级连接 owner。 */
export async function prepareProjectFilesystemMcp(
  runtime: AgentRuntimeInternal,
  snapshot: ProjectContextSnapshot | undefined,
  trace: TraceContext,
) {
  const mcp = runtime.config.mcp;
  if (!runtime.mcpPort || mcp?.enabled === false || !mcp?.servers) return;
  const paths = snapshot?.members.map((member) => member.workspacePath) ?? [
    runtime.workingDirectory,
  ];
  const names: string[] = [];
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(mcp.servers)) {
    const index =
      config.type === "stdio"
        ? (config.args?.findIndex((arg) =>
            arg.includes("@modelcontextprotocol/server-filesystem"),
          ) ?? -1)
        : -1;
    if (index < 0) {
      if (name === "filesystem")
        throw new Error(
          "Project collaboration requires an explicitly scoped filesystem MCP command",
        );
      servers[name] = config;
      continue;
    }
    names.push(name);
    const stdio = config as Extract<McpServerConfig, { type: "stdio" }>;
    servers[name] = { ...stdio, args: [...stdio.args!.slice(0, index + 1), ...new Set(paths)] };
  }
  if (
    !names.length ||
    (runtime.mcpToolsRegistered &&
      names.every((name) => JSON.stringify(servers[name]) === JSON.stringify(mcp.servers![name])))
  )
    return;
  // 中文依据：预热的旧连接可晚到；先等其原 promise，再由同一 session owner 以新根目录替换，避免旧授权反写。
  await runtime.mcpStartupPromise;
  runtime.config = { ...runtime.config, mcp: { ...mcp, servers } };
  runtime.mcpInitialized = false;
  runtime.mcpToolsRegistered = false;
  runtime.mcpStartupPromise = undefined;
  const connected = await runtime.startMcpStartup(trace);
  for (const name of names) {
    const status = connected?.statuses[name];
    if (status?.status !== "connected")
      throw new Error(`Filesystem MCP ${name} could not adopt the frozen project directories`);
  }
  await runtime.initializeMcp(trace);
}
