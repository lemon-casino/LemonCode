import type { McpTrackedProcess } from "@lcode/adapters";
import type { LCodeProcessChildProcessesResult } from "@lcode/shared";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";

/**
 * `process/childProcesses`：把 MCP 进程注册表内存里的子进程映射整理成协议结果。
 * 只做归属补齐（builtin host MCP → 官方插件名），不做任何 I/O；CPU/内存采样由桌面 Host 完成。
 */
export function listChildProcesses(
  tracked: readonly McpTrackedProcess[],
): LCodeProcessChildProcessesResult {
  return {
    processes: tracked.map((process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
      };
    }),
  };
}
