import { isAbsolute, join } from "node:path";
import type { AuthGrant } from "../driver.js";
import { digest, jwt, record, text, type Json } from "./common.js";
import { accountIdentity, claudeIdentity, openAIIdentity, safeDisplay } from "./identity.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";
import { parseLocalJSON } from "./local-json.js";

type LocalChannel = "codex" | "claude" | "gemini" | "copilot";
const changed = () =>
  new Error("The local application changed account or signed out; detect its account again");
const pathOf = (io: LocalIO, key: string, fallback: string) =>
  io.environment[key] && isAbsolute(io.environment[key]!)
    ? io.environment[key]!
    : join(io.home, fallback);
async function object(io: LocalIO, path: string): Promise<Json> {
  try {
    return record(parseLocalJSON(await io.read(path)));
  } catch {
    return {};
  }
}
async function secret(
  io: LocalIO,
  service: string,
  account: string,
  signal: AbortSignal,
): Promise<string> {
  if (io.platform === "darwin")
    return io
      .run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], signal)
      .then((s) => s.trim())
      .catch(() => "");
  if (io.platform === "linux")
    for (const attribute of ["account", "username"]) {
      const value = await io
        .run("secret-tool", ["lookup", "service", service, attribute, account], signal)
        .catch(() => "");
      if (value.trim()) return value.trim();
    }
  return "";
}

async function codex(io: LocalIO): Promise<AuthGrant> {
  const path = join(pathOf(io, "CODEX_HOME", ".codex"), "auth.json");
  const raw = await object(io, path);
  const tokens = record(raw.tokens);
  if (raw.auth_mode === "apikey" || !text(tokens.access_token) || !text(tokens.refresh_token))
    throw changed();
  const grant = openAIIdentity(
    {
      type: "oauth",
      access: text(tokens.access_token),
      refresh: text(tokens.refresh_token),
      accountId: text(tokens.account_id),
      expires: Number(jwt(text(tokens.access_token)).exp) * 1000 || undefined,
    },
    text(tokens.id_token),
  );
  if (!grant.identityKey) throw new Error("The local Codex file does not identify its account");
  return {
    ...grant,
    localSource: { channel: "codex", path },
    localVersion: digest(JSON.stringify(raw)),
  };
}
async function claude(io: LocalIO, signal: AbortSignal): Promise<AuthGrant> {
  const dir = pathOf(io, "CLAUDE_CONFIG_DIR", ".claude");
  const custom = Boolean(
    io.environment.CLAUDE_CONFIG_DIR && isAbsolute(io.environment.CLAUDE_CONFIG_DIR),
  );
  let raw = await object(io, join(dir, ".credentials.json"));
  if (!text(record(raw.claudeAiOauth).refreshToken) && io.platform === "darwin") {
    const service =
      "Claude Code-credentials" + (custom ? "-" + digest(dir.normalize("NFC")).slice(0, 8) : "");
    const name = io.environment.USER || io.environment.USERNAME || "claude-code-user";
    let encoded = await secret(
      io,
      service,
      /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user",
      signal,
    );
    if (!encoded)
      encoded = await io
        .run("security", ["find-generic-password", "-s", service, "-w"], signal)
        .catch(() => "");
    try {
      raw = record(
        JSON.parse(
          encoded.trim().startsWith("{")
            ? encoded
            : Buffer.from(encoded.trim(), "hex").toString("utf8"),
        ),
      );
    } catch {
      /* Not a usable Keychain entry. */
    }
  }
  const oauth = record(raw.claudeAiOauth);
  if (!text(oauth.refreshToken)) throw changed();
  const profile = await object(
    io,
    custom ? join(dir, ".claude.json") : join(io.home, ".claude.json"),
  );
  let grant = claudeIdentity(
    {
      type: "oauth",
      access: text(oauth.accessToken),
      refresh: text(oauth.refreshToken),
      expires: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
      claudeCredentials: raw,
      plan: text(oauth.subscriptionType),
    },
    profile,
  );
  {
    let status: Json = {};
    try {
      status = record(
        JSON.parse(
          await io.run("claude", ["auth", "status", "--json"], signal, {
            CLAUDE_CONFIG_DIR: custom ? dir : undefined,
          }),
        ),
      );
    } catch {
      signal.throwIfAborted();
    }
    // CLI登出可能保留旧profile；必须听取auth status而不能只相信残留的邮箱。
    if (status.loggedIn === false) throw changed();
    const savedEmail = text(record(profile.oauthAccount).emailAddress);
    if (
      savedEmail &&
      text(status.email) &&
      savedEmail.toLowerCase() !== text(status.email).toLowerCase()
    )
      throw changed();
    grant = claudeIdentity(grant, profile, status);
  }
  if (!grant.identityKey)
    throw new Error("Claude Code did not identify the local account; sign in again");
  return { ...grant, localSource: { channel: "claude", dir, custom } };
}
async function gemini(io: LocalIO): Promise<AuthGrant> {
  const dir = join(io.home, ".gemini");
  const raw = await object(io, join(dir, "oauth_creds.json"));
  if (!text(raw.refresh_token)) throw changed();
  const client = text(jwt(text(raw.id_token)).aud);
  if (
    client &&
    client !== "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
  )
    throw new Error("The local credential belongs to another OAuth client");
  const accounts = await object(io, join(dir, "google_accounts.json"));
  const email = text(accounts.active) || text(jwt(text(raw.id_token)).email);
  const tokenEmail = text(jwt(text(raw.id_token)).email);
  if (tokenEmail && email && tokenEmail.toLowerCase() !== email.toLowerCase()) throw changed();
  if (!email) throw new Error("Gemini CLI did not identify its current account");
  const env = await io.read(join(dir, ".env")).catch(() => "");
  const project = /^\s*(?:export\s+)?GOOGLE_CLOUD_PROJECT\s*=\s*["']?([^\s"'#]+)/mu.exec(env)?.[1];
  return {
    type: "oauth",
    access: text(raw.access_token),
    refresh: text(raw.refresh_token),
    expires: typeof raw.expiry_date === "number" ? raw.expiry_date : undefined,
    email,
    identityKey: accountIdentity("gemini", email),
    displayName: safeDisplay(email),
    projectId: project,
    localProjectId: project,
    localVersion: digest(JSON.stringify({ raw, email, project })),
    localSource: { channel: "gemini", dir },
  };
}
function hostOf(input: string): string | undefined {
  try {
    const host = new URL(input.includes("://") ? input : `https://${input}`).hostname.toLowerCase();
    return host === "github.com" ? "" : /^[a-z0-9-]+\.ghe\.com$/u.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}
function copilotGrant(user: string, token: string, host: string, mode: string): AuthGrant {
  return {
    type: "oauth",
    access: token,
    username: user,
    accountId: user,
    host,
    copilotMode: mode,
    identityKey: accountIdentity("copilot", user, host || "github.com"),
    displayName: safeDisplay(user) + (host ? `@${host}` : ""),
  };
}
async function copilot(io: LocalIO, signal: AbortSignal): Promise<AuthGrant> {
  const cfg = pathOf(io, "XDG_CONFIG_HOME", ".config");
  let enterprise: AuthGrant | undefined;
  for (const file of ["apps.json", "hosts.json"]) {
    const raw = await object(io, join(cfg, "github-copilot", file));
    for (const key of Object.keys(raw).sort()) {
      const value = record(raw[key]),
        host = hostOf(key.split(":")[0] || "");
      const token = text(value.oauth_token) || text(value.token),
        user = text(value.user) || text(value.login);
      if (host === undefined || !token || !user) continue;
      const grant = {
        ...copilotGrant(user, token, host, "editor"),
        localSource: { channel: "copilot" },
      };
      if (!host) return grant;
      enterprise ??= grant;
    }
  }
  const dirs = [
    pathOf(io, "COPILOT_HOME", ".copilot"),
    ...(io.platform === "win32" && io.wslHomes ? await io.wslHomes().catch(() => []) : []).map(
      (home) => join(home, ".copilot"),
    ),
  ];
  for (const [index, dir] of dirs.entries()) {
    const raw = await object(io, join(dir, "config.json"));
    const users = [
      record(raw.lastLoggedInUser),
      ...(Array.isArray(raw.loggedInUsers) ? raw.loggedInUsers.map(record) : []),
    ];
    users.sort(
      (a, b) => Number(Boolean(hostOf(text(a.host)))) - Number(Boolean(hostOf(text(b.host)))),
    );
    for (const user of users) {
      const host = hostOf(text(user.host));
      const login = text(user.login);
      if (host === undefined || !login) continue;
      const key = `https://${host || "github.com"}:${login}`;
      let token = text(record(raw.copilotTokens)[key]);
      if (!token && index === 0) token = await secret(io, "copilot-cli", key, signal);
      if (token)
        return { ...copilotGrant(login, token, host, "cli"), localSource: { channel: "copilot" } };
    }
  }
  if (enterprise) return enterprise;
  throw changed();
}
export async function localAccount(
  channel: LocalChannel,
  io: LocalIO = defaultLocalIO,
  signal: AbortSignal = new AbortController().signal,
): Promise<AuthGrant> {
  signal.throwIfAborted();
  const grant = await (channel === "codex"
    ? codex(io)
    : channel === "claude"
      ? claude(io, signal)
      : channel === "gemini"
        ? gemini(io)
        : copilot(io, signal));
  signal.throwIfAborted();
  return grant;
}
export async function followLocal(
  grant: AuthGrant,
  io: LocalIO = defaultLocalIO,
  signal: AbortSignal = new AbortController().signal,
): Promise<AuthGrant> {
  const channel = text(record(grant.localSource).channel) as LocalChannel;
  if (!channel) return grant;
  const fresh = await localAccount(channel, io, signal);
  // 应用切号不能悄悄重用旧connectionId，否则实际调用和统计会归入另一账号。
  if (!grant.identityKey || fresh.identityKey !== grant.identityKey) throw changed();
  // Gemini本机文件是只读来源；同一文件快照不能覆盖本连接刚续期的access token或已解析project。
  if (channel === "gemini" && fresh.localVersion === grant.localVersion) return grant;
  const rotated = fresh.access !== grant.access || fresh.refresh !== grant.refresh;
  return {
    ...grant,
    ...fresh,
    ...(rotated ? { sessionToken: undefined, sessionExpires: undefined } : {}),
    ...(channel === "gemini"
      ? {
          projectId: fresh.projectId || grant.projectId,
          ...(fresh.localProjectId !== grant.localProjectId ? { projectReady: false } : {}),
        }
      : {}),
  };
}
export async function saveLocalCodex(
  previous: AuthGrant,
  next: AuthGrant,
  io: LocalIO = defaultLocalIO,
): Promise<void> {
  const source = record(previous.localSource);
  if (source.channel !== "codex") return;
  const raw = await object(io, text(source.path));
  if (digest(JSON.stringify(raw)) !== previous.localVersion)
    throw new Error("Codex credentials changed while refreshing; retry the request");
  const tokens = record(raw.tokens);
  await io.write(
    text(source.path),
    JSON.stringify(
      {
        ...raw,
        tokens: {
          ...tokens,
          access_token: next.access,
          refresh_token: next.refresh,
          ...(next.idToken ? { id_token: next.idToken } : {}),
          account_id: next.accountId,
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
}
