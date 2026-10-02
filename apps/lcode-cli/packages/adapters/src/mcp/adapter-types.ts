import type {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpOAuthConfig,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@lcode/contracts";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { McpConnectionContext } from "./pool.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { McpTelemetryTracker } from "./telemetry.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
export const MCP_PING_TIMEOUT_MS = 5_000;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 LCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveLCodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveLCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
}

export type McpClient = Client;

export type McpTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

export type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 LCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
export type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

export interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  transport?: McpTransport;
}
