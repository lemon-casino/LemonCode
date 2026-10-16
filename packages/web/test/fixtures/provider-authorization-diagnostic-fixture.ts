import type { ProviderAuthorization } from "@lcode/shared";
/** 无额外时钟：测试显式发布 Host 已结束的后续工作事实。 */
export function projectFixtureAuthorizationDiagnostic(
  attempt: ProviderAuthorization,
  diagnostic: ProviderAuthorization["diagnostic"],
): ProviderAuthorization {
  return attempt.status === "completed" &&
    attempt.diagnostic?.followupPending &&
    diagnostic?.followupPending === false
    ? { ...attempt, diagnostic }
    : attempt;
}
