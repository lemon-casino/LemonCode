import { Client } from "@modelcontextprotocol/client";
import type { McpServerConfig, McpServerStatus } from "@lcode/contracts";
import { LCODE_OFFICIAL_MCP_AUTH_TYPE, type McpServerFailureKind } from "@lcode/shared";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import { classifyInteractiveAuthorizationTrigger } from "./oauth-errors.js";
import { OfficialMcpAuthError } from "./official-auth.js";
import { McpTimeoutError, withTimeout } from "./timeout.js";
import {
  formatVersionNegotiationMode,
  isProtocolNegotiationFailure,
  resolveAuthorizationCodeOAuthConfig,
  resolveVersionNegotiation,
} from "./adapter-protocol.js";
import {
  getStdioTransportExitInfo,
  getStdioTransportPid,
  isStdioTransportProcessAlive,
} from "./adapter-stdio-diagnostics.js";
import type { McpClient, McpTransport } from "./adapter-types.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpHandshakeContext = Pick<
  McpAdapterOwner,
  | "createTransport"
  | "attachStdioLogging"
  | "clientName"
  | "clientVersion"
  | "updateCurrentRecord"
  | "createStatus"
  | "isCurrentConnection"
  | "closeClientAndTransport"
  | "records"
  | "connectionDiagnosticByServer"
  | "connectionContext"
  | "telemetry"
  | "logger"
  | "runInteractiveOAuthAuthorization"
  | "openServerConnection"
  | "failConnection"
  | "lastOfficialAuthKind"
>;

export async function openServerConnection(
  this: McpHandshakeContext,
  input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  },
): Promise<McpServerStatus> {
  const {
    config,
    generation,
    name,
    oauthAuthorizationAttempted = false,
    oauthAuthorizationTimeoutMs,
    signal,
    timeoutMs,
    workingDirectory,
  } = input;
  const startedAt = Date.now();
  let client: McpClient | undefined;
  let connectDurationMs: number | undefined;
  let getRecentStderr: (() => string | undefined) | undefined;
  let listToolsDurationMs: number | undefined;
  let transport: McpTransport | undefined;
  let failureKind: McpServerFailureKind =
    config.type === "stdio" ? "process_start_failed" : "network_unreachable";

  try {
    const transportBundle = await this.createTransport(
      config,
      name,
      generation,
      oauthAuthorizationTimeoutMs,
      workingDirectory,
      signal,
    );
    transport = transportBundle.transport;
    getRecentStderr = this.attachStdioLogging(name, transport);
    client = new Client(
      {
        name: this.clientName,
        version: this.clientVersion,
      },
      {
        versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
      },
    );
    this.updateCurrentRecord(name, generation, {
      client,
      transport,
    });

    const connectStartedAt = Date.now();
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      `MCP server ${name} connection timed out after ${timeoutMs}ms`,
      signal,
    );
    connectDurationMs = Date.now() - connectStartedAt;

    failureKind = "tool_list_failed";
    const listToolsStartedAt = Date.now();
    const listed = await withTimeout(
      client.listTools(),
      timeoutMs,
      `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
      signal,
    );
    listToolsDurationMs = Date.now() - listToolsStartedAt;
    const tools = listed.tools.map((tool) =>
      normalizeMcpToolDescriptor(
        name,
        tool,
        config.timeoutMs,
        // 只有 http 形态置位。这个标记的用途是**信任结果里的结构化标识**
        // （额度耗尽 / 无套餐），因此判据必须是"结果由谁产出"：
        //   - http：结果来自 LCode 后端。fetch wrapper 对每次请求校验 origin；登录态只在
        //     tools/call 解析，缺失时由同一可信后端返回结构化 coding_plan_required；
        //   - stdio：结果由插件进程自己产出，可以任意伪造 `{"error_code":"quota_exceeded"}`，
        //     从而在用户输入框上方弹出"额度用完 / 请开通 Coding Plan"的误导提示。
        // 原判据是 `type !== "sse"`，把 stdio 一起放了进来，等于这道门槛在 stdio 上为零。
        // 注意这不是在挡凭证外泄（那由 origin 校验负责），而是在挡**结果伪造**。
        config.type === "http" && config.auth?.type === LCODE_OFFICIAL_MCP_AUTH_TYPE,
      ),
    );
    const negotiatedProtocolEra = client.getProtocolEra();
    const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
    const status = this.createStatus(config, "connected", {
      protocolEra: negotiatedProtocolEra,
      toolCount: tools.length,
    });
    if (!this.isCurrentConnection(name, generation)) {
      await this.closeClientAndTransport(name, client, transport);
      return this.records.get(name)?.status ?? status;
    }
    this.connectionDiagnosticByServer.delete(name);
    this.records.set(name, {
      client,
      config,
      status,
      tools,
      transport,
    });
    const mcpTransportPid = getStdioTransportPid(transport);
    const mcpProcessIdentity =
      mcpTransportPid != null && this.connectionContext
        ? this.telemetry?.recordProcessStarted({
            connectionId: this.connectionContext.mcpConnectionId,
            pid: mcpTransportPid,
          })
        : undefined;
    // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
    // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
    // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
    client.onclose = () => {
      if (!this.isCurrentConnection(name, generation)) return;
      const current = this.records.get(name);
      if (!current || current.client !== client) return;
      const recentStderr = getRecentStderr?.();
      const processExit = getStdioTransportExitInfo(transport);
      current.status = this.createStatus(current.config, "disconnected", {
        error: "MCP server connection closed unexpectedly",
        failureKind: "unexpected_disconnect",
      });
      this.logger?.warn("MCP server connection lost", {
        ...this.connectionContext,
        event: "mcp.server.connection_lost",
        mcpServerName: name,
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        ...mcpProcessIdentity,
        ...(processExit
          ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
          : {}),
        status: "failed",
        transport: current.config.type,
        ...(recentStderr ? { stderr: recentStderr } : {}),
      });
      if (
        current.config.type === "stdio" &&
        this.connectionContext &&
        (processExit || !isStdioTransportProcessAlive(transport))
      ) {
        this.telemetry?.recordProcessCrashed({
          connectionId: this.connectionContext.mcpConnectionId,
          exitCode: processExit?.exitCode ?? null,
          signal: processExit?.signal ?? null,
        });
      }
    };
    // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
    // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
    // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
    // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
    this.logger?.info("MCP server connected", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.connected",
      listToolsDurationMs,
      mcpClientName: this.clientName,
      mcpClientVersion: this.clientVersion,
      mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
      mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
      mcpServerName: name,
      ...mcpProcessIdentity,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
      status: "completed",
      toolCount: tools.length,
      transport: config.type,
    });
    return status;
  } catch (error) {
    // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
    // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
    // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
    const trigger = oauthAuthorizationAttempted
      ? undefined
      : classifyInteractiveAuthorizationTrigger(error);
    const authorizationCodeOAuthConfig =
      trigger && config.type !== "stdio" ? resolveAuthorizationCodeOAuthConfig(config) : undefined;
    if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
      // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
      await this.closeClientAndTransport(name, client, transport);
      const outcome = await this.runInteractiveOAuthAuthorization({
        config,
        generation,
        name,
        oauthConfig: authorizationCodeOAuthConfig,
        serverUrl: config.url,
        signal,
        trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await this.openServerConnection({
          ...input,
          oauthAuthorizationAttempted: true,
        });
      }
      // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
      // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
      return this.failConnection({
        config,
        connectDurationMs,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
      });
    }
    // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
    // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
    // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
    // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
    // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
    // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
    // reject），cause 链仅作防御性兜底。
    const negotiationFailureKind = isProtocolNegotiationFailure(error)
      ? ("protocol_negotiation_failed" as const)
      : undefined;
    return this.failConnection({
      client,
      config,
      connectDurationMs,
      error,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
      failureKind: negotiationFailureKind ?? failureKind,
    });
  }
}

export async function failConnection(
  this: McpHandshakeContext,
  input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  },
): Promise<McpServerStatus> {
  const {
    client,
    config,
    connectDurationMs,
    error,
    failureKind: fallbackFailureKind,
    generation,
    getRecentStderr,
    listToolsDurationMs,
    name,
    startedAt,
    transport,
  } = input;
  const message = error instanceof Error ? error.message : String(error);
  // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
  // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
  // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
  const officialAuthKind =
    (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
    this.lastOfficialAuthKind.get(name);
  this.lastOfficialAuthKind.delete(name);
  const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
  this.connectionDiagnosticByServer.delete(name);
  const failureKind =
    (officialAuthKind === "official_mcp_origin_untrusted"
      ? "official_origin_untrusted"
      : undefined) ??
    responseDiagnostic?.failureKind ??
    (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
      ? "connection_timeout"
      : undefined) ??
    fallbackFailureKind ??
    "connection_failed";
  const displayMessage = responseDiagnostic?.serverRequestId
    ? `${message} - ${responseDiagnostic.serverRequestId}`
    : message;
  const status = this.createStatus(config, "failed", {
    error: displayMessage,
    failureKind,
    ...(responseDiagnostic?.serverRequestId
      ? { serverRequestId: responseDiagnostic.serverRequestId }
      : {}),
  });
  const recentStderr = getRecentStderr?.();
  const mcpTransportPid = getStdioTransportPid(transport);
  await this.closeClientAndTransport(name, client, transport);
  if (!this.isCurrentConnection(name, generation)) {
    return this.records.get(name)?.status ?? status;
  }
  this.records.set(name, { config, status, tools: [] });
  this.logger?.warn("MCP server connection failed", {
    ...this.connectionContext,
    connectDurationMs,
    durationMs: Date.now() - startedAt,
    error: displayMessage,
    event: "mcp.server.failed",
    listToolsDurationMs,
    mcpServerName: name,
    ...(officialAuthKind ? { officialAuthKind } : {}),
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "failed",
    ...(recentStderr ? { stderr: recentStderr } : {}),
    transport: config.type,
  });
  return status;
}
