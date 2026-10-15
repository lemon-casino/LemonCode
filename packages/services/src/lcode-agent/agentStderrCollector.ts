import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { LCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS } from "@lcode/shared/process-diagnostic";

export const EXIT_STDERR_DRAIN_MS = 250;

/** stderr 的寿命独立于协议；child exit 时管道中仍可能有最后一行诊断。 */
export class AgentStderrCollector {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private dropping = false;
  private readonly drained: Promise<void>;
  private resolveDrained!: () => void;
  private done = false;
  private deadlineAt = Infinity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly input: Readable,
    private readonly onLine?: (line: string) => void,
  ) {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
    input.on("data", this.data);
    input.once("end", this.finish);
    // 只有诊断出口不可用，不能因此撤销仍然健康的 stdin/stdout 协议。
    input.on("error", this.finish);
    input.once("close", this.finish);
    if (input.destroyed || input.readableEnded) this.finish();
  }

  private readonly data = (chunk: Buffer): void => this.accept(this.decoder.write(chunk));

  private accept(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      // 旧 readline 在换行前无限缓存压缩断言；保留有界片段，不能吞掉下一条诊断。
      if (!this.dropping) {
        const remaining = LCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS - this.buffer.length;
        this.buffer += text.slice(offset, Math.min(end, offset + remaining));
        if (end - offset > remaining) this.dropping = true;
      }
      if (newline < 0) break;
      this.onLine?.(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
      this.dropping = false;
      offset = newline + 1;
    }
  }

  waitForDrain(timeoutMs = EXIT_STDERR_DRAIN_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (!this.done && deadline < this.deadlineAt) {
      this.deadlineAt = deadline;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(this.finish, Math.max(0, timeoutMs));
    }
    return this.drained;
  }

  private readonly finish = (): void => {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.accept(this.decoder.end());
    if (this.buffer) this.onLine?.(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.input.off("data", this.data);
    this.input.off("end", this.finish);
    this.input.off("close", this.finish);
    this.input.resume();
    this.resolveDrained();
  };
}
