import { prepareResponses } from "./openai-request.js";
export { prepareResponses } from "./openai-request.js";
import { randomBytes } from "node:crypto";
import type {
  AuthChallenge,
  AuthDriver,
  AuthDriverContext,
  AuthGrant,
  AuthMethod,
  AuthModel,
} from "../driver.js";
import { browserChallenge } from "./browser.js";
import { importChallenge, singleImport } from "./imports.js";
import { followLocal, localAccount, saveLocalCodex } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";
import { openAIIdentity } from "./identity.js";
import {
  checkEndpoint,
  expires,
  importedGrant,
  joinedSignal,
  json,
  jwt,
  list,
  number,
  postForm,
  record,
  requireGrant,
  sseData,
  text,
  type Fetcher,
  type Json,
} from "./common.js";

const CODEX_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const API_BASE = "https://api.openai.com/v1";
const AUTH = "https://auth.openai.com";
const VERSION = "0.159.0";
type OpenAIChannel = "codex" | "chatgpt-api";

export class OpenAIAuthDriver implements AuthDriver {
  private readonly lifetime = new AbortController();
  constructor(
    private readonly channel: OpenAIChannel,
    private readonly request: Fetcher = fetch,
    private readonly localIO: LocalIO = defaultLocalIO,
  ) {}
  async methods(): Promise<readonly AuthMethod[]> {
    return [
      { id: "browser", label: "Sign in with ChatGPT", type: "oauth", kind: "browser" },
      ...(this.channel === "codex"
        ? [
            {
              id: "files",
              label: "Import accounts from files",
              type: "oauth" as const,
              kind: "import" as const,
              description:
                "Refreshes and takes over imported sign-ins. The source files are only read; their application may need to sign in again.",
            },
            {
              id: "local",
              label: "Use Codex's signed-in account",
              type: "oauth" as const,
              kind: "local" as const,
              description:
                "Follows this Host's Codex account and writes refreshed credentials back to its auth.json. Detect again after switching the account in Codex.",
            },
          ]
        : []),
      {
        id: "import",
        label: "Import credentials JSON",
        type: "oauth",
        kind: "credentials",
        fields: [
          { key: "credentials", label: "Credential JSON", type: "password", format: "json" },
        ],
      },
    ];
  }
  async authorize(
    method: string,
    inputs: Record<string, string>,
    signal: AbortSignal,
  ): Promise<AuthChallenge> {
    signal = joinedSignal(signal, this.lifetime.signal);
    if (method === "local" && this.channel === "codex")
      return {
        method: "auto" as const,
        complete: () => localAccount("codex", this.localIO, signal),
      };
    if (method === "files" && this.channel === "codex")
      return importChallenge("codex", inputs, signal, async (item, bounded) => {
        let grant: AuthGrant = {
          type: "oauth",
          refresh: item.refresh,
          idToken: item.idToken,
          accountId: item.accountId,
          email: item.email,
        };
        grant = await this.fresh(
          {
            read: async () => grant,
            write: async (next) => {
              grant = next;
            },
            signal: bounded,
          },
          true,
        );
        if (!grant.identityKey) throw new Error("ChatGPT did not identify the account");
        return grant;
      });
    if (method === "import") {
      if (this.channel === "codex")
        return singleImport(await this.authorize("files", inputs, signal));
      const source = importedGrant(inputs.credentials ?? "");
      const grant = openAIIdentity(
        source,
        text(source.id_token) || text(source.idToken),
        this.channel,
      );
      if (this.channel === "chatgpt-api" && !text(grant.clientId))
        throw new Error("ChatGPT API credentials require their registered clientId");
      return {
        method: "auto",
        complete: async () => {
          signal.throwIfAborted();
          return grant;
        },
      };
    }
    if (method !== "browser") throw new Error("Unknown authorization method");
    const api = this.channel === "chatgpt-api";
    const nonce = randomBytes(24).toString("base64url");
    const hostId = inputs.hostId || "";
    if (api && !/^urn:uuid:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(hostId))
      throw new Error("ChatGPT API requires this Host's persistent installation identity");
    return browserChallenge({
      authorizeURL: AUTH + (api ? "/api/accounts/authorize" : "/oauth/authorize"),
      port: api ? 0 : 1455,
      callbackHost: api ? "127.0.0.1" : "localhost",
      signal,
      parameters: api
        ? {
            client_id: "dynamic_agent_client",
            agent_name_hint: "LCode",
            ext_agent_host_id: hostId,
            resource: API_BASE,
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            nonce,
          }
        : {
            client_id: CODEX_CLIENT,
            scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: "codex_cli_rs",
          },
      exchange: async (code, verifier, redirect, query) => {
        const clientId = api ? (query.get("client_id") ?? "") : CODEX_CLIENT;
        if (!clientId) throw new Error("ChatGPT did not register this application");
        const token = await postForm(
          this.request,
          AUTH + (api ? "/api/accounts/oauth/token" : "/oauth/token"),
          {
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            ...(api ? { resource: API_BASE } : {}),
          },
          signal,
        );
        const claims = jwt(text(token.id_token));
        if (
          api &&
          (claims.iss !== AUTH ||
            claims.nonce !== nonce ||
            !(claims.aud === clientId || list(claims.aud).includes(clientId)) ||
            (number(claims.exp) ?? 0) * 1000 <= Date.now())
        )
          throw new Error("Invalid ChatGPT identity response");
        return tokenGrant(token, { type: "oauth", clientId, hostId }, this.channel);
      },
    });
  }
  private async fresh(context: AuthDriverContext, force = false): Promise<AuthGrant> {
    const grant = await followLocal(
      await requireGrant(context),
      this.localIO,
      joinedSignal(context.signal, this.lifetime.signal),
    );
    const expiry = grant.expires ?? (number(jwt(grant.access ?? "").exp) ?? 0) * 1000;
    if (!force && grant.access && expiry > Date.now() + 300_000) return grant;
    if (!grant.refresh) throw new Error("ChatGPT sign-in has expired; sign in again");
    const api = this.channel === "chatgpt-api";
    const result = await postForm(
      this.request,
      AUTH + (api ? "/api/accounts/oauth/token" : "/oauth/token"),
      {
        grant_type: "refresh_token",
        refresh_token: grant.refresh,
        client_id: api ? text(grant.clientId) : CODEX_CLIENT,
        ...(api ? { resource: API_BASE } : {}),
      },
      joinedSignal(context.signal, this.lifetime.signal),
    );
    const next = tokenGrant(result, grant, this.channel);
    context.signal?.throwIfAborted();
    await saveLocalCodex(grant, next, this.localIO);
    await context.write(next);
    return next;
  }
  private headers(grant: AuthGrant): Headers {
    const headers = new Headers({
      authorization: `Bearer ${grant.access}`,
      "content-type": "application/json",
    });
    if (this.channel === "codex") {
      headers.set("originator", "codex_cli_rs");
      headers.set("version", VERSION);
      headers.set("user-agent", `codex_cli_rs/${VERSION}`);
      headers.set("OpenAI-Beta", "responses=experimental");
      if (grant.accountId) headers.set("chatgpt-account-id", grant.accountId);
    }
    return headers;
  }
  async models(context: AuthDriverContext): Promise<readonly AuthModel[]> {
    const grant = await this.fresh(context);
    const baseURL = this.channel === "codex" ? CODEX_BASE : API_BASE;
    const data = await json(
      this.request,
      baseURL + "/models" + (this.channel === "codex" ? `?client_version=${VERSION}` : ""),
      { headers: this.headers(grant), signal: joinedSignal(context.signal, this.lifetime.signal) },
    );
    const prompts: Record<string, string> = {};
    const models = list(data.models ?? data.data)
      .sort(
        (a, b) =>
          (number(record(a).priority) ?? Infinity) - (number(record(b).priority) ?? Infinity),
      )
      .flatMap((item): AuthModel[] => {
        const model = record(item);
        const id = text(model.slug) || text(model.id);
        if (
          !id ||
          (this.channel === "codex"
            ? model.visibility === "hide"
            : Boolean(model.visibility) && model.visibility !== "list")
        )
          return [];
        const instructions =
          text(record(model.model_messages).instructions_template) || text(model.base_instructions);
        if (instructions) prompts[id] = instructions;
        return [
          {
            id,
            name: text(model.display_name) || text(model.name) || id,
            protocol: "openai-responses",
            baseURL,
            contextWindow: number(model.context_window),
            maxContextWindow: number(model.max_context_window),
            reasoningEfforts: list(model.supported_reasoning_levels)
              .map((item) => text(record(item).effort))
              .filter(Boolean),
            serviceTiers: list(model.service_tiers)
              .map((item) => text(record(item).id))
              .filter(Boolean),
            inputModalities: list(model.input_modalities).filter(
              (value): value is "text" | "image" | "audio" | "video" | "pdf" =>
                ["text", "image", "audio", "video", "pdf"].includes(String(value)),
            ),
            maxOutputTokens: number(model.max_output_tokens),
            images: list(model.input_modalities).includes("image"),
            reasoning: list(model.supported_reasoning_levels).length > 0,
          },
        ];
      });
    if (Object.keys(prompts).length) {
      context.signal?.throwIfAborted();
      await context.write({ ...grant, modelInstructions: prompts });
    }
    return models;
  }
  async fetch(request: Request, context: AuthDriverContext): Promise<Response> {
    context = {
      ...context,
      signal: joinedSignal(request.signal, context.signal, this.lifetime.signal),
    };
    const base = this.channel === "codex" ? CODEX_BASE : API_BASE;
    checkEndpoint(request, base, ["/responses"]);
    if (request.method !== "POST") throw new Error("Provider endpoint requires POST");
    const incoming = record(await request.json());
    const streamed = incoming.stream === true;
    const grant = await this.fresh(context);
    const prepared = prepareResponses(
      incoming,
      this.channel,
      text(record(grant.modelInstructions)[text(incoming.model)]),
    );
    const send = (auth: AuthGrant) => {
      const headers = this.headers(auth);
      headers.set("accept", "text/event-stream");
      const key = text(prepared.prompt_cache_key);
      if (key) {
        headers.set("session-id", key);
        headers.set("thread-id", key);
      }
      return this.request(base + "/responses", {
        method: "POST",
        headers,
        body: JSON.stringify(prepared),
        signal: joinedSignal(request.signal, context.signal, this.lifetime.signal),
        redirect: "error",
      });
    };
    let response = await send(grant);
    if (response.status === 401) {
      await response.body?.cancel();
      response = await send(await this.fresh(context, true));
    }
    if (streamed || !response.ok || !response.body) return response;
    // SDK 非流式生成仍走厂商的 SSE；只用 completed 的权威 usage/result 回答。
    for await (const frame of sseData(response.body, request.signal)) {
      if (frame.type === "response.completed" || frame.type === "response.incomplete")
        return Response.json(frame.response);
      if (frame.type === "response.failed" || frame.type === "error")
        return Response.json(
          { error: { type: "upstream_error", message: "ChatGPT response failed" } },
          { status: 502 },
        );
    }
    throw new Error("ChatGPT stream ended without a response result");
  }
  async quota(context: AuthDriverContext): Promise<unknown> {
    if (this.channel === "chatgpt-api")
      return { status: "unsupported", url: "https://chatgpt.com/settings/usage" };
    const grant = await this.fresh(context);
    const signal = joinedSignal(context.signal, this.lifetime.signal);
    const raw = await json(this.request, "https://chatgpt.com/backend-api/wham/usage", {
      headers: this.headers(grant),
      signal,
    });
    if (!(Number(record(raw.rate_limit_reset_credits).available_count) > 0)) return raw;
    try {
      const resetCredits = await json(
        this.request,
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        {
          headers: this.headers(grant),
          signal: joinedSignal(signal, AbortSignal.timeout(4000)),
        },
      );
      return { ...raw, resetCredits };
    } catch {
      signal.throwIfAborted();
      return { ...raw, partial: true };
    }
  }
  dispose(): void {
    this.lifetime.abort();
  }
}

function tokenGrant(token: Json, previous: AuthGrant, channel: OpenAIChannel = "codex"): AuthGrant {
  const access = text(token.access_token);
  if (!access) throw new Error("The provider returned no access token");
  const identity = jwt(text(token.id_token));
  const auth = record(identity["https://api.openai.com/auth"]);
  return openAIIdentity(
    {
      ...previous,
      type: "oauth",
      access,
      refresh: text(token.refresh_token) || previous.refresh,
      expires: expires(token),
      accountId:
        text(auth.chatgpt_account_id) || previous.accountId || text(identity.sub) || undefined,
      email: text(identity.email) || previous.email,
      plan: text(auth.chatgpt_plan_type) || previous.plan,
    },
    text(token.id_token) || text(previous.idToken),
    channel,
  );
}
