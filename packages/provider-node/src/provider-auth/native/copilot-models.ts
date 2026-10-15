import type { AuthModel, AuthWireProtocol } from "../driver.js";
import { list, number, record, text, type Json } from "./common.js";
import { copilotBilling } from "./copilot-billing.js";

export function copilotProtocols(endpoints: unknown): AuthWireProtocol[] {
  const values = list(endpoints);
  if (!values.length) return ["openai-chat-completions"];
  return [
    ...(values.includes("/chat/completions") ? ["openai-chat-completions" as const] : []),
    ...(values.includes("/responses") ? ["openai-responses" as const] : []),
    ...(values.includes("/v1/messages") ? ["anthropic-messages" as const] : []),
  ];
}
export function copilotCatalog(response: Json, base: string, tokenBased?: boolean) {
  const models: AuthModel[] = [
    { id: "auto", name: "Auto", protocol: "openai-chat-completions", baseURL: base },
  ];
  const policies = new Set<string>();
  const seen = new Map<string, AuthWireProtocol[]>();
  const manual: { model: AuthModel; rank: number }[] = [];
  for (const entry of list(response.data)) {
    const item = record(entry);
    const id = text(item.id);
    const capabilities = record(item.capabilities);
    if (!id || id === "auto" || capabilities.type !== "chat") continue;
    const protocols = copilotProtocols(item.supported_endpoints);
    seen.set(id, protocols);
    if (
      !protocols.length ||
      /^(copilot-search|exec-agent|trajectory)|-(secondary|tertiary|4th|free-auto)$/.test(id) ||
      item.vendor === "Experimental" ||
      (item.model_picker_enabled !== true && !text(item.model_picker_category))
    )
      continue;
    const policy = record(item.policy);
    const allowed =
      policy.state === "enabled" || (!item.policy && item.model_picker_enabled === true);
    if (!allowed) {
      if (!text(policy.terms)) continue;
      policies.add(id);
    }
    const limits = record(capabilities.limits);
    const supports = record(capabilities.supports);
    const efforts = list(supports.reasoning_effort).filter(
      (v): v is string => typeof v === "string" && /^[a-z0-9_-]{1,40}$/i.test(v),
    );
    const protocol = protocols.includes("openai-responses")
      ? "openai-responses"
      : protocols.includes("anthropic-messages")
        ? "anthropic-messages"
        : "openai-chat-completions";
    const model: AuthModel = {
      id,
      name: text(item.name) || id,
      ...(copilotBilling(record(item.billing), tokenBased)
        ? { billing: copilotBilling(record(item.billing), tokenBased) }
        : {}),
      protocol,
      baseURL: protocol === "anthropic-messages" ? base + "/v1" : base,
      contextWindow: number(limits.max_context_window_tokens),
      maxOutputTokens: number(limits.max_output_tokens),
      images: supports.vision === true,
      inputModalities: supports.vision === true ? ["text", "image"] : ["text"],
      ...(typeof supports.tool_calls === "boolean" ? { toolCall: supports.tool_calls } : {}),
      reasoning: efforts.length > 0,
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    };
    models.push(model);
    if (allowed)
      manual.push({
        model,
        rank: item.is_chat_fallback
          ? 0
          : item.is_chat_default
            ? 1
            : id === "gpt-4.1"
              ? 2
              : record(item.billing).is_premium === false
                ? 3
                : 4,
      });
  }
  manual.sort((a, b) => a.rank - b.rank);
  return { models, manual: manual.map((entry) => entry.model), policies, seen };
}
