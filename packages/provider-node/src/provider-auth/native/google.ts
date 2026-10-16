import type {
  AuthChallenge,
  AuthDriver,
  AuthDriverContext,
  AuthGrant,
  AuthMethod,
  AuthModel,
} from "../driver.js";
import { browserChallenge } from "./browser.js";
import { GoogleModels, resolveGoogleProject } from "./google-models.js";
import { importChallenge, singleImport } from "./imports.js";
import { localAccount } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";
import { accountIdentity, safeDisplay } from "./identity.js";
import {
  checkEndpoint,
  expires,
  joinedSignal,
  json,
  postForm,
  record,
  text,
  type Fetcher,
  type Json,
} from "./common.js";
import { codeAssistRequest, codeAssistResponse } from "./google-wire.js";
import { NativeAccountRefresh } from "./account-refresh.js";

type GoogleChannel = "gemini" | "antigravity";
const PROD = "https://cloudcode-pa.googleapis.com";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const TOKEN = "https://oauth2.googleapis.com/token";
// Installed-app OAuth client definitions are public application identifiers, not user credentials.
const APPS = {
  gemini: {
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
  },
  antigravity: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
};

export class GoogleAuthDriver implements AuthDriver {
  readonly routingSingleAttempt = true;
  private readonly lifetime = new AbortController();
  private readonly catalog: GoogleModels;
  private readonly refreshOwner: NativeAccountRefresh;
  constructor(
    private readonly channel: GoogleChannel,
    private readonly request: Fetcher = fetch,
    private readonly localIO: LocalIO = defaultLocalIO,
  ) {
    this.refreshOwner = new NativeAccountRefresh({
      lifetime: this.lifetime.signal,
      localIO: this.localIO,
      isFresh: (grant) => Boolean(grant.access && (grant.expires ?? 0) > Date.now() + 120_000),
      missingRefreshMessage: "Google sign-in expired; sign in again",
      exchange: async (grant, signal) => {
        const app = APPS[this.channel];
        const token = await postForm(
          this.request,
          TOKEN,
          {
            grant_type: "refresh_token",
            refresh_token: text(grant.refresh),
            client_id: app.clientId,
            client_secret: app.clientSecret,
          },
          signal,
        );
        if (!text(token.access_token)) throw new Error("Google returned no access token");
        return {
          ...grant,
          access: text(token.access_token),
          refresh: text(token.refresh_token) || grant.refresh,
          expires: expires(token),
        };
      },
    });
    this.catalog = new GoogleModels(
      channel,
      (grant, method, body, signal) => this.call(grant, method, body, signal),
      request,
    );
  }
  private get base(): string {
    return this.channel === "antigravity" ? DAILY : PROD;
  }
  private get userAgent(): string {
    return this.channel === "antigravity"
      ? `antigravity/1.20.6 ${process.platform}/${process.arch}`
      : `GeminiCLI/0.61.0/${process.platform}/${process.arch}`;
  }
  async methods(): Promise<readonly AuthMethod[]> {
    const project = {
      key: "projectId",
      label: "Google Cloud project (optional)",
      type: "text" as const,
      optional: true,
    };
    return [
      {
        id: "browser",
        label: "Sign in with Google",
        type: "oauth",
        kind: "browser",
        fields: [project],
      },
      {
        id: "files",
        label: "Import accounts from files",
        type: "oauth",
        kind: "import",
        description:
          "Imports Cockpit, Manager or CLIProxyAPI exports and refresh tokens. Each account and its Code Assist project are validated with Google.",
      },
      ...(this.channel === "gemini"
        ? [
            {
              id: "local",
              label: "Use Gemini CLI's signed-in account",
              type: "oauth" as const,
              kind: "local" as const,
              description:
                "Follows this Host's Gemini CLI account without changing its files. Detect again after changing the account in Gemini CLI.",
            },
          ]
        : []),
      {
        id: "import",
        label: "Import Google credential JSON",
        type: "oauth",
        kind: "credentials",
        fields: [
          { key: "credentials", label: "Credential JSON", type: "password", format: "json" },
          project,
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
    if (method === "local" && this.channel === "gemini")
      return {
        method: "auto" as const,
        complete: () => localAccount("gemini", this.localIO, signal),
      };
    if (method === "files")
      return importChallenge(this.channel, inputs, signal, async (item, bounded) => {
        let grant: AuthGrant = { type: "oauth", refresh: item.refresh, projectId: item.projectId };
        const context: AuthDriverContext = {
          read: async () => grant,
          write: async (next) => {
            grant = next;
          },
          signal: bounded,
        };
        grant = await this.fresh(context);
        const user = await json(this.request, "https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { authorization: `Bearer ${grant.access}` },
          signal: bounded,
        });
        const email = text(user.email);
        if (!email) throw new Error("Google did not identify the account");
        grant = {
          ...grant,
          email,
          accountId: text(user.id) || email,
          identityKey: accountIdentity(this.channel, email),
          displayName: safeDisplay(email),
        };
        return this.project(context);
      });
    const projectId = inputs.projectId?.trim() || undefined;
    if (projectId && !/^[a-z][a-z0-9-]{4,62}$/.test(projectId))
      throw new Error("Invalid Google Cloud project ID");
    if (method === "import") {
      return singleImport(await this.authorize("files", inputs, signal));
    }
    if (method !== "browser") throw new Error("Unknown authorization method");
    const app = APPS[this.channel];
    const scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ];
    if (this.channel === "antigravity")
      scopes.push(
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      );
    return browserChallenge({
      authorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
      callbackPath: this.channel === "gemini" ? "/oauth2callback" : "/oauth-callback",
      callbackHost: this.channel === "gemini" ? "127.0.0.1" : "localhost",
      signal,
      parameters: {
        client_id: app.clientId,
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
      },
      exchange: async (code, verifier, redirect) => {
        const token = await postForm(
          this.request,
          TOKEN,
          {
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: redirect,
            client_id: app.clientId,
            client_secret: app.clientSecret,
          },
          signal,
        );
        if (!text(token.access_token) || !text(token.refresh_token))
          throw new Error("Google returned no offline credential");
        const user = await json(
          this.request,
          "https://www.googleapis.com/oauth2/v2/userinfo?alt=json",
          { headers: { authorization: `Bearer ${text(token.access_token)}` }, signal },
        );
        return {
          type: "oauth",
          access: text(token.access_token),
          refresh: text(token.refresh_token),
          expires: expires(token),
          accountId: text(user.id),
          email: text(user.email),
          identityKey: accountIdentity(this.channel, text(user.email) || text(user.id)),
          displayName: safeDisplay(user.email),
          projectId,
        };
      },
    });
  }
  private async fresh(context: AuthDriverContext): Promise<AuthGrant> {
    return this.refreshOwner.fresh(context);
  }
  private call(
    grant: AuthGrant,
    method: string,
    body: Json,
    signal?: AbortSignal,
    base = this.base,
  ): Promise<Json> {
    return json(this.request, base + "/v1internal:" + method, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.access}`,
        "content-type": "application/json",
        "user-agent": this.userAgent,
      },
      body: JSON.stringify(body),
      signal: joinedSignal(signal, this.lifetime.signal),
    });
  }
  private async project(context: AuthDriverContext): Promise<AuthGrant> {
    const grant = await this.fresh(context);
    if (text(grant.projectId) && grant.projectReady === true) return grant;
    const signal = joinedSignal(context.signal, this.lifetime.signal);
    const next = await resolveGoogleProject(
      grant,
      this.channel,
      (method, body, bounded, base) => this.call(grant, method, body, bounded, base),
      signal,
    );
    signal.throwIfAborted();
    await context.write(next);
    return next;
  }
  async models(context: AuthDriverContext): Promise<readonly AuthModel[]> {
    return this.catalog.models(
      await this.project(context),
      joinedSignal(context.signal, this.lifetime.signal),
    );
  }
  async modelCatalog(context: AuthDriverContext) {
    const models = await this.models(context);
    return { models, fallback: this.catalog.fellBack };
  }
  async fetch(request: Request, context: AuthDriverContext): Promise<Response> {
    context = {
      ...context,
      signal: joinedSignal(request.signal, context.signal, this.lifetime.signal),
    };
    checkEndpoint(request, this.base + "/v1", ["/messages"]);
    if (request.method !== "POST") throw new Error("Provider endpoint requires POST");
    const body = record(await request.json());
    const grant = await this.project(context);
    const signal = joinedSignal(request.signal, context.signal, this.lifetime.signal);
    const model = await this.catalog.wire(
      grant,
      text(body.model),
      signal,
      text(record(body.output_config).effort),
    );
    const response = await this.request(this.base + "/v1internal:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.access}`,
        "content-type": "application/json",
        "user-agent": this.userAgent,
      },
      body: JSON.stringify(
        codeAssistRequest({ ...body, model }, this.channel, text(grant.projectId)),
      ),
      signal,
      redirect: "error",
    });
    return codeAssistResponse(response, text(body.model), body.stream === true, signal);
  }
  async quota(context: AuthDriverContext): Promise<unknown> {
    return this.catalog.quota(
      await this.project(context),
      joinedSignal(context.signal, this.lifetime.signal),
    );
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    await this.refreshOwner.drain();
  }
}
