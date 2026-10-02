import { randomUUID } from "node:crypto";
import type {
  Logger,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
} from "@lcode/contracts";
import type { OfficialMcpAuthFailureKind } from "@lcode/shared";
import type { SharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import type { CreateMcpAdapterOptions, McpServerRecord } from "./adapter-types.js";
import type { McpAdapterOwner } from "./adapter-owner.js";
import {
  connectConfiguredServers,
  connectServer,
  disconnectServer,
  pingServer,
  waitForSharedConnection,
} from "./adapter-connections.js";
import {
  callTool,
  callToolOnClient,
  reconnectForCall,
  recoverToolCallAuthorization,
} from "./adapter-calls.js";
import { openServerConnection, failConnection } from "./adapter-handshake.js";
import {
  ensureToolCallAuthorizationRecovery,
  runToolCallAuthorizationRecovery,
  runInteractiveOAuthAuthorization,
} from "./adapter-oauth-recovery.js";
import {
  rememberServerResponse,
  takeServerRequestId,
  resolveOfficialStdioAuthMeta,
  createOfficialAuthFetch,
} from "./adapter-official-auth.js";
import {
  createTransport,
  createOAuthClientProvider,
  resolveCredentialStore,
  createAuthorizationCodeOAuthOptions,
} from "./adapter-transport.js";
import {
  attachStdioLogging,
  closeRecord,
  closeClientAndTransport,
  terminateStdioProcessTree,
} from "./adapter-cleanup.js";

export type { CreateMcpAdapterOptions } from "./adapter-types.js";

export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";

export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

class NodeMcpAdapter implements McpAdapterOwner {
  readonly adapterInstanceId = randomUUID();

  readonly clientName: string;

  readonly clientVersion: string;

  readonly connectionContext?: McpConnectionContext;

  readonly env?: NodeJS.ProcessEnv;

  readonly logger?: Logger;

  readonly mcpOAuth?: McpOAuthRuntimeOptions;

  readonly network?: NetworkEgressEnvPolicy;

  readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];

  readonly telemetry?: McpTelemetryTracker;

  readonly connectionGenerations = new Map<string, number>();

  credentialStore?: SharedLCodeCredentialStore;

  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();

  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  readonly serverRequestIdBySpan = new Map<string, string>();

  readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();

  readonly records = new Map<string, McpServerRecord>();

  readonly workingDirectory?: string;

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "lcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
  }

  readonly connectConfiguredServers: McpAdapterOwner["connectConfiguredServers"] =
    connectConfiguredServers;

  readonly connectServer: McpAdapterOwner["connectServer"] = connectServer;

  readonly disconnectServer: McpAdapterOwner["disconnectServer"] = disconnectServer;

  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  readonly pingServer: McpAdapterOwner["pingServer"] = pingServer;

  async listTools(): Promise<McpToolDescriptor[]> {
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  readonly callTool: McpAdapterOwner["callTool"] = callTool;

  readonly rememberServerResponse: McpAdapterOwner["rememberServerResponse"] =
    rememberServerResponse;

  readonly takeServerRequestId: McpAdapterOwner["takeServerRequestId"] = takeServerRequestId;

  readonly resolveOfficialStdioAuthMeta: McpAdapterOwner["resolveOfficialStdioAuthMeta"] =
    resolveOfficialStdioAuthMeta;

  readonly callToolOnClient: McpAdapterOwner["callToolOnClient"] = callToolOnClient;

  readonly reconnectForCall: McpAdapterOwner["reconnectForCall"] = reconnectForCall;

  readonly recoverToolCallAuthorization: McpAdapterOwner["recoverToolCallAuthorization"] =
    recoverToolCallAuthorization;

  readonly ensureToolCallAuthorizationRecovery: McpAdapterOwner["ensureToolCallAuthorizationRecovery"] =
    ensureToolCallAuthorizationRecovery;

  readonly runToolCallAuthorizationRecovery: McpAdapterOwner["runToolCallAuthorizationRecovery"] =
    runToolCallAuthorizationRecovery;

  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  readonly waitForSharedConnection: McpAdapterOwner["waitForSharedConnection"] =
    waitForSharedConnection;

  readonly openServerConnection: McpAdapterOwner["openServerConnection"] = openServerConnection;

  readonly runInteractiveOAuthAuthorization: McpAdapterOwner["runInteractiveOAuthAuthorization"] =
    runInteractiveOAuthAuthorization;

  readonly failConnection: McpAdapterOwner["failConnection"] = failConnection;

  readonly createTransport: McpAdapterOwner["createTransport"] = createTransport;

  readonly createOfficialAuthFetch: McpAdapterOwner["createOfficialAuthFetch"] =
    createOfficialAuthFetch;

  readonly createOAuthClientProvider: McpAdapterOwner["createOAuthClientProvider"] =
    createOAuthClientProvider;

  readonly resolveCredentialStore: McpAdapterOwner["resolveCredentialStore"] =
    resolveCredentialStore;

  readonly createAuthorizationCodeOAuthOptions: McpAdapterOwner["createAuthorizationCodeOAuthOptions"] =
    createAuthorizationCodeOAuthOptions;

  readonly attachStdioLogging: McpAdapterOwner["attachStdioLogging"] = attachStdioLogging;

  readonly closeRecord: McpAdapterOwner["closeRecord"] = closeRecord;

  readonly closeClientAndTransport: McpAdapterOwner["closeClientAndTransport"] =
    closeClientAndTransport;

  readonly terminateStdioProcessTree: McpAdapterOwner["terminateStdioProcessTree"] =
    terminateStdioProcessTree;

  nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    return generation;
  }

  isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}
