import type { AuthModel } from "../driver.js";
import {
  joinedSignal,
  json,
  list,
  number,
  record,
  text,
  type Fetcher,
  type Json,
} from "./common.js";

export function reasoningVariants(
  levels: readonly string[],
  budget = false,
): NonNullable<AuthModel["reasoningVariants"]> {
  const budgets: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 32768,
  };
  return [...new Set(levels)].slice(0, 32).map((id) => ({
    id,
    options:
      id === "none" || id === "off"
        ? { thinking: { type: "disabled" } }
        : budget
          ? { thinking: { type: "enabled", budgetTokens: budgets[id] || 8192 } }
          : { thinking: { type: "adaptive" }, effort: id },
  }));
}

export function catalogMetadata(model: Json): Partial<AuthModel> {
  const limits = record(model.limit),
    input = list(record(model.modalities).input);
  const inputKnown = Array.isArray(record(model.modalities).input);
  const options = list(model.reasoning_options).map(record);
  const levels = options.flatMap((o) =>
    o.type === "effort" ? list(o.values).map(text).filter(Boolean) : [],
  );
  const budget = options.some((o) => o.type === "budget_tokens");
  const toggle = options.some((o) => o.type === "toggle");
  const variants = levels.length
    ? reasoningVariants(levels)
    : budget
      ? reasoningVariants(["low", "medium", "high"], true)
      : toggle
        ? [
            { id: "off", options: { thinking: { type: "disabled" } } },
            { id: "on", options: { thinking: { type: "enabled" } } },
          ]
        : [];
  return {
    contextWindow: (number(limits.context) ?? 0) > 0 ? number(limits.context) : undefined,
    maxOutputTokens: (number(limits.output) ?? 0) > 0 ? number(limits.output) : undefined,
    // 元数据缺失不等于厂商禁止文本/视觉；不能用[]覆盖driver已有的images能力。
    images: inputKnown ? input.includes("image") : undefined,
    inputModalities: inputKnown
      ? input.filter((v): v is "text" | "image" | "video" | "audio" | "pdf" =>
          ["text", "image", "video", "audio", "pdf"].includes(String(v)),
        )
      : undefined,
    toolCall: model.tool_call !== false,
    reasoning: variants.length > 0,
    reasoningVariants: variants,
  };
}

/** Public metadata only; requests never carry an account's OAuth token. */
export class PublicCatalog {
  private cached: Json = {};
  private at = 0;
  private fallback = true;
  constructor(private readonly request?: Fetcher) {}
  async read(signal?: AbortSignal): Promise<{ data: Json; fallback: boolean }> {
    if (Date.now() - this.at < (this.fallback ? 60_000 : 3600000))
      return { data: this.cached, fallback: this.fallback };
    if (!this.request) return { data: {}, fallback: true };
    try {
      const data = await json(this.request, "https://models.dev/api.json", {
        signal: joinedSignal(signal, AbortSignal.timeout(8000)),
      });
      if (!Object.keys(data).some((k) => Object.keys(record(record(data[k]).models)).length))
        throw new Error("Empty model catalog");
      this.cached = data;
      this.fallback = false;
    } catch {
      signal?.throwIfAborted();
      this.fallback = true;
    }
    this.at = Date.now();
    return { data: this.cached, fallback: this.fallback };
  }
}
