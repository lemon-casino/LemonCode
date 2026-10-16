import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuthWireProtocol } from "@lcode/provider-node";
import { RoutingError } from "@lcode/provider";
import { routingUsageSchema, type RoutingInvocation, type RoutingUsage } from "@lcode/shared";

const TICKET_CAPACITY = 4096,
  TICKET_TTL_MS = 5 * 60_000;
interface Ticket {
  channelId: string;
  modelId: string;
  protocol: AuthWireProtocol;
  expires: number;
  used?: boolean;
  active?: boolean;
  feedbackComplete?: boolean;
  sessionId?: string;
  routingInvocation?: RoutingInvocation;
}
export class ProviderAccountTransport {
  #server?: Server;
  #ready?: Promise<string>;
  readonly #tickets = new Map<string, Ticket>();
  readonly #controllers = new Set<AbortController>();
  constructor(
    private readonly execute: (ticket: Ticket, request: Request) => Promise<Response>,
    private readonly feedback?: (ticket: Ticket, usage: RoutingUsage) => void | Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}
  async issue(
    channelId: string,
    modelId: string,
    protocol: AuthWireProtocol,
    sessionId?: string,
    routingInvocation?: RoutingInvocation,
  ) {
    const baseURL = await (this.#ready ??= this.#start());
    for (const [key, ticket] of this.#tickets)
      if (!ticket.active && ticket.expires < this.now()) this.#tickets.delete(key);
    if (this.#tickets.size >= TICKET_CAPACITY) {
      const terminal = [...this.#tickets].find(
        ([, ticket]) => ticket.used && !ticket.active && ticket.feedbackComplete,
      );
      if (terminal) this.#tickets.delete(terminal[0]);
      else throw new RoutingError("quota-owner-capacity", { phase: "admission" });
    }
    const apiKey = randomBytes(32).toString("hex");
    this.#tickets.set(apiKey, {
      channelId,
      modelId,
      protocol,
      sessionId,
      routingInvocation,
      expires: this.now() + TICKET_TTL_MS,
    });
    return { baseURL, apiKey };
  }
  #start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void (async () => {
          let activeTicket: Ticket | undefined;
          const controller = new AbortController();
          this.#controllers.add(controller);
          res.on("close", () => {
            if (!res.writableFinished) controller.abort();
          });
          try {
            const token =
              req.headers.authorization?.replace(/^Bearer /u, "") ??
              String(req.headers["x-api-key"] ?? "");
            const ticket = this.#tickets.get(token);
            const path = req.url?.split("?")[0];
            const usageFeedback =
              path === "/v1/routing/usage" && this.feedback && ticket?.routingInvocation;
            const expected =
              ticket?.protocol === "anthropic-messages"
                ? "/v1/messages"
                : ticket?.protocol === "openai-responses"
                  ? "/v1/responses"
                  : "/v1/chat/completions";
            if (
              !ticket ||
              (!ticket.active && ticket.expires < this.now()) ||
              (!usageFeedback && ticket.used) ||
              req.method !== "POST" ||
              (path !== expected && !usageFeedback)
            ) {
              res.writeHead(403);
              res.end();
              return;
            }
            const parts: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 32 * 1024 * 1024) throw new Error("Model request exceeds 32 MiB");
              parts.push(Buffer.from(chunk));
            }
            const body = Buffer.concat(parts);
            const payload = JSON.parse(body.toString("utf8")) as { model?: string };
            if (usageFeedback) {
              const usage = routingUsageSchema.safeParse(payload);
              if (!usage.success) {
                res.writeHead(400);
                res.end();
                return;
              }
              await this.feedback!(ticket, usage.data);
              if (usage.data.outcome) ticket.feedbackComplete = true;
              res.writeHead(204);
              res.end();
              return;
            }
            if (payload.model !== ticket.modelId) {
              res.writeHead(400);
              res.end();
              return;
            }
            // 仅转发模型内容；本地票据、Host/Cookie 等请求头不得进入厂商网络。
            const headers = new Headers({ "content-type": "application/json" });
            if (ticket.sessionId) headers.set("x-lcode-session-id", ticket.sessionId);
            for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
              const value = req.headers[name];
              if (typeof value === "string") headers.set(name, value);
            }
            // 同一票据只授权一次物理 POST；长流仅延长归一反馈能力，不能成为重放入口。
            ticket.used = true;
            ticket.active = true;
            activeTicket = ticket;
            const response = await this.execute(
              ticket,
              new Request(`https://oauth.invalid${path}`, {
                method: "POST",
                headers,
                body,
                signal: controller.signal,
              }),
            );
            const responseHeaders: Record<string, string> = {};
            for (const name of [
              "content-type",
              "retry-after",
              "retry-after-ms",
              "x-lcode-rate-limit-scope",
              "x-zcode-connection-id",
              "x-zcode-routing-strategy",
              "x-zcode-routing-reason",
            ]) {
              const value = response.headers.get(name);
              if (value) responseHeaders[name] = value;
            }
            res.writeHead(response.status, responseHeaders);
            if (response.body)
              await pipeline(
                Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
                res,
              );
            else res.end();
          } catch (error) {
            if (!res.headersSent) {
              if (error instanceof RoutingError) {
                res.writeHead(error.retryable ? 503 : 409, {
                  "content-type": "application/json",
                  "x-zcode-routing-reason": error.code,
                  ...(error.details.retryAt !== undefined
                    ? {
                        "retry-after": String(
                          Math.max(0, Math.ceil((error.details.retryAt - this.now()) / 1000)),
                        ),
                      }
                    : {}),
                });
                res.end(
                  JSON.stringify({
                    error: {
                      code: error.code,
                      type: "routing_error",
                      message: error.code,
                      retryable: error.retryable,
                      routing: error.details,
                    },
                  }),
                );
                return;
              }
              res.writeHead(502, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  error: { message: "OAuth model request failed", type: "provider_error" },
                }),
              );
            } else res.destroy();
          } finally {
            if (activeTicket) {
              activeTicket.active = false;
              activeTicket.expires = this.now() + TICKET_TTL_MS;
            }
            this.#controllers.delete(controller);
          }
        })();
      });
      this.#server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("OAuth transport unavailable"));
          return;
        }
        server.unref();
        resolve(`http://127.0.0.1:${address.port}/v1`);
      });
    });
  }
  dispose(): void {
    for (const controller of this.#controllers) controller.abort();
    this.#tickets.clear();
    this.#server?.closeAllConnections();
    this.#server?.close();
  }
}
