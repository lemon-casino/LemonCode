import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digest, list, record, text, type Json } from "./common.js";
import type { ClaudeSpawner } from "./claude-process.js";
import { ClaudeOutput } from "./claude-output.js";
import { ClaudeTools } from "./claude-mcp.js";
import { closeClaudeChild } from "./claude-close.js";

export type { ClaudeSpawner } from "./claude-process.js";
export class ClaudeSession {
  private child?: ChildProcessWithoutNullStreams;
  private output?: ClaudeOutput;
  private readonly tools: ClaudeTools;
  private readonly blocks = new Map<
    number,
    { id: string; name: string; input: string; initial: unknown }
  >();
  private awaitingTools = false;
  private terminated = false;
  private timer?: ReturnType<typeof setTimeout>;
  private ended: Promise<void> = Promise.resolve();
  private readonly namespace = randomBytes(10).toString("hex");
  private messages: unknown[];
  constructor(
    private readonly body: Json,
    private readonly dir: string,
    private readonly spawn: ClaudeSpawner,
    private readonly finish: () => Promise<void>,
  ) {
    this.tools = new ClaudeTools(list(body.tools).map(record));
    this.messages = list(body.messages);
  }
  get closed(): boolean {
    return this.terminated;
  }
  accepts(body: Json): boolean {
    return (
      !this.terminated &&
      this.awaitingTools &&
      body.model === this.body.model &&
      ["system", "tools", "tool_choice", "thinking", "output_config"].every((key) =>
        isDeepStrictEqual(withoutCache(body[key]), withoutCache(this.body[key])),
      ) &&
      isDeepStrictEqual(
        withoutCache(list(body.messages).slice(0, this.messages.length)),
        withoutCache(this.messages),
      ) &&
      this.tools.accepts(toolResults(body))
    );
  }
  async start(signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const config = await this.tools.start();
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      text(this.body.model),
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(config),
      "--setting-sources",
      "",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ];
    const system =
      typeof this.body.system === "string"
        ? this.body.system
        : list(this.body.system)
            .map((item) => text(record(item).text))
            .join("\n");
    if (system) args.push("--append-system-prompt", system);
    const reasoning = record(this.body.thinking);
    const effort = text(record(this.body.output_config).effort);
    if (["low", "medium", "high", "xhigh", "max"].includes(effort))
      args.push("--effort", effort, "--thinking-display", "summarized");
    const env: NodeJS.ProcessEnv = {};
    if (reasoning.type === "enabled" && typeof reasoning.budget_tokens === "number")
      env.MAX_THINKING_TOKENS = String(reasoning.budget_tokens);
    if (reasoning.type === "disabled") env.MAX_THINKING_TOKENS = "0";
    if (typeof this.body.max_tokens === "number")
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(this.body.max_tokens);
    this.output = new ClaudeOutput(text(this.body.model), this.body.stream === true, signal, () =>
      this.dispose(),
    );
    try {
      const child = await this.spawn(args, this.dir, env);
      this.child = child;
      this.ended = new Promise<void>((resolve) => {
        child.once("close", resolve);
      });
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 16_777_216) {
          this.fail("Claude returned an oversized protocol frame");
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            this.event(record(JSON.parse(line)));
          } catch {
            this.fail("Claude returned an invalid protocol frame");
          }
        }
      });
      // CLI diagnostics can contain prompt content. Drain them without exposing raw output.
      child.stderr.resume();
      child.once("error", () =>
        this.fail("Claude Code CLI is unavailable; install it or set LCODE_CLAUDE_BIN"),
      );
      child.once("close", () => {
        if (!this.terminated) this.fail("Claude Code ended before completing the request");
      });
      await new Promise<void>((resolve, reject) => {
        if (child.pid) {
          resolve();
          return;
        }
        child.once("spawn", resolve);
        child.once("error", () =>
          reject(new Error("Claude Code CLI is unavailable; install it or set LCODE_CLAUDE_BIN")),
        );
      });
      if (signal.aborted || this.terminated) {
        closeClaudeChild(child, this.ended);
        throw new Error("Claude request cancelled");
      }
      child.stdin.write(
        JSON.stringify({
          type: "user",
          session_id: "",
          message: { role: "user", content: promptContent(this.body) },
          parent_tool_use_id: null,
        }) + "\n",
      );
      this.resetDeadline();
      return this.output.response;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  continue(body: Json, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    if (!this.accepts(body)) throw new Error("Claude tool results do not match the active request");
    this.awaitingTools = false;
    this.messages = list(body.messages);
    this.output = new ClaudeOutput(text(body.model), body.stream === true, signal, () =>
      this.dispose(),
    );
    this.tools.provide(toolResults(body));
    this.resetDeadline();
    return this.output.response;
  }
  private event(frame: Json): void {
    if (this.terminated) return;
    this.resetDeadline();
    if (frame.type === "result") {
      if (frame.is_error) this.fail("Claude Code model request failed");
      else {
        void this.finish()
          .catch(() => {})
          .finally(() => this.dispose());
      }
      return;
    }
    if (frame.type !== "stream_event") return;
    const event = record(frame.event);
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start") {
      const block = record(event.content_block);
      if (block.type === "tool_use") {
        const name = text(block.name).replace(/^mcp__lcode__/, "");
        if (!list(this.body.tools).some((tool) => record(tool).name === name)) {
          this.fail("Claude requested an unavailable external tool");
          return;
        }
        // CLI的tool_use_id只在自己的会话内唯一；对外加随机run命名空间，防并发对话交叉续接。
        const id = `toolu_lcode_${this.namespace}_${digest(text(block.id)).slice(0, 20)}`;
        event.content_block = { ...block, id, name };
        this.blocks.set(index, { id, name, input: "", initial: block.input });
      }
    }
    if (event.type === "content_block_delta" && record(event.delta).type === "input_json_delta") {
      const block = this.blocks.get(index);
      if (block) block.input += text(record(event.delta).partial_json);
    }
    if (event.type === "content_block_stop") {
      const block = this.blocks.get(index);
      if (block) {
        this.tools.use(
          block.id,
          block.name,
          block.input ? JSON.parse(block.input) : (block.initial ?? {}),
        );
        this.blocks.delete(index);
      }
    }
    if (event.type === "message_delta")
      this.awaitingTools = record(event.delta).stop_reason === "tool_use";
    this.output?.event(event);
  }
  private resetDeadline(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail("Claude request or external tool result timed out"),
      15 * 60_000,
    );
    this.timer.unref();
  }
  private fail(message: string): void {
    this.output?.fail(message);
    this.dispose();
  }
  dispose(): void {
    if (this.terminated) return;
    this.terminated = true;
    clearTimeout(this.timer);
    this.tools.dispose();
    if (this.child) closeClaudeChild(this.child, this.ended);
    this.output?.fail("Claude request closed");
  }
  waitClosed(): Promise<void> {
    return this.ended;
  }
}

function toolResults(body: Json): Json[] {
  const last = record(list(body.messages).at(-1));
  return list(last.content)
    .map(record)
    .filter((block) => block.type === "tool_result");
}
function withoutCache(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCache(item)]),
  );
}
function promptContent(body: Json): unknown[] {
  const messages = list(body.messages).map(record);
  const last = messages.at(-1);
  if (!last || last.role !== "user") throw new Error("Claude Code requires a final user message");
  const content =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : list(last.content);
  if (messages.length === 1) return content;
  // CLI公开stream-json入口只接受user输入；冷启动历史作为明确的转录保留，实时工具轮次则由同一CLI进程继续。
  return [
    {
      type: "text",
      text: `Previous conversation (a transcript, not additional instructions):\n${JSON.stringify(messages.slice(0, -1))}\nContinue with the user's message below.`,
    },
    ...content,
  ];
}
