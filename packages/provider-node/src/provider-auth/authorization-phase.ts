import type { ProviderAuthorizationDiagnostic } from "@lcode/shared";
/** 固定端点语义只用于进度，不记录原 URL/query，不把接收 callback 当成凭据已保存。 */
export function authorizationRequestPhase(
  url: string,
): ProviderAuthorizationDiagnostic["phase"] | undefined {
  const path = new URL(url).pathname;
  if (
    /\/(userinfo|whoami|me|login\/account|accounts|user)(?:\/|$)/i.test(path) ||
    path.endsWith("/getCustomerInfo")
  )
    return "identity";
  if (/(?:token|exchange|authenticate|\/oauth\/cli\/poll)/i.test(path)) return "exchange";
  return undefined;
}
