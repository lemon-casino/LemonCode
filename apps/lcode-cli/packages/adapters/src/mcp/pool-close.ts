import type { Logger, McpPort } from "@lcode/contracts";
import type { McpConnectionContext } from "./pool-identity.js";
import type { McpTelemetryTracker } from "./telemetry.js";

export interface McpPoolCloseEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  key: string;
  managed: boolean;
  refs: Set<string>;
  serverName: string;
  closing?: Promise<void>;
}

export interface McpPoolCloseOptions {
  entries: Map<string, McpPoolCloseEntry>;
  idleGraceMs: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
}

export function closeMcpPoolEntry(
  options: McpPoolCloseOptions,
  entry: McpPoolCloseEntry,
): Promise<void> {
  if (entry.closing) return entry.closing;
  const startedAt = Date.now();
  if (entry.closeTimer) clearTimeout(entry.closeTimer);
  entry.closeTimer = undefined;
  if (!entry.managed && options.entries.get(entry.key) === entry) options.entries.delete(entry.key);
  entry.closing = (async () => {
    try {
      await entry.adapter.close();
      if (options.entries.get(entry.key) === entry) options.entries.delete(entry.key);
      options.telemetry?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
      options.logger?.info("MCP pooled connection closed", {
        ...entry.connectionContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.pool.connection.closed",
        mcpServerName: entry.serverName,
        status: "completed",
      });
    } catch (error) {
      options.logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.pool.connection.close.failed",
        mcpServerName: entry.serverName,
      });
      if (entry.managed) throw error;
      options.telemetry?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
    }
  })().finally(() => {
    entry.closing = undefined;
  });
  return entry.closing;
}

export function scheduleMcpPoolEntryClose(
  options: McpPoolCloseOptions,
  entry: McpPoolCloseEntry,
): void {
  if (entry.closeTimer) return;
  if (options.idleGraceMs <= 0) {
    void closeMcpPoolEntry(options, entry);
    return;
  }
  entry.closeTimer = setTimeout(() => {
    entry.closeTimer = undefined;
    if (entry.refs.size === 0) void closeMcpPoolEntry(options, entry);
  }, options.idleGraceMs);
  entry.closeTimer.unref?.();
}
