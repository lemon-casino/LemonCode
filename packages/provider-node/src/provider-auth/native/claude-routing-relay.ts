import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Fetcher } from "./common.js";
const MAX_BODY = 16_777_216;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Attempt {
  signal: AbortSignal;
  controller: AbortController;
  used: boolean;
  done: Promise<void>;
  fault: { promise: Promise<Response>; resolve(value: Response): void };
}
/** CLI 仍拥有工具会话；relay 仅约束原 turn 的物理出口，不做重试或凭据刷新。 */
export class ClaudeRoutingRelay {
  private readonly capability = "/routing/" + randomBytes(24).toString("hex");
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<void>>();
  private readonly server = createServer((req, res) => {
    const operation = this.handle(req, res);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation));
  });
  private attempt?: Attempt;
  private closing?: Promise<void>;
  constructor(private readonly fetcher: Fetcher) {}
  async start(signal: AbortSignal): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    await this.begin(signal);
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Claude routing relay unavailable");
    return "http://127.0.0.1:" + address.port + this.capability;
  }
  async begin(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.attempt?.done;
    signal.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    this.attempt = {
      controller,
      signal: AbortSignal.any([signal, this.lifetime.signal, controller.signal]),
      used: false,
      done: Promise.resolve(),
      fault: deferred<Response>(),
    };
  }
  async response(output: Promise<Response>): Promise<Response> {
    const attempt = this.attempt!;
    const result = await Promise.race([
      output.then((response) => ({ response, fault: false })),
      attempt.fault.promise.then((response) => ({ response, fault: true })),
    ]);
    if (result.fault) return result.response;
    const reader = result.response.body?.getReader();
    if (!reader) return result.response;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            await attempt.done;
            if (!attempt.used) throw new Error("Claude bypassed the routing relay");
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        // 输出取消必须取消原物理流并等到真实结束，不能先释放路由并发槽。
        attempt.controller.abort(reason);
        try {
          await reader.cancel(reason);
        } finally {
          await attempt.done;
        }
      },
    });
    return new Response(stream, {
      status: result.response.status,
      headers: result.response.headers,
    });
  }
  private fail(attempt: Attempt, status: number, headers = new Headers()): Response {
    const forwarded = new Headers(headers);
    for (const key of ["content-length", "content-encoding", "transfer-encoding"])
      forwarded.delete(key);
    forwarded.set("content-type", "application/json");
    const response = new Response(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "Claude provider request failed" },
      }),
      { status, headers: forwarded },
    );
    attempt.fault.resolve(response.clone());
    return response;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const attempt = this.attempt;
    try {
      const path = new URL(req.url ?? "/", "http://relay").pathname;
      const suffix = path.slice(this.capability.length);
      if (
        !path.startsWith(this.capability + "/") ||
        req.method !== "POST" ||
        !["/v1/messages", "/v1/messages/count_tokens"].includes(suffix) ||
        !attempt
      ) {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      const inference = suffix === "/v1/messages";
      if (inference && attempt.used) {
        req.resume();
        await attempt.done;
        const denied = this.fail(attempt, 502);
        res.writeHead(denied.status, Object.fromEntries(denied.headers));
        res.end(await denied.text());
        return;
      }
      if (inference) attempt.used = true;
      const done = deferred<void>();
      if (inference) attempt.done = done.promise;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) throw new Error("Claude request too large");
          chunks.push(Buffer.from(chunk));
        }
        attempt.signal.throwIfAborted();
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (
            value !== undefined &&
            ![
              "host",
              "connection",
              "content-length",
              "transfer-encoding",
              "accept-encoding",
            ].includes(key)
          )
            headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const response = await this.fetcher("https://api.anthropic.com" + suffix, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
          signal: attempt.signal,
          redirect: "error",
        });
        if (!response.ok && inference) {
          await response.body?.cancel();
          const failure = this.fail(attempt, response.status, response.headers);
          res.writeHead(failure.status, Object.fromEntries(failure.headers));
          res.end(await failure.text());
          return;
        }
        const out = new Headers(response.headers);
        for (const key of ["content-length", "content-encoding", "transfer-encoding"])
          out.delete(key);
        res.writeHead(response.status, Object.fromEntries(out));
        if (response.body)
          await pipeline(
            Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
            res,
            { signal: attempt.signal },
          );
        else res.end();
      } finally {
        done.resolve();
      }
    } catch {
      if (attempt) {
        const failure = this.fail(attempt, 502);
        if (!res.headersSent) res.writeHead(502, Object.fromEntries(failure.headers));
        if (!res.destroyed) res.end(await failure.text());
      } else if (!res.headersSent) res.writeHead(502).end();
    }
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    this.server.closeAllConnections();
    this.closing = (async () => {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      await Promise.allSettled(this.operations);
    })();
    return this.closing;
  }
}
