import { MAX_CONTROL_FRAME_BYTES } from "../contracts.js";

export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export class JsonLineDecoder {
  private buffer = "";
  public constructor(private readonly options: { maxFrameBytes?: number } = {}) {}

  public push(chunk: string | Uint8Array): unknown[] {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.buffer += text;
    if (
      Buffer.byteLength(this.buffer, "utf8") >
        (this.options.maxFrameBytes ?? MAX_CONTROL_FRAME_BYTES) &&
      !this.buffer.includes("\n")
    ) {
      throw new Error("JSONL frame exceeds maximum size");
    }
    const frames: unknown[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
      if (!line) continue;
      if (
        Buffer.byteLength(line, "utf8") > (this.options.maxFrameBytes ?? MAX_CONTROL_FRAME_BYTES)
      ) {
        throw new Error("JSONL frame exceeds maximum size");
      }
      try {
        frames.push(JSON.parse(line) as unknown);
      } catch (error) {
        throw new Error("Invalid JSONL frame", { cause: error });
      }
    }
    return frames;
  }

  public finish(): void {
    if (this.buffer.trim()) throw new Error("Incomplete JSONL frame");
  }
}
