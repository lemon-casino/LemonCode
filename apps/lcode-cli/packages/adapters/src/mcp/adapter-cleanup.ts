import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import {
  MCP_STDIO_STDERR_LOG_MAX_CHARS,
  createBoundedTextBuffer,
  getStdioTransportPid,
  sanitizeMcpStdioStderr,
} from "./adapter-stdio-diagnostics.js";
import type { McpClient, McpTransport } from "./adapter-types.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpCleanupContext = Pick<
  McpAdapterOwner,
  | "logger"
  | "records"
  | "closeClientAndTransport"
  | "terminateStdioProcessTree"
  | "connectionContext"
  | "telemetry"
>;

export function attachStdioLogging(
  this: McpCleanupContext,
  name: string,
  transport: McpTransport,
): () => string | undefined {
  const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
  const stderr = (
    transport as {
      stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
    }
  ).stderr;
  stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuffer.append(text);
    this.logger?.debug("MCP stdio stderr", {
      event: "mcp.stdio.stderr",
      mcpServerName: name,
      stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
    });
  });
  return () => {
    const text = stderrBuffer.read();
    if (!text) return undefined;
    // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
    // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
    return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
  };
}

export async function closeRecord(this: McpCleanupContext, name: string): Promise<void> {
  const record = this.records.get(name);
  if (!record) return;
  record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
  if (!record.client && !record.transport) return;
  await this.closeClientAndTransport(name, record.client, record.transport);
}

export async function closeClientAndTransport(
  this: McpCleanupContext,
  name: string,
  client?: McpClient,
  transport?: McpTransport,
): Promise<void> {
  const startedAt = Date.now();
  const mcpTransportPid = getStdioTransportPid(transport);
  // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
  if (client) client.onclose = undefined;
  // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
  // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
  await this.terminateStdioProcessTree(name, transport);

  try {
    await client?.close();
  } catch (error) {
    this.logger?.debug("MCP client close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.client.close.failed",
      mcpServerName: name,
    });
  }

  try {
    await transport?.close();
  } catch (error) {
    this.logger?.debug("MCP transport close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.transport.close.failed",
      mcpServerName: name,
    });
  }
  if (
    this.connectionContext &&
    transport instanceof ProcessTreeStdioClientTransport &&
    !transport.processAlive
  ) {
    this.telemetry?.recordProcessClosed({
      connectionId: this.connectionContext.mcpConnectionId,
    });
  }
  this.logger?.info("MCP server closed", {
    ...this.connectionContext,
    durationMs: Date.now() - startedAt,
    event: "mcp.server.closed",
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "completed",
  });
}

export async function terminateStdioProcessTree(
  this: McpCleanupContext,
  name: string,
  transport?: McpTransport,
): Promise<void> {
  const pid = getStdioTransportPid(transport);
  if (pid == null) return;

  try {
    await terminateMcpStdioProcessTree(pid);
  } catch (error) {
    this.logger?.warn("MCP stdio process tree cleanup failed", {
      ...this.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.stdio.process_tree_cleanup.failed",
      mcpServerName: name,
      mcpTransportPid: pid,
      pid,
      status: "failed",
    });
  }
}
