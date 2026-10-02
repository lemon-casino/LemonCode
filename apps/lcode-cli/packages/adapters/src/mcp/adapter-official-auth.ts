import type {
  McpServerConfig,
  OfficialMcpAuthFailureReason,
  OfficialMcpTrustedOriginRegistry,
} from "@lcode/contracts";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import { createMcpTransportFetch } from "./network.js";
import { isOfficialAuthConfig } from "./adapter-protocol.js";
import type { OfficialMcpAuthMetaPayload } from "./adapter-types.js";
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpOfficialAuthContext = Pick<
  McpAdapterOwner,
  | "records"
  | "connectionDiagnosticByServer"
  | "serverRequestIdBySpan"
  | "officialMcpAuth"
  | "logger"
  | "workingDirectory"
  | "env"
  | "network"
  | "lastOfficialAuthKind"
  | "isCurrentConnection"
  | "rememberServerResponse"
>;

/** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */
export function rememberServerResponse(
  this: McpOfficialAuthContext,
  serverName: string,
  response: OfficialMcpServerResponseInfo,
): void {
  if (
    !response.spanId &&
    response.rpcMethod !== "tools/call" &&
    this.records.get(serverName)?.status.status === "connecting"
  ) {
    if (response.failureKind) {
      this.connectionDiagnosticByServer.set(serverName, {
        failureKind: response.failureKind,
        ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
      });
    }
    return;
  }
  if (!response.spanId) return;
  if (!response.serverRequestId) return;
  // 401 重试会对同一 span 产生两条响应，后写覆盖——留下的是最终那次，正是要报的那个。
  this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
  while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
    const oldest = this.serverRequestIdBySpan.keys().next();
    if (oldest.done) break;
    this.serverRequestIdBySpan.delete(oldest.value);
  }
}

/** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */
export function takeServerRequestId(
  this: McpOfficialAuthContext,
  spanId: string | undefined,
): string | undefined {
  if (!spanId) return undefined;
  const requestId = this.serverRequestIdBySpan.get(spanId);
  if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
  return requestId;
}

/**
 * 解析 stdio 官方 MCP 本次出站协议消息的身份头。
 * 返回 undefined 表示"不是官方 stdio server"——此时 `_meta` 里绝不能出现该键，否则等于把
 * 身份头广播给任意第三方插件。
 */
export async function resolveOfficialStdioAuthMeta(
  this: McpOfficialAuthContext,
  serverName: string,
  config: McpServerConfig,
  signal: AbortSignal | undefined,
): Promise<OfficialMcpAuthMetaPayload | undefined> {
  if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
    return undefined;
  }
  const official = config.official;
  const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
  const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
  const resolveLCodeApiOrigin = this.officialMcpAuth?.resolveLCodeApiOrigin;
  const logBase = {
    event: "mcp.official_auth.stdio_meta",
    mcpKey: official.mcpKey,
    mcpServerName: serverName,
    module: "adapters.mcp",
  };
  const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
    // 刻意不写 lastOfficialAuthKind：那个 map 只被 failConnection 读取，用来给**连接失败**
    // 打分类标签。stdio 的身份头缺失不会让连接失败，写进去会一直留着，等到该 server 之后
    // 因为别的原因（子进程死掉等）真正断连时被当成断连原因记进日志，属误导。
    // 本路径的可观测性由下面这条自己的 event + 下发给插件的 reason 承担。
    this.logger?.warn("Official MCP stdio auth headers unavailable", {
      ...logBase,
      reason,
      status: "failed",
    });
    return { ok: false, reason };
  };

  // standalone CLI 没有 host auth port。不静默省略该键：插件区分不了"宿主不支持"与
  // "宿主支持但我没登录"，只有显式 reason 才能给出正确的用户提示。
  if (!authHeadersPort || !trustedOrigins || !resolveLCodeApiOrigin) {
    return fail("official_auth_unavailable");
  }

  // stdio 没有 url，origin 由宿主给出而非插件声明。isTrusted 在此退化为恒真断言，但仍要调用：
  // 它同时校验 https、拒绝带 username/password 的 URL，并让 dev loopback 开关继续生效。
  //
  // 这两步原来裸调用。origin 解析依赖 settings / 运行时环境，isTrusted 是
  // 注入的实现，两者都可能抛。异常裸冒泡会绕过整个失败分类：插件收不到 `{ok:false, reason}`，
  // 而 reason 是跨 adapter / host / UI 的契约（决定提示文案与是否重试）。因此统一映射为
  // official_auth_unavailable——宿主侧解析不出可信 origin，对插件而言就是"官方鉴权不可用"。
  // 错误文本只进日志，绝不参与流程判断。
  let targetOrigin: string;
  let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
  try {
    targetOrigin = resolveLCodeApiOrigin();
    trust = await trustedOrigins.isTrusted({
      mcpKey: official.mcpKey,
      origin: targetOrigin,
      pluginId: official.pluginId,
    });
  } catch (error) {
    this.logger?.warn("Official MCP stdio origin resolution failed", {
      ...logBase,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "unknown",
      pluginId: official.pluginId,
    });
    return fail("official_auth_unavailable");
  }
  if (!trust.trusted) {
    this.logger?.warn("Official MCP stdio origin is not trusted", {
      ...logBase,
      detail: trust.detail ?? "unknown",
      pluginId: official.pluginId,
      targetOrigin,
    });
    return fail("official_mcp_origin_untrusted");
  }

  const resolved = await authHeadersPort.resolveHeaders({
    mcpKey: official.mcpKey,
    pluginId: official.pluginId,
    targetOrigin,
    ...(this.officialMcpAuth?.workspaceIdentity
      ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
      : {}),
    ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!resolved.ok) return fail(resolved.reason);

  // 只记 header 名与套餐维度，绝不记 header 值——日志留存周期不受控。
  this.logger?.debug("Official MCP stdio auth headers attached", {
    ...logBase,
    identityHeaderNames: Object.keys(resolved.headers)
      .map((name) => name.toLowerCase())
      .sort(),
    ...(resolved.headers["Bigmodel-Target-Type"]
      ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
      : {}),
    status: "completed",
  });
  return { ok: true, headers: resolved.headers };
}

/**
 * 官方鉴权 MCP 的动态 fetch。返回 undefined 表示走普通 MCP 路径。
 *
 * trusted origin 依赖缺失时直接 fail closed。auth port 可以缺失：wrapper 仍校验 origin，
 * 各请求匿名降级并由服务端做权威判定。
 */
export function createOfficialAuthFetch(
  this: McpOfficialAuthContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
): typeof globalThis.fetch | undefined {
  if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
    return undefined;
  }
  const official = config.official;
  const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
  const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
  if (!trustedOrigins) {
    return (() => {
      throw new OfficialMcpAuthError(
        "official_auth_unavailable",
        `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
      );
    }) as unknown as typeof globalThis.fetch;
  }
  return createOfficialMcpAuthFetch({
    baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
    official,
    onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
    onServerResponse: (response) => {
      if (this.isCurrentConnection(serverName, generation)) {
        this.rememberServerResponse(serverName, response);
      }
    },
    serverName,
    trustedOrigins,
    url: config.url,
    ...(authHeadersPort ? { authHeadersPort } : {}),
    ...(this.logger ? { logger: this.logger } : {}),
    ...(this.officialMcpAuth?.workspaceIdentity
      ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
      : {}),
    ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
  });
}
