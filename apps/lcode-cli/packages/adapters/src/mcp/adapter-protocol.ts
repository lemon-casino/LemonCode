import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  UnsupportedProtocolVersionError,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import type { McpCallToolRequest, McpServerConfig, McpServerStatus } from "@lcode/contracts";
import type { McpOAuthAuthorizationContext } from "./oauth.js";
import type { AuthorizationCodeOAuthConfig } from "./adapter-types.js";

export const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;

export function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。LCode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

export function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // deprecated SSE transport 本身只承载 legacy era；显式 modern pin 仍应失败而不能静默降级。
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * SDK 版本协商（auto/pin 的 server/discover probe）失败的稳定识别。
 *
 * 结构化判定，禁止匹配错误文本：
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`：probe 硬失败（含非标 legacy server 的
 *   malformed 200 响应，经 transport 层 Zod 校验失败 + normalizeReply 落入 network-error 分支）；
 * - `UnsupportedProtocolVersionError`：recognized modern error，pin 版本不被 server 接受。
 */
export function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

export function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

export function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin 没有 legacy fallback，probe 就是唯一 initialize 路径；沿用 auto 的 5 秒
  // 保护上限会无视 server 的长连接预算，把冷启动正常但超过 5 秒的 node_repl 静默移出工具池。
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // 原因：SDK 的 stdio auto/pin 会先启动 disposable sibling；若沿用 SDK 60s 默认值，
      // LCode 的总连接超时可能先结束并让 probe 残留，也不给 legacy initialize 留预算。
      timeoutMs: probeTimeoutMs,
    },
  };
}

export function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

export function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 MCP OAuth 互斥。必须位于所有既有分支之前：
  // 官方 MCP 既不写 oauth 字段、又禁止静态 authorization 头，若不在此短路就会落进
  // 下面的 authorization_code 兜底，导致 401 时弹出 MCP 授权 UI —— 而官方鉴权失败
  // 只能由 LCode 自身的登录/套餐解决，不可能由目标 MCP 的 OAuth 授权解决。
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // 新建 HTTP/SSE MCP 常只保存 URL；OAuth 支持应由服务端
  // WWW-Authenticate / discovery 触发，不能要求配置里预先写 oauth 字段。
  return {
    type: "authorization_code",
  };
}

/**
 * auth.type/provider 精确命中且 provenance 存在时为真；provenance 缺失说明不是 Plugin loader
 * 产出的配置。
 *
 * 覆盖 http 与 stdio 两种形态——两者的凭证投递通道不同，但"是否官方鉴权"
 * 的判定同源。调用方若只关心某一形态，需自行再判 `config.type`（如 createOfficialAuthFetch
 * 只处理 http、_meta 注入只处理 stdio）。
 */
export function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "lcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

export function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// server 回了 JSON-RPC 错误响应（数字 code）说明请求走通了、连接是活的；
// SDK 本地错误（SdkError，字符串 code：REQUEST_TIMEOUT / CONNECTION_CLOSED / NOT_CONNECTED
// / SEND_FAILED）才代表 transport 已断。code 类型判断兜底 instanceof 在多份 SDK 实例下失效的情况。
export function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}
