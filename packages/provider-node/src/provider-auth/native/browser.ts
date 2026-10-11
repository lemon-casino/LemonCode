import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AuthChallenge, AuthGrant } from "../driver.js";

export interface BrowserOptions {
  authorizeURL: string;
  parameters: Record<string, string>;
  signal: AbortSignal;
  port?: number;
  callbackPath?: string;
  callbackHost?: "localhost" | "127.0.0.1";
  exchange(
    code: string,
    verifier: string,
    redirect: string,
    query: URLSearchParams,
  ): Promise<AuthGrant>;
}

/** A flow owns its loopback listener; no accepted credential escapes before complete(). */
export async function browserChallenge(options: BrowserOptions): Promise<AuthChallenge> {
  options.signal.throwIfAborted();
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const path = options.callbackPath ?? "/auth/callback";
  let resolve!: (grant: AuthGrant) => void;
  let reject!: (error: Error) => void;
  let closed = false;
  let claimed = false;
  let redirect = "";
  const done = new Promise<AuthGrant>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // complete() 可能在浏览器回调之后才调用；提前处理拒绝避免取消造成未处理 rejection。
  void done.catch(() => {});
  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  };
  const abort = () => {
    if (!closed) {
      cleanup();
      reject(new Error("Authorization cancelled"));
    }
  };
  const accept = async (url: URL): Promise<boolean> => {
    if (closed || claimed || url.pathname !== path || url.searchParams.get("state") !== state)
      return false;
    if (url.searchParams.has("error")) {
      cleanup();
      reject(new Error("Authorization was declined"));
      return true;
    }
    const code = url.searchParams.get("code");
    if (!code) return false;
    claimed = true;
    try {
      const grant = await options.exchange(code, verifier, redirect, url.searchParams);
      options.signal.throwIfAborted();
      if (!closed) {
        resolve(grant);
        cleanup();
      }
    } catch {
      if (!closed) {
        reject(new Error("Authorization token exchange failed"));
        cleanup();
      }
    }
    return true;
  };
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", redirect);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (
      url.pathname !== path ||
      url.searchParams.get("state") !== state ||
      (!url.searchParams.has("code") && !url.searchParams.has("error"))
    ) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Invalid authorization callback");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
      .end("Authorization received. Return to LCode.");
    void accept(url);
  });
  const timer = setTimeout(abort, 10 * 60_000);
  timer.unref();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(options.port ?? 0, "127.0.0.1", yes);
    });
    options.signal.throwIfAborted();
  } catch (error) {
    cleanup();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    cleanup();
    throw new Error("Cannot start authorization callback");
  }
  redirect = `http://${options.callbackHost ?? "127.0.0.1"}:${address.port}${path}`;
  const url = new URL(options.authorizeURL);
  for (const [key, value] of Object.entries(options.parameters)) url.searchParams.set(key, value);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  return {
    url: url.href,
    method: "auto",
    cancel: abort,
    async complete(callback) {
      if (callback) {
        let pasted: URL;
        try {
          pasted = new URL(callback);
        } catch {
          throw new Error("Paste the complete authorization callback URL");
        }
        const expected = new URL(redirect);
        if (
          pasted.origin !== expected.origin ||
          pasted.pathname !== expected.pathname ||
          pasted.searchParams.get("state") !== state
        )
          throw new Error("This callback belongs to another authorization attempt");
        await accept(pasted);
      }
      return done;
    },
  };
}
