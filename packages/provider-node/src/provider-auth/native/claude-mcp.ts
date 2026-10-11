import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { list, record, text, type Json } from "./common.js";

interface PendingCall {
  name: string;
  args: unknown;
  response: ServerResponse;
  id: unknown;
}
interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}
export class ClaudeTools {
  private readonly token = randomBytes(32).toString("hex");
  private readonly path = "/" + randomBytes(24).toString("hex");
  private server?: Server;
  private readonly pending: PendingCall[] = [];
  private readonly uses: ToolUse[] = [];
  private readonly results = new Map<string, Json>();
  private readonly delivered = new Set<string>();
  constructor(private readonly tools: Json[]) {}
  async start(): Promise<Json> {
    this.server = createServer((request, response) => {
      if (request.url !== this.path || request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      void (async () => {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 4_194_304) throw new Error("MCP request too large");
        }
        const rpc = record(JSON.parse(body));
        const params = record(rpc.params);
        if (text(rpc.method).startsWith("notifications/")) {
          response.writeHead(202).end();
          return;
        }
        switch (rpc.method) {
          case "initialize":
            this.reply(response, rpc.id, {
              protocolVersion: text(params.protocolVersion) || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "lcode-external-tools", version: "1" },
            });
            break;
          case "ping":
            this.reply(response, rpc.id, {});
            break;
          case "tools/list":
            this.reply(response, rpc.id, {
              tools: this.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.input_schema ?? { type: "object", properties: {} },
              })),
            });
            break;
          case "tools/call": {
            if (!this.tools.some((tool) => tool.name === params.name)) {
              this.reply(response, rpc.id, {
                isError: true,
                content: [{ type: "text", text: "Unknown external tool" }],
              });
              break;
            }
            this.pending.push({
              name: text(params.name),
              args: params.arguments,
              response,
              id: rpc.id,
            });
            this.flush();
            break;
          }
          default:
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32601, message: "Method not found" },
              }),
            );
        }
      })().catch(() => {
        if (!response.writableEnded) response.writeHead(400).end();
      });
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Claude tool bridge failed to listen");
    return {
      mcpServers: {
        lcode: {
          type: "http",
          url: `http://127.0.0.1:${address.port}${this.path}`,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    };
  }
  use(id: string, name: string, input: unknown): void {
    this.uses.push({ id, name, input });
    this.flush();
  }
  accepts(blocks: Json[]): boolean {
    return (
      blocks.length > 0 &&
      blocks.every(
        (block) =>
          this.uses.some((use) => use.id === block.tool_use_id) &&
          !this.delivered.has(text(block.tool_use_id)),
      )
    );
  }
  provide(blocks: Json[]): void {
    for (const block of blocks) this.results.set(text(block.tool_use_id), block);
    this.flush();
  }
  private flush(): void {
    for (const call of this.pending.slice()) {
      const use = this.uses.find(
        (use) =>
          use.name === call.name &&
          !this.delivered.has(use.id) &&
          isDeepStrictEqual(use.input, call.args ?? {}),
      );
      if (!use) continue;
      const result = this.results.get(use.id);
      if (!result) continue;
      const content =
        typeof result.content === "string"
          ? [{ type: "text", text: result.content }]
          : list(result.content).map((item) => {
              const block = record(item);
              const source = record(block.source);
              return block.type === "image" && source.type === "base64"
                ? { type: "image", data: source.data, mimeType: source.media_type }
                : block.type === "text"
                  ? block
                  : { type: "text", text: JSON.stringify(block) };
            });
      this.reply(call.response, call.id, { content, isError: result.is_error === true });
      this.delivered.add(use.id);
      this.results.delete(use.id);
      this.pending.splice(this.pending.indexOf(call), 1);
    }
  }
  private reply(response: ServerResponse, id: unknown, result: unknown): void {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  dispose(): void {
    for (const call of this.pending)
      if (!call.response.writableEnded) call.response.writeHead(503).end();
    this.pending.length = 0;
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
