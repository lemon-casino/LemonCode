import type { AuthModel, AuthWireProtocol } from "../driver.js";
import { copilotProtocols } from "./copilot-models.js";
import { autoPrompt, autoRequest } from "./copilot-auto-request.js";
import { autoResponse } from "./copilot-auto-response.js";
import { joinedSignal, list, number, record, text, type Fetcher, type Json } from "./common.js";

interface AutoOptions {
  base: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  models: readonly AuthModel[];
  seen?: ReadonlyMap<string, readonly AuthWireProtocol[]>;
  beforeSend?: (model: string) => Promise<Response | undefined>;
}
interface Selection {
  model: string;
  protocol: AuthWireProtocol;
  token?: string;
  expires: number;
}
async function readBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 1024 * 1024) throw new Error("Copilot response exceeded the supported size");
      chunks.push(result.value);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function queued(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
}

/** Account-local Auto assignment and refusal state; each call owns its cancellation. */
export class CopilotAutoRouter {
  private cache?: Selection;
  private refused = new Map<string, number>();
  private tail = Promise.resolve();
  constructor(private readonly fetcher: Fetcher = fetch) {}
  isRefused(model: string): boolean {
    const until = this.refused.get(model) ?? 0;
    if (until > Date.now()) return true;
    this.refused.delete(model);
    return false;
  }
  private refuse(model: string): void {
    this.refused.set(model, Date.now() + 6 * 3600_000);
    if (this.cache?.model === model) this.cache = undefined;
  }
  private async inspect(response: Response, signal?: AbortSignal) {
    if (response.status !== 400) return { response, refused: false, sessionGone: false };
    const body = await readBody(response, signal);
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      refused: /"model_not_supported"|requested model is not supported/i.test(body),
      sessionGone: /not available for session/i.test(body),
    };
  }
  async observe(model: string, response: Response, signal?: AbortSignal): Promise<Response> {
    const result = await this.inspect(response, signal);
    if (result.refused) this.refuse(model);
    return result.response;
  }
  private manual(options: AutoOptions): Selection {
    const model = options.models.find(
      (candidate) => candidate.id !== "auto" && !this.isRefused(candidate.id),
    );
    if (!model) throw new Error("Copilot has no available model for Auto");
    return { model: model.id, protocol: model.protocol, expires: Date.now() + 10 * 60_000 };
  }
  private selection(data: Json, options: AutoOptions, legacy: boolean): Selection | undefined {
    if (!text(data.session_token)) return;
    const selected = record(data.selected_model);
    let id = typeof data.selected_model === "string" ? data.selected_model : text(selected.id);
    const available = list(data.available_models)
      .map((item) => (typeof item === "string" ? item : text(record(item).id)))
      .filter(Boolean);
    if (legacy && (!id || this.isRefused(id)))
      id =
        available.find((candidate) => !this.isRefused(candidate) && options.seen?.has(candidate)) ||
        available.find((candidate) => !this.isRefused(candidate)) ||
        "";
    if (!id || this.isRefused(id)) return;
    const protocols = selected.supported_endpoints
      ? copilotProtocols(selected.supported_endpoints)
      : (options.seen?.get(id) ?? copilotProtocols(undefined));
    const protocol = protocols[0];
    if (!protocol) return;
    const expires = number(data.expires_at);
    return {
      model: id,
      protocol,
      token: text(data.session_token),
      expires:
        expires && expires > 0
          ? Math.min(Date.now() + 3600_000, expires * 1000)
          : Date.now() + 3600_000,
    };
  }
  private async allocate(
    path: string,
    version: string,
    body: Json,
    options: AutoOptions,
    legacy = false,
  ): Promise<Json | undefined> {
    const signal = joinedSignal(options.signal, AbortSignal.timeout(15_000));
    try {
      // CLI已携带小写版本头；必须set覆盖，不能对象展开后因大小写重复而合并成两个版本。
      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      headers.set("X-GitHub-Api-Version", version);
      const response = await this.fetcher(options.base + path, {
        method: "POST",
        redirect: "error",
        signal,
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (legacy && response.status !== 404) throw new Error("Copilot Auto allocation failed");
        return;
      }
      return record(JSON.parse(await readBody(response, signal)));
    } catch {
      options.signal.throwIfAborted();
      if (legacy) throw new Error("Copilot Auto allocation failed");
      return;
    }
  }
  private async resolve(body: Json, options: AutoOptions): Promise<Selection> {
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => gate);
    try {
      await queued(previous, options.signal);
      if (
        this.cache &&
        this.cache.expires > Date.now() + 120_000 &&
        !this.isRefused(this.cache.model)
      )
        return this.cache;
      const v2 = await this.allocate(
        "/auto",
        "2026-08-01",
        { prompt: autoPrompt(body), tier: "balance" },
        options,
      );
      let selected: Selection | undefined;
      // 两代响应都可能只给模型ID；不能因合法字符串形态误入旧接口而丢失已分配session。
      if (
        v2 &&
        text(v2.session_token) &&
        (text(v2.selected_model) || text(record(v2.selected_model).id))
      )
        selected = this.selection(v2, options, false);
      else {
        const legacy = await this.allocate(
          "/models/session",
          "2025-10-01",
          { auto_mode: { model_hints: ["auto"] } },
          options,
          true,
        );
        if (legacy) {
          if (!text(legacy.session_token))
            throw new Error("Copilot Auto allocation returned no session");
          selected = this.selection(legacy, options, true);
          if (
            !selected &&
            !list(legacy.available_models).length &&
            !text(legacy.selected_model) &&
            !text(record(legacy.selected_model).id)
          )
            throw new Error("Copilot Auto picked no model");
        }
      }
      // /auto 已明确选中被拒绝的模型时，使用可手选目录，避免旧接口反复分配同一不可用模型。
      selected ??= this.manual(options);
      options.signal.throwIfAborted();
      this.cache = selected;
      return selected;
    } finally {
      release();
    }
  }
  async request(body: Json, options: AutoOptions): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = await this.resolve(body, options);
      options.signal.throwIfAborted();
      const policy = await options.beforeSend?.(selected.model);
      if (policy) return policy;
      const outbound = autoRequest(body, selected.model, selected.protocol);
      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      headers.delete("Copilot-Session-Token");
      if (selected.token) headers.set("Copilot-Session-Token", selected.token);
      if (selected.protocol === "anthropic-messages")
        headers.set("anthropic-version", "2023-06-01");
      const response = await this.fetcher(options.base + outbound.path, {
        method: "POST",
        headers,
        body: JSON.stringify(outbound.body),
        signal: options.signal,
        redirect: "error",
      });
      const result = await this.inspect(response, options.signal);
      if (result.refused) this.refuse(selected.model);
      const invalid = result.refused || (Boolean(selected.token) && result.sessionGone);
      if (invalid && this.cache === selected) this.cache = undefined;
      // 只在成功输出之前、明确的模型/会话拒绝时重选；限流、普通错误及已开始的流不重放。
      if (!invalid || attempt === 2)
        return autoResponse(
          result.response,
          selected.model,
          selected.protocol,
          body.stream === true,
          options.signal,
        );
      await result.response.body?.cancel();
    }
    throw new Error("Copilot Auto could not select an available model");
  }
}
