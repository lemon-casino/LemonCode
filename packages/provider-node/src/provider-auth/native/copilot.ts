import type {
  AuthChallenge,
  AuthDriver,
  AuthDriverContext,
  AuthGrant,
  AuthMethod,
  AuthModel,
} from "../driver.js";
import { followLocal, localAccount } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";
import { accountIdentity, safeDisplay } from "./identity.js";
import { CopilotAutoRouter } from "./copilot-auto.js";
import { copilotCatalog } from "./copilot-models.js";
import { prepareToolSchemas } from "./tool-schema.js";
import {
  checkEndpoint,
  joinedSignal,
  json,
  list,
  number,
  postForm,
  record,
  requireGrant,
  text,
  wait,
  type Fetcher,
} from "./common.js";

const CLIENT = "Iv1.b507a08c87ecfe98";
const BASE = "https://api.githubcopilot.com";
const COPILOT_CHAT_API_VERSION = "2026-01-09";
const HEADERS = {
  "Editor-Version": "vscode/1.140.0",
  "Editor-Plugin-Version": "copilot-chat/0.68.0",
  "Copilot-Integration-Id": "vscode-chat",
  "user-agent": "GitHubCopilotChat/0.68.0",
};
function headersFor(grant: AuthGrant) {
  // CAPI版本仅用于模型API；GitHub令牌和额度接口仍使用原HEADERS。
  return grant.copilotMode === "cli"
    ? {
        "Editor-Version": "copilot/1.0.88",
        "Copilot-Integration-Id": "copilot-developer-cli",
        "X-GitHub-Api-Version": "2026-07-01",
        "user-agent": "copilot/1.0.88",
      }
    : { ...HEADERS, "X-GitHub-Api-Version": COPILOT_CHAT_API_VERSION };
}

function site(host: string): { web: string; api: string } {
  host = host.trim().toLowerCase();
  if (!host || host === "github.com")
    return { web: "https://github.com", api: "https://api.github.com" };
  if (!/^[a-z0-9-]+\.ghe\.com$/.test(host))
    throw new Error("Use github.com or the enterprise's name.ghe.com host");
  return { web: `https://${host}`, api: `https://api.${host}` };
}

function sessionBase(value: unknown): string {
  const raw = text(value) || BASE;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.hostname === "api.githubcopilot.com" ||
      url.hostname.endsWith(".githubcopilot.com") ||
      url.hostname.endsWith(".ghe.com")
    )
  )
    throw new Error("Copilot returned an unsupported API endpoint");
  return url.origin;
}

export class CopilotAuthDriver implements AuthDriver {
  readonly routingSingleAttempt = true;
  private readonly lifetime = new AbortController();
  private readonly policies = new Set<string>();
  private readonly auto: CopilotAutoRouter;
  private catalog?: ReturnType<typeof copilotCatalog>;
  constructor(
    private readonly request: Fetcher = fetch,
    private readonly localIO: LocalIO = defaultLocalIO,
  ) {
    this.auto = new CopilotAutoRouter(request);
  }
  async methods(): Promise<readonly AuthMethod[]> {
    return [
      {
        id: "device",
        label: "Sign in with GitHub",
        type: "oauth",
        kind: "browser",
        fields: [{ key: "host", label: "GitHub host (optional)", type: "text", optional: true }],
      },
      {
        id: "local",
        label: "Use Copilot's signed-in account",
        type: "oauth",
        kind: "local",
        description:
          "Follows this Host's editor or Copilot CLI sign-in, including supported system keychains. Detect again after switching its account. No source credential is changed.",
      },
      {
        id: "import",
        label: "Import GitHub OAuth token",
        type: "oauth",
        kind: "credentials",
        fields: [
          { key: "token", label: "GitHub OAuth token", type: "password" },
          { key: "host", label: "GitHub host (optional)", type: "text", optional: true },
        ],
      },
    ];
  }
  async authorize(
    method: string,
    inputs: Record<string, string>,
    signal: AbortSignal,
  ): Promise<AuthChallenge> {
    const controller = new AbortController();
    signal = joinedSignal(
      signal,
      controller.signal,
      this.lifetime.signal,
      AbortSignal.timeout(15 * 60_000),
    );
    const host = inputs.host?.trim() ?? "";
    const urls = site(host);
    if (method === "local")
      return {
        method: "auto" as const,
        complete: () => localAccount("copilot", this.localIO, signal),
        cancel: () => controller.abort(),
      };
    const finish = async (token: string): Promise<AuthGrant> => {
      if (!token) throw new Error("GitHub returned no OAuth token");
      const user = await json(this.request, urls.api + "/user", {
        headers: { authorization: `token ${token}`, accept: "application/json" },
        signal,
      });
      return {
        type: "oauth",
        access: token,
        host,
        accountId: String(user.id ?? user.login ?? ""),
        username: text(user.login),
        identityKey: accountIdentity("copilot", text(user.login), host || "github.com"),
        displayName: safeDisplay(user.login) + (host ? `@${host}` : ""),
      };
    };
    if (method === "import")
      return {
        method: "auto",
        complete: () => finish(inputs.token ?? ""),
        cancel: () => controller.abort(),
      };
    if (method !== "device") throw new Error("Unknown authorization method");
    const code = await postForm(
      this.request,
      urls.web + "/login/device/code",
      { client_id: CLIENT, scope: "read:user" },
      signal,
    );
    if (!text(code.device_code) || !text(code.user_code))
      throw new Error("GitHub returned no device code");
    let interval = Math.max(1, number(code.interval) ?? 5) * 1000;
    const end = Date.now() + (number(code.expires_in) ?? 900) * 1000;
    let completion: Promise<AuthGrant> | undefined;
    return {
      url: text(code.verification_uri) || urls.web + "/login/device",
      instructions: `Enter code: ${text(code.user_code)}`,
      method: "auto",
      cancel: () => controller.abort(),
      complete: () =>
        (completion ??= (async () => {
          while (Date.now() < end) {
            await wait(interval, signal);
            const token = await postForm(
              this.request,
              urls.web + "/login/oauth/access_token",
              {
                client_id: CLIENT,
                device_code: text(code.device_code),
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              },
              signal,
            );
            if (token.error === "authorization_pending") continue;
            if (token.error === "slow_down") {
              interval += 5000;
              continue;
            }
            if (token.error) throw new Error("GitHub device authorization was declined or expired");
            return finish(text(token.access_token));
          }
          throw new Error("GitHub device authorization expired");
        })()),
    };
  }
  private async session(context: AuthDriverContext, force = false): Promise<AuthGrant> {
    context = { ...context, signal: joinedSignal(context.signal, this.lifetime.signal) };
    const grant = await followLocal(
      await requireGrant(context),
      this.localIO,
      joinedSignal(context.signal, this.lifetime.signal),
    );
    if (
      !force &&
      text(grant.sessionToken) &&
      (number(grant.sessionExpires) ?? 0) > Date.now() + 120_000
    )
      return grant;
    if (grant.copilotMode === "cli") {
      const user = await json(this.request, site(text(grant.host)).api + "/copilot_internal/user", {
        headers: { authorization: `token ${grant.access}`, accept: "application/json" },
        signal: joinedSignal(context.signal, this.lifetime.signal),
      });
      const next = {
        ...grant,
        sessionToken: grant.access,
        sessionExpires: Date.now() + 30 * 60_000,
        apiBase: sessionBase(record(user.endpoints).api),
      };
      context.signal?.throwIfAborted();
      await context.write(next);
      return next;
    }
    const data = await json(
      this.request,
      site(text(grant.host)).api + "/copilot_internal/v2/token",
      {
        headers: { ...HEADERS, authorization: `token ${grant.access}`, accept: "application/json" },
        signal: joinedSignal(context.signal, this.lifetime.signal),
      },
    );
    if (!text(data.token)) throw new Error("GitHub account has no Copilot session");
    const next: AuthGrant = {
      ...grant,
      sessionToken: data.token,
      sessionExpires: (number(data.expires_at) ?? 0) * 1000,
      apiBase: sessionBase(record(data.endpoints).api),
    };
    context.signal?.throwIfAborted();
    await context.write(next);
    return next;
  }
  async models(context: AuthDriverContext): Promise<readonly AuthModel[]> {
    const grant = await this.session(context);
    const base = sessionBase(grant.apiBase);
    const response = await json(this.request, base + "/models", {
      headers: { ...headersFor(grant), authorization: `Bearer ${grant.sessionToken}` },
      signal: joinedSignal(context.signal, this.lifetime.signal),
    });
    let tokenBased: boolean | undefined;
    if (list(response.data).some((item) => record(item).billing)) {
      try {
        const quota = record(await this.quota(context));
        const modes = Object.values(record(quota.quota_snapshots))
          .map((item) => record(item).token_based_billing)
          .filter((mode): mode is boolean => typeof mode === "boolean");
        tokenBased =
          typeof quota.token_based_billing === "boolean"
            ? quota.token_based_billing
            : modes.length && modes.every((mode) => mode === modes[0])
              ? modes[0]
              : undefined;
      } catch {
        context.signal?.throwIfAborted();
      }
    }
    this.policies.clear();
    this.catalog = copilotCatalog(response, base, tokenBased);
    for (const model of this.catalog.policies) this.policies.add(model);
    return this.catalog.models.filter((model) => !this.auto.isRefused(model.id));
  }
  async modelCatalog(context: AuthDriverContext) {
    await this.models(context);
    // 用户刷新成功后应可重新尝试账号的新权限；失败时仍保留已有拒绝事实。
    this.auto.catalogRefreshed();
    return { models: this.catalog!.models };
  }
  private async acceptPolicy(
    model: string,
    grant: AuthGrant,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    if (!this.policies.has(model)) return;
    const response = await this.request(
      sessionBase(grant.apiBase) + "/models/" + encodeURIComponent(model) + "/policy",
      {
        method: "POST",
        headers: {
          ...headersFor(grant),
          authorization: `Bearer ${grant.sessionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state: "enabled" }),
        signal,
        redirect: "error",
      },
    );
    if (!response.ok) return response;
    await response.body?.cancel();
    this.policies.delete(model);
  }
  async fetch(request: Request, context: AuthDriverContext): Promise<Response> {
    context = {
      ...context,
      signal: joinedSignal(request.signal, context.signal, this.lifetime.signal),
    };
    // 校验目录授予的 Copilot host；不接受借 OAuth fetch 代理任意地址。
    const requestedBase = sessionBase(new URL(request.url).origin);
    checkEndpoint(request, requestedBase, ["/responses", "/chat/completions", "/v1/messages"]);
    if (request.method !== "POST") throw new Error("Provider endpoint requires POST");
    const path = new URL(request.url).pathname;
    const protocol = path.endsWith("/messages")
      ? "anthropic-messages"
      : path.endsWith("/responses")
        ? "openai-responses"
        : "openai-chat-completions";
    const parsed = prepareToolSchemas(record(JSON.parse(await request.text())), protocol, {
      objectRoots: true,
    });
    const body = JSON.stringify(parsed);
    let grant = await this.session(context);
    const model = text(parsed.model);
    // 冷恢复只保留公开目录，不保留 driver 的 policy 集；手选模型也须恢复账号目录后再激活权限。
    if (!this.catalog) await this.models(context);
    const signal = joinedSignal(request.signal, context.signal, this.lifetime.signal);
    const send = async (auth: AuthGrant): Promise<Response> => {
      const base = sessionBase(auth.apiBase);
      const headers = new Headers(headersFor(auth));
      headers.set("authorization", `Bearer ${auth.sessionToken}`);
      headers.set("content-type", "application/json");
      headers.set("openai-intent", "conversation-panel");
      const messages = list(parsed.messages ?? parsed.input);
      const last = record(messages.at(-1));
      headers.set(
        "X-Initiator",
        last.role === "user" || typeof parsed.input === "string" ? "user" : "agent",
      );
      if (/"(?:image_url|input_image|image)"/.test(body))
        headers.set("Copilot-Vision-Request", "true");
      if (model === "auto") {
        if (new URL(request.url).pathname !== "/chat/completions")
          throw new Error("Copilot Auto requires the chat protocol");
        return this.auto.request(parsed, {
          singleAttempt: context.routingSingleAttempt,
          base,
          headers: Object.fromEntries(headers),
          signal,
          models: this.catalog?.manual ?? [],
          seen: this.catalog?.seen,
          beforeSend: (selected) => this.acceptPolicy(selected, auth, signal),
        });
      }
      const policy = await this.acceptPolicy(model, auth, signal);
      if (policy) return policy;
      if (new URL(request.url).pathname === "/v1/messages")
        headers.set("anthropic-version", "2023-06-01");
      return this.request(base + new URL(request.url).pathname, {
        method: "POST",
        headers,
        body,
        signal: joinedSignal(request.signal, context.signal, this.lifetime.signal),
        redirect: "error",
      });
    };
    let response = await send(grant);
    // 增强路由不能在一份并发预留里刷新并重放推理；legacy 保持原 401 恢复行为。
    if (response.status === 401) {
      if (!context.routingSingleAttempt) await response.body?.cancel();
      grant = await this.session(context, true);
      if (!context.routingSingleAttempt) response = await send(grant);
    }
    return model === "auto" ? response : this.auto.observe(model, response, signal);
  }
  async quota(context: AuthDriverContext): Promise<unknown> {
    const grant = await followLocal(
      await requireGrant(context),
      this.localIO,
      joinedSignal(context.signal, this.lifetime.signal),
    );
    return json(this.request, site(text(grant.host)).api + "/copilot_internal/user", {
      headers: { ...HEADERS, authorization: `token ${grant.access}`, accept: "application/json" },
      signal: joinedSignal(context.signal, this.lifetime.signal),
    });
  }
  dispose(): void {
    this.lifetime.abort();
  }
}
