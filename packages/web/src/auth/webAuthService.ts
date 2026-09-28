import { ZAI_PROVIDER_ID, type UserInfo } from "@lcode/shared";
import {
  BrowserOAuthCredentialRepo,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  config?: WebZaiOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
}

interface WebAuthLoginOptions {
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;

  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.provider = dependencies.provider ?? new ZaiWebOAuthProvider(this.config);
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
  }

  startLogin(options: WebAuthLoginOptions = {}): void {
    const nonce = this.runtime.createNonce();
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    this.repo.savePendingNonce(nonce);
    this.repo.savePendingProvider(provider);

    const state = buildOAuthState({
      nonce,
      app_return_to: options.appReturnTo ?? this.runtime.getCurrentHref(),
      ...(options.devReturnTo ? { return_to: options.devReturnTo } : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri: options.redirectUri ?? this.config.redirectUri,
      }),
    );
  }

  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    const pendingNonce = this.repo.loadPendingNonce();
    if (statePayload.nonce !== pendingNonce) {
      throw new Error("OAuth CSRF 检测失败");
    }
    // provider 必须取跳转前记下的那个：authorize 参数名和 token 响应里 access_token 的位置
    // 都是 provider 特定的。缺失时按 zai 兜底，保持旧回调链接可用。
    const provider = this.repo.loadPendingProvider() ?? ZAI_PROVIDER_ID;
    this.repo.clearPendingNonce();
    this.repo.clearPendingProvider();

    const callbackRedirectUri = ["/cn/share/callback", "/share/callback"].includes(
      new URL(url).pathname,
    )
      ? this.config.shareRedirectUri
      : this.config.redirectUri;
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri: callbackRedirectUri,
    });

    this.repo.saveTokenSet(exchange.tokenSet, provider);
    this.repo.saveUserInfo(exchange.rawUserInfo, provider);
    this.repo.setActiveProvider(provider);

    return {
      userInfo: exchange.userInfo,
      appReturnTo: resolveSafeAppReturnTo(statePayload.app_return_to, {
        currentOrigin: this.runtime.getCurrentOrigin(),
      }),
    };
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    return this.repo.loadCachedSession();
  }

  restoreCachedSessionState() {
    return this.repo.loadCachedSessionState();
  }

  getLCodeJwtToken(): string | null {
    return this.repo.loadLCodeJwtToken();
  }

  async logout(): Promise<void> {
    this.repo.clearAll();
  }
}

export function createWebAuthService(): WebAuthService {
  return new WebAuthService();
}
