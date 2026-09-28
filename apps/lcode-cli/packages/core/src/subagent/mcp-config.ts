import type { McpServerStatus } from "@lcode/contracts";
import { matchesModelVisibleMcpServerName } from "../mcp/name.js";

export function matchesRequiredMcpServer(
  requiredName: string,
  statuses: Record<string, McpServerStatus>,
): boolean {
  if (requiredName === "*") {
    return Object.values(statuses).some((status) => status.status === "connected");
  }
  const expected = requiredName.toLowerCase();
  return Object.entries(statuses).some(
    ([serverName, status]) =>
      status.status === "connected" &&
      // MCP tool name 会把 plugin:android-emulator:android-emulator
      // 规范化成 plugin_android-emulator_android-emulator；required-server 检查
      // 必须使用同一套模型可见命名规则，否则已连接的 plugin MCP 会被误判为 missing。
      matchesModelVisibleMcpServerName(expected, serverName),
  );
}

export function extractRequiredMcpServerNames(allowedTools: readonly string[]): string[] {
  const names = new Set<string>();
  for (const tool of allowedTools) {
    const requiredName = extractRequiredMcpServerName(tool);
    if (requiredName) names.add(requiredName);
  }
  return [...names];
}

function extractRequiredMcpServerName(tool: string): string | undefined {
  const trimmed = tool.trim();
  if (trimmed === "mcp__*" || trimmed === "mcp") return "*";
  if (!trimmed.startsWith("mcp__")) return undefined;
  const [, serverName] = trimmed.split("__");
  return serverName && serverName.length > 0 ? serverName : undefined;
}
