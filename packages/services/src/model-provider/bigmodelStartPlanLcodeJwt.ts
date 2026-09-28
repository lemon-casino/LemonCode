import { BIGMODEL_PROVIDER_ID } from "@lcode/shared";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const LCODE_JWT_TOKEN_KEY = "lcodejwttoken";

interface BigModelStartPlanLcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

export async function resolveBigModelStartPlanLcodeJwt(params: {
  credentialService?: BigModelStartPlanLcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedLcodeJwt?: boolean;
}): Promise<string> {
  const activeProvider = (await params.credentialService?.load(ACTIVE_PROVIDER_KEY))?.trim() || "";
  if (params.trustCachedLcodeJwt === true || activeProvider === BIGMODEL_PROVIDER_ID) {
    const credentialJwt = (await params.credentialService?.load(LCODE_JWT_TOKEN_KEY))?.trim() || "";
    if (credentialJwt) {
      return credentialJwt;
    }
  }

  // lcode JWT 必须在 BigModel OAuth callback 阶段用授权码 body 落盘。
  // Start Plan 查询余额/运行时只消费已保存的 JWT 或 provider 副本，不再用
  // BigModel access_token 构造 provider+access_token body 临时兑换，避免 /oauth/token 400。
  return params.provider?.apiKey?.trim() || "";
}
