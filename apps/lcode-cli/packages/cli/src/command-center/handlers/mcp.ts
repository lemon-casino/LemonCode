import type { TuiSubmitPromptResult } from "@lcode/tui";
import type { CommandCenterDeps, CommandCenterMcpStatus } from "../types.js";
import { splitArgs } from "../utils.js";

const MCP_COMMAND_USAGE = "Usage: /mcp [list|status|connect <server>|disconnect <server>]";

export async function handleMcpCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const [action = "list", serverName] = splitArgs(args);

  if (action === "list" || action === "status") {
    if (!app.listMcpServers) {
      return {
        mode: deps.getMode?.(),
        response: "MCP is not available in this client.",
      };
    }

    const statuses = await app.listMcpServers();
    return {
      mode: deps.getMode?.(),
      response: formatMcpStatusList(statuses),
    };
  }

  if (action === "connect") {
    if (!serverName) {
      return {
        mode: deps.getMode?.(),
        response: MCP_COMMAND_USAGE,
      };
    }
    if (!app.connectMcpServer) {
      return {
        mode: deps.getMode?.(),
        response: "MCP connection management is not available in this client.",
      };
    }
    try {
      const status = await app.connectMcpServer(serverName);
      return {
        mode: deps.getMode?.(),
        response: `MCP server ${formatMcpStatusLine(serverName, status)}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        mode: deps.getMode?.(),
        response: `Unable to connect MCP server ${serverName}: ${message}`,
      };
    }
  }

  if (action === "disconnect") {
    if (!serverName) {
      return {
        mode: deps.getMode?.(),
        response: MCP_COMMAND_USAGE,
      };
    }
    if (!app.disconnectMcpServer) {
      return {
        mode: deps.getMode?.(),
        response: "MCP connection management is not available in this client.",
      };
    }
    const status = await app.disconnectMcpServer(serverName);
    return {
      mode: deps.getMode?.(),
      response: status
        ? `MCP server ${formatMcpStatusLine(serverName, status)}.`
        : `MCP server is not connected: ${serverName}`,
    };
  }

  return {
    mode: deps.getMode?.(),
    response: MCP_COMMAND_USAGE,
  };
}

function formatMcpStatusList(statuses: Record<string, CommandCenterMcpStatus>): string {
  const entries = Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "No MCP servers configured.";
  }

  return [
    "MCP servers:",
    ...entries.map(([name, status]) => `- ${formatMcpStatusLine(name, status)}`),
  ].join("\n");
}

function formatMcpStatusLine(name: string, status: CommandCenterMcpStatus): string {
  const toolCount = status.toolCount === 1 ? "1 tool" : `${status.toolCount} tools`;
  const error = status.error ? ` (${status.error})` : "";
  return `${name}: ${status.status} via ${status.transport}; ${toolCount}${error}`;
}
