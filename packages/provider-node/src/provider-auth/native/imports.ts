import type { AuthChallenge, AuthGrant, AuthImportEntry } from "../driver.js";
import { joinedSignal, list, record, text, type Json } from "./common.js";

export type ImportChannel = "codex" | "claude" | "gemini" | "antigravity";
export interface ImportAccount {
  access?: string;
  refresh?: string;
  idToken?: string;
  accountId?: string;
  email?: string;
  projectId?: string;
  credentials?: Json;
  error?: string;
}
const field = (value: Json, ...keys: string[]) => keys.map((key) => text(value[key])).find(Boolean);
const failed = (error: string): ImportAccount => ({ error });

function boundedValidation<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Import validation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    // 传输若忽略signal，批次仍须按时结束；迟到结果没有任何持久化入口。
    void Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function account(channel: ImportChannel, value: unknown): ImportAccount {
  if (typeof value === "string")
    return value.trim() ? { refresh: value.trim() } : failed("No refresh token");
  const raw = record(value);
  if (!Object.keys(raw).length) return failed("Not an account");
  const platform = text(raw.platform).toLowerCase();
  const type = text(raw.type).toLowerCase();
  let source = raw;
  if (raw.credentials && platform) {
    const expected = channel === "codex" ? "openai" : channel === "claude" ? "anthropic" : channel;
    if (platform !== expected && !(channel === "claude" && platform === "claude"))
      return failed("Account belongs to another provider");
    if (type !== "oauth") return failed("An OAuth sign-in is required, not an API key");
    source = record(raw.credentials);
  } else {
    if (type && type !== channel && type !== "oauth" && type !== "oauth_tokens")
      return failed("Account belongs to another provider");
    if ((raw.claudeAiOauth && channel !== "claude") || (raw.tokens && channel !== "codex"))
      return failed("Account belongs to another provider");
    if (channel === "codex" && raw.tokens) source = record(raw.tokens);
    if (channel === "claude" && raw.claudeAiOauth) source = record(raw.claudeAiOauth);
    if ((channel === "gemini" || channel === "antigravity") && raw.token)
      source = record(raw.token);
  }
  const refresh = field(source, "refresh_token", "refreshToken", "refresh");
  if (!refresh)
    return failed(
      "A refresh token is required; access-only sessions and API keys cannot be imported",
    );
  if (text(raw.kind) === "api_key" || text(raw.auth_mode) === "apikey")
    return failed("An OAuth sign-in is required, not an API key");
  const email =
    field(source, "email") ||
    field(raw, "email") ||
    (text(raw.name).includes("@") ? text(raw.name) : undefined);
  // Magpie同时接受scopes数组和空格分隔字符串；明确权限不能被默认更宽权限覆盖。
  const scopes = (
    typeof source.scopes === "string" ? source.scopes.split(/\s/u) : list(source.scopes)
  )
    .map(text)
    .filter(Boolean);
  return {
    refresh,
    email,
    access: field(source, "access_token", "accessToken", "access"),
    idToken: field(source, "id_token", "idToken"),
    accountId: field(source, "chatgpt_account_id", "account_id", "accountId", "openAIAccountId"),
    projectId: field(source, "project_id", "projectId", "project"),
    ...(channel === "claude"
      ? {
          credentials: {
            claudeAiOauth: {
              ...source,
              accessToken: field(source, "access_token", "accessToken", "access") || "",
              refreshToken: refresh,
              expiresAt: 1,
              scopes: scopes.length
                ? scopes
                : [
                    "user:inference",
                    "user:profile",
                    "user:sessions:claude_code",
                    "user:mcp_servers",
                  ],
            },
            ...(email ? { email } : {}),
          },
        }
      : {}),
  };
}

function parse(channel: ImportChannel, contents: string): ImportAccount[] {
  const source = contents.replace(/^\uFEFF/u, "").trim();
  if (!source) return [failed("Nothing to import")];
  if (!source.startsWith("{") && !source.startsWith("["))
    return source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => (/\s/u.test(line) ? failed("Not a refresh token") : { refresh: line }));
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return [failed("Invalid JSON")];
  }
  const result: ImportAccount[] = [];
  const walk = (input: unknown, depth = 0): void => {
    if (result.length > 200 || depth > 10)
      throw new Error("At most 200 accounts with bounded nesting can be imported");
    if (Array.isArray(input)) {
      for (const item of input) walk(item, depth + 1);
      return;
    }
    const raw = record(input);
    if (channel === "codex" && Array.isArray(raw.providers)) {
      const rows = list(raw.providers).flatMap((p) =>
        text(record(p).kind) === "openai_oauth" ? list(record(p).accounts) : [],
      );
      rows.push(...list(record(raw.openAI).remoteConnectionAccounts));
      const seen = new Set<string>();
      for (const row of rows) {
        const entry = account(channel, row);
        if (entry.refresh && seen.has(entry.refresh)) continue;
        if (entry.refresh) seen.add(entry.refresh);
        result.push(entry);
      }
      return;
    }
    if (Array.isArray(raw.accounts) && !field(raw, "refresh_token", "refreshToken", "refresh")) {
      walk(raw.accounts, depth + 1);
      return;
    }
    result.push(account(channel, input));
  };
  walk(value);
  return result.length ? result : [failed("No accounts in this file")];
}

export function parseImportFiles(channel: ImportChannel, files: string): ImportAccount[] {
  let raw: unknown;
  try {
    raw = JSON.parse(files);
  } catch {
    throw new Error("Invalid import file list");
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200)
    throw new Error("Choose between 1 and 200 files");
  let total = 0;
  const out: ImportAccount[] = [];
  for (const file of raw) {
    const content = record(file).content;
    if (typeof content !== "string") throw new Error("Import files require text content");
    const size = Buffer.byteLength(content, "utf8");
    total += size;
    if (size > 4 * 1024 * 1024 || total > 8 * 1024 * 1024)
      throw new Error("Import file size exceeds 4 MiB per file or 8 MiB total");
    out.push(...parse(channel, content));
    if (out.length > 200) throw new Error("At most 200 accounts can be imported");
  }
  return out;
}

export function importChallenge(
  channel: ImportChannel,
  inputs: Record<string, string>,
  signal: AbortSignal,
  validate: (item: ImportAccount, signal: AbortSignal) => Promise<AuthGrant>,
  deadlines: { totalMs?: number; itemMs?: number } = {},
): AuthChallenge {
  const items = parseImportFiles(
    channel,
    inputs.files || JSON.stringify([{ content: inputs.credentials || "" }]),
  );
  const controller = new AbortController();
  const cancellation = joinedSignal(signal, controller.signal);
  const outer = joinedSignal(cancellation, AbortSignal.timeout(deadlines.totalMs ?? 180_000));
  let completion: Promise<readonly AuthImportEntry[]> | undefined;
  return {
    method: "auto",
    cancel: () => controller.abort(),
    complete: async () => {
      throw new Error("This method imports multiple accounts");
    },
    completeMany: () =>
      (completion ??= (async () => {
        const result: AuthImportEntry[] = Array.from({ length: items.length }, () => ({
          status: "failed",
          error: "Import deadline exceeded before this account was validated",
        }));
        const seen = new Set<string>();
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, items.length) }, async () => {
            while (next < items.length) {
              cancellation.throwIfAborted();
              if (outer.aborted) return;
              const index = next++;
              const item = items[index]!;
              const label = `Account ${index + 1}`;
              if (item.error) {
                result[index] = { status: "failed", label, error: item.error };
                continue;
              }
              if (item.refresh && seen.has(item.refresh)) {
                result[index] = { status: "exists", label };
                continue;
              }
              if (item.refresh) seen.add(item.refresh);
              const bounded = joinedSignal(outer, AbortSignal.timeout(deadlines.itemMs ?? 45_000));
              try {
                const grant = await boundedValidation(bounded, () => validate(item, bounded));
                bounded.throwIfAborted();
                result[index] = { status: "ready", grant, label: text(grant.displayName) || label };
              } catch {
                cancellation.throwIfAborted();
                result[index] = {
                  status: "failed",
                  label,
                  error: bounded.aborted
                    ? "Account validation timed out"
                    : "Account could not be validated; sign in again or check the export",
                };
              }
            }
          }),
        );
        // 总时限与用户取消不同：已续期成功的账号不能因另一项卡住而丢失轮换后的凭据。
        cancellation.throwIfAborted();
        return result;
      })()),
  };
}

export function singleImport(challenge: AuthChallenge): AuthChallenge {
  return {
    method: "auto",
    cancel: challenge.cancel,
    complete: async () => {
      const results = await challenge.completeMany?.();
      if (results?.length !== 1 || results[0]?.status !== "ready")
        throw new Error("Credential could not be validated; use file import for multiple accounts");
      return results[0].grant;
    },
  };
}
