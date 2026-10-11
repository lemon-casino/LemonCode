import { randomUUID } from "node:crypto";
import { record, text, type Json } from "./common.js";

/** One externally visible Anthropic turn; the CLI can remain parked at an MCP call. */
export class ClaudeOutput {
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private resolve!: (response: Response) => void;
  private readonly done: Promise<Response>;
  private readonly content: Json[] = [];
  private readonly inputs = new Map<number, string>();
  private message: Json;
  private closed = false;
  private readonly abort: () => void;
  private streamResponse?: Response;
  readonly response: Promise<Response>;
  constructor(
    model: string,
    stream: boolean,
    private readonly signal: AbortSignal,
    cancel: () => void,
  ) {
    this.message = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    this.done = new Promise<Response>((resolve) => {
      this.resolve = resolve;
    });
    this.abort = () => {
      this.fail("Claude request cancelled");
      cancel();
    };
    signal.addEventListener("abort", this.abort, { once: true });
    if (stream) {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.close();
          cancel();
        },
      });
      this.streamResponse = new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    this.response = this.done;
    if (signal.aborted) this.abort();
  }
  event(event: Json): void {
    if (this.closed) return;
    // 首个厂商事件之前的CLI失败仍是HTTP失败，账号池才能在尚未输出时切换账号。
    if (this.streamResponse) this.resolve(this.streamResponse);
    const index = typeof event.index === "number" ? event.index : 0;
    const block = record(event.content_block);
    const delta = record(event.delta);
    switch (event.type) {
      case "message_start":
        this.message = { ...this.message, ...record(event.message) };
        break;
      case "content_block_start":
        this.content[index] = { ...block };
        break;
      case "content_block_delta": {
        const target = this.content[index];
        if (!target) break;
        if (delta.type === "text_delta") target.text = text(target.text) + text(delta.text);
        if (delta.type === "thinking_delta")
          target.thinking = text(target.thinking) + text(delta.thinking);
        if (delta.type === "signature_delta")
          target.signature = text(target.signature) + text(delta.signature);
        if (delta.type === "input_json_delta")
          this.inputs.set(index, (this.inputs.get(index) ?? "") + text(delta.partial_json));
        break;
      }
      case "content_block_stop": {
        const input = this.inputs.get(index);
        if (input && this.content[index]) {
          try {
            this.content[index].input = JSON.parse(input);
          } catch {
            this.fail("Claude returned invalid tool arguments");
            return;
          }
        }
        break;
      }
      case "message_delta":
        this.message = {
          ...this.message,
          ...delta,
          usage: { ...record(this.message.usage), ...record(event.usage) },
        };
        break;
    }
    this.controller?.enqueue(
      new TextEncoder().encode(`event: ${text(event.type)}\ndata: ${JSON.stringify(event)}\n\n`),
    );
    if (event.type === "message_stop") this.finish();
  }
  fail(message: string): void {
    if (this.closed) return;
    const error = { type: "error", error: { type: "api_error", message } };
    this.controller?.enqueue(
      new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(error)}\n\n`),
    );
    this.resolve(Response.json(error, { status: 502 }));
    this.close();
  }
  private finish(): void {
    this.resolve(Response.json({ ...this.message, content: this.content }));
    this.close();
  }
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    try {
      this.controller?.close();
    } catch {
      /* ReadableStream cancellation already closed the consumer side. */
    }
  }
}
