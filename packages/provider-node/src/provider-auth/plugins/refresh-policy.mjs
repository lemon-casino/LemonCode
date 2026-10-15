const BODY_LIMIT = 64 * 1024;

/** 固定源码中的令牌端点；用途由原始 URL/POST/刷新参数共同确定，不按错误文本猜测。 */
export function isPluginRefreshRequest(channel, input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    method.toUpperCase() !== "POST"
  )
    return false;
  const body = init.body;
  if (
    !(typeof body === "string" || body instanceof URLSearchParams) ||
    String(body).length > BODY_LIMIT
  )
    return false;
  const host = url.hostname,
    path = url.pathname;
  if (channel === "workbuddy" || channel === "workbuddy-ai") {
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    return (
      host === (channel === "workbuddy" ? "copilot.tencent.com" : "www.workbuddy.ai") &&
      path === "/v2/plugin/auth/token/refresh" &&
      !!headers.get("x-refresh-token")
    );
  }
  let value;
  try {
    value = JSON.parse(String(body));
  } catch {
    value = Object.fromEntries(new URLSearchParams(String(body)));
  }
  const refresh = value?.refresh_token ?? value?.refreshToken ?? value?.RefreshToken;
  if (typeof refresh !== "string" || !refresh) return false;
  const grant = value.grant_type ?? value.grantType;
  if (channel === "factory")
    return (
      host === "api.workos.com" &&
      path === "/user_management/authenticate" &&
      grant === "refresh_token"
    );
  if (channel === "cline")
    return host === "api.cline.bot" && path === "/api/v1/auth/refresh" && grant === "refresh_token";
  if (channel === "minimax-code" || channel === "minimax-code-global")
    return (
      host === (channel === "minimax-code" ? "account.minimax.cn" : "account.minimax.io") &&
      path === "/oauth2/token" &&
      grant === "refresh_token"
    );
  if (channel === "qoder" || channel === "qoder-cn") {
    const expected =
      channel === "qoder"
        ? host === "openapi.qoder.sh"
        : host === "openapi.qoder.com.cn" || /^[a-z0-9-]+-openapi\.vpc\.qoder\.com\.cn$/.test(host);
    return expected && ["/api/v1/jobToken/refresh", "/api/v1/deviceToken/refresh"].includes(path);
  }
  if (channel === "trae-cn" || channel === "trae-global")
    return (
      host === (channel === "trae-cn" ? "api.trae.cn" : "growsg-normal.trae.ai") &&
      path === "/cloudide/api/v3/trae/oauth/ExchangeToken"
    );
  if (channel === "kiro")
    return (
      (/^prod\.[a-z0-9-]+\.auth\.desktop\.kiro\.dev$/.test(host) && path === "/refreshToken") ||
      (/^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(host) &&
        path === "/token" &&
        grant === "refresh_token")
    );
  return false;
}
