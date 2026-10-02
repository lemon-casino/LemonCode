import { isDeepStrictEqual } from "node:util";
import type {
  McpConnectOptions,
  McpConnectionSnapshot,
  McpServerConfig,
  McpServerStatus,
} from "@lcode/contracts";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_PING_TIMEOUT_MS,
  type McpServerRecord,
} from "./adapter-types.js";
import { isPeerAnsweredError } from "./adapter-protocol.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpConnectionsContext = Pick<
  McpAdapterOwner,
  | "logger"
  | "records"
  | "disconnectServer"
  | "waitForSharedConnection"
  | "connectServer"
  | "status"
  | "listTools"
  | "nextConnectionGeneration"
  | "lastOfficialAuthKind"
  | "connectionDiagnosticByServer"
  | "closeRecord"
  | "createStatus"
  | "openServerConnection"
  | "connectionGenerations"
  | "isCurrentConnection"
  | "connectionContext"
>;

export async function connectConfiguredServers(
  this: McpConnectionsContext,
  servers: Record<string, McpServerConfig>,
  options: McpConnectOptions = {},
): Promise<McpConnectionSnapshot> {
  const startedAt = Date.now();
  const serverNames = Object.keys(servers);
  this.logger?.info("MCP configured servers connection started", {
    event: "mcp.configured_servers.connect.started",
    serverCount: serverNames.length,
    serverNames,
    status: "started",
  });
  const configuredNames = new Set(Object.keys(servers));
  await Promise.all(
    Array.from(this.records.keys())
      .filter((name) => !configuredNames.has(name))
      .map((name) => this.disconnectServer(name)),
  );

  await Promise.all(
    Object.entries(servers).map(([name, config]) => {
      const record = this.records.get(name);
      if (
        record?.connecting &&
        record.status.status === "connecting" &&
        record.status.authorization &&
        isDeepStrictEqual(record.config, config)
      ) {
        // 相同配置的全量收敛可能与 OAuth callback 等待重叠；重新 connect
        // 会关闭原 session，使浏览器中已打开的授权 URL、PKCE/state 和 callback 一并失效。
        // 连接生命周期可以共享，但 Session 的 15 秒等待预算和 AbortSignal 不能继承设置页的 5 分钟预算。
        return this.waitForSharedConnection(name, record, options);
      }
      return this.connectServer(name, config, options);
    }),
  );

  const statuses = await this.status();
  const tools = await this.listTools();
  const statusCounts = Object.values(statuses).reduce<Record<string, number>>((counts, status) => {
    counts[status.status] = (counts[status.status] ?? 0) + 1;
    return counts;
  }, {});
  this.logger?.info("MCP configured servers connection completed", {
    durationMs: Date.now() - startedAt,
    event: "mcp.configured_servers.connect.completed",
    serverCount: serverNames.length,
    status: "completed",
    statusCounts,
    toolCount: tools.length,
  });
  return {
    statuses,
    tools,
  };
}

export async function connectServer(
  this: McpConnectionsContext,
  name: string,
  config: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const generation = this.nextConnectionGeneration(name);
  this.lastOfficialAuthKind.delete(name);
  this.connectionDiagnosticByServer.delete(name);
  this.logger?.info("MCP server connection started", {
    event: "mcp.server.connect.started",
    mcpServerName: name,
    status: "started",
    timeoutMs,
    transport: config.type,
  });
  await this.closeRecord(name);

  if (config.enabled === false) {
    const status = this.createStatus(config, "disabled");
    this.records.set(name, { config, status, tools: [] });
    this.logger?.info("MCP server connection skipped", {
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connect.skipped",
      mcpServerName: name,
      status: "completed",
      transport: config.type,
    });
    return status;
  }

  const abortController = new AbortController();
  const abortExternal = () => {
    abortController.abort(
      options.signal?.reason instanceof Error ? options.signal.reason : undefined,
    );
  };
  if (options.signal?.aborted) {
    abortExternal();
  } else {
    options.signal?.addEventListener("abort", abortExternal, { once: true });
  }

  const connectingStatus = this.createStatus(config, "connecting");
  const record: McpServerRecord = {
    abortController,
    config,
    status: connectingStatus,
    tools: [],
  };
  this.records.set(name, record);
  const connecting = this.openServerConnection({
    config,
    generation,
    name,
    oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
    signal: abortController.signal,
    timeoutMs,
    workingDirectory: options.workingDirectory,
  }).finally(() => {
    options.signal?.removeEventListener("abort", abortExternal);
  });
  record.connecting = connecting;
  // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
  // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
  // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
  // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
  return await this.waitForSharedConnection(name, record, options);
}

export async function disconnectServer(
  this: McpConnectionsContext,
  name: string,
): Promise<McpServerStatus | undefined> {
  const record = this.records.get(name);
  if (!record) return undefined;

  this.nextConnectionGeneration(name);
  await this.closeRecord(name);
  const status = this.createStatus(record.config, "disconnected");
  this.records.set(name, {
    config: record.config,
    status,
    tools: [],
  });
  return status;
}

// HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
// connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
// ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
export async function pingServer(
  this: McpConnectionsContext,
  name: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const record = this.records.get(name);
  if (!record?.client || record.status.status !== "connected") {
    return false;
  }
  const timeoutMs = Math.min(
    options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
    record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
  );
  const generation = this.connectionGenerations.get(name) ?? 0;
  try {
    await record.client.ping({ timeout: timeoutMs });
    return true;
  } catch (error) {
    // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
    if (isPeerAnsweredError(error)) {
      return true;
    }
    if (!this.isCurrentConnection(name, generation)) return false;
    const current = this.records.get(name);
    if (current && current.client === record.client) {
      current.status = this.createStatus(current.config, "disconnected", {
        error: "MCP server did not answer ping",
        failureKind: "unexpected_disconnect",
      });
    }
    this.logger?.warn("MCP server ping failed", {
      ...this.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.server.ping.failed",
      mcpServerName: name,
      status: "failed",
      transport: record.config.type,
    });
    return false;
  }
}

export function waitForSharedConnection(
  this: McpConnectionsContext,
  name: string,
  record: McpServerRecord,
  options: McpConnectOptions,
): Promise<McpServerStatus> {
  const connecting = record.connecting;
  if (!connecting) return Promise.resolve(record.status);
  if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
    return connecting;
  }

  let abortHandler: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const currentStatus = () => this.records.get(name)?.status ?? record.status;
  const waiters: Promise<McpServerStatus>[] = [connecting];

  const timeoutMs = options.oauthAuthorizationTimeoutMs;
  if (timeoutMs !== undefined) {
    waiters.push(
      new Promise((resolvePromise) => {
        timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
      }),
    );
  }
  if (options.signal) {
    waiters.push(
      new Promise((resolvePromise) => {
        if (options.signal?.aborted) {
          resolvePromise(currentStatus());
          return;
        }
        abortHandler = () => resolvePromise(currentStatus());
        options.signal?.addEventListener("abort", abortHandler, {
          once: true,
        });
      }),
    );
  }

  return Promise.race(waiters).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
  });
}
