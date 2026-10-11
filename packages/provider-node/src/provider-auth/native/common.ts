import { createHash } from "node:crypto";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

export type Json = Record<string, unknown>;
export type Fetcher = typeof fetch;
export const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export function jwt(token: string): Json {
  try {
    return record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

export function expires(token: Json): number {
  return Date.now() + (number(token.expires_in) ?? 3600) * 1000;
}

export async function requireGrant(context: AuthDriverContext): Promise<AuthGrant> {
  context.signal?.throwIfAborted();
  const grant = await context.read();
  if (!grant) throw new Error("Provider account is signed out");
  return grant;
}

export function joinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

export async function json(fetcher: Fetcher, url: string, init: RequestInit = {}): Promise<Json> {
  const response = await fetcher(url, { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    // 授权响应可能包含 token 或邮箱，不把远端正文拼接到可见错误。
    throw new Error(`Provider request failed (HTTP ${response.status})`);
  }
  return record(await response.json());
}

export async function postForm(
  fetcher: Fetcher,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<Json> {
  return json(fetcher, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
    signal,
  });
}

export function checkEndpoint(request: Request, base: string, paths: readonly string[]): void {
  const url = new URL(request.url);
  const root = new URL(base);
  const suffix = url.pathname.slice(root.pathname.replace(/\/$/, "").length);
  if (
    url.origin !== root.origin ||
    !url.pathname.startsWith(root.pathname.replace(/\/$/, "") + "/") ||
    !paths.includes(suffix) ||
    url.username ||
    url.password
  ) {
    throw new Error("Provider endpoint is not allowed");
  }
}

export function importedGrant(raw: string): AuthGrant {
  let data: Json;
  try {
    data = record(JSON.parse(raw));
  } catch {
    throw new Error("Invalid credential JSON");
  }
  const tokens = record(data.tokens);
  const source = Object.keys(tokens).length ? tokens : data;
  const access = text(source.access) || text(source.access_token);
  const refresh = text(source.refresh) || text(source.refresh_token);
  if (!access || !refresh) throw new Error("The credential must contain access and refresh tokens");
  return {
    ...source,
    type: "oauth",
    access,
    refresh,
    expires:
      number(source.expires) ?? number(source.expiry_date) ?? (number(jwt(access).exp) ?? 0) * 1000,
    accountId: text(source.accountId) || text(source.account_id) || undefined,
  };
}

export async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Authorization cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function* sseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (payload && payload !== "[DONE]") yield record(JSON.parse(payload));
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
