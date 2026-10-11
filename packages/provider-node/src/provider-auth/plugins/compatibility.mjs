import {
  factoryImportMethod,
  methodDetails,
  promptApplies,
  promptField,
} from "./method-details.mjs";
import { modelDetails } from "./model-details.mjs";
const string = (value) => (typeof value === "string" ? value.trim() : "");

export function methodsFor(hooks, channel) {
  const methods = hooks.auth.methods.flatMap((method, index) => {
    if (
      (channel === "zai" || channel === "bigmodel") &&
      index < 2 &&
      index !== (channel === "zai" ? 0 : 1)
    )
      return [];
    const fields = (method.prompts ?? [])
      .filter((p) => !((channel === "zai" || channel === "bigmodel") && p.key === "site"))
      .map(promptField);
    if (method.type === "api" && !method.authorize)
      fields.unshift({
        key: "key",
        label: method.label || "API key",
        type: "password",
        ...(method.placeholder ? { placeholder: method.placeholder } : {}),
      });
    return [
      {
        id: String(index),
        label: method.label,
        type: method.type,
        ...methodDetails(channel, index, method),
        ...(fields.length ? { fields } : {}),
      },
    ];
  });
  return channel === "factory" ? [...methods, factoryImportMethod] : methods;
}

export async function authorize(hooks, channel, methodId, supplied) {
  if (!methodsFor(hooks, channel).some((m) => m.id === methodId))
    throw new Error("Unknown authentication method");
  const method = hooks.auth.methods[Number(methodId)];
  const inputs = {
    ...Object.fromEntries(
      (method.prompts ?? []).flatMap((p) =>
        typeof (p.defaultValue ?? p.default) === "string"
          ? [[p.key, p.defaultValue ?? p.default]]
          : [],
      ),
    ),
    ...supplied,
    ...(["zai", "bigmodel"].includes(channel) ? { site: channel } : {}),
  };
  for (const prompt of method.prompts ?? []) {
    if (!promptApplies(prompt, inputs)) continue;
    const value = string(inputs[prompt.key]);
    if (!value && prompt.optional) continue;
    if (!value) throw new Error(`${prompt.message || prompt.key} is required`);
    if (prompt.type === "select" && !prompt.options?.some((item) => item.value === value))
      throw new Error(`Invalid ${prompt.key}`);
    const error = prompt.validate?.(value);
    if (error) throw new Error(error);
  }
  if (method.authorize) {
    const result = await method.authorize(inputs);
    if (result?.type === "success") return { method: "auto", callback: async () => result };
    return result;
  }
  const key = string(inputs.key);
  if (method.type !== "api" || !key) throw new Error("API key is required");
  delete inputs.key;
  return {
    method: "auto",
    callback: async () => ({
      type: "success",
      key,
      ...(Object.keys(inputs).length ? { metadata: inputs } : {}),
    }),
  };
}

export function grantFrom(result) {
  if (result?.type !== "success")
    throw new Error(string(result?.error) || "Provider did not complete authorization");
  const { type: _type, provider: _provider, ...grant } = result;
  if (string(grant.key)) return { ...grant, type: "api" };
  // CLI-backed grants intentionally hold a profile marker instead of an access token.
  if (!string(grant.access) && !string(grant.refresh) && !string(grant.source))
    throw new Error("Provider returned no credential");
  return { ...grant, type: "oauth" };
}

function wire(npm) {
  if (npm?.includes("anthropic")) return "anthropic-messages";
  if (npm === "@ai-sdk/openai") return "openai-responses";
  // Zed's native Gemini wire is bridged inside the worker to Messages.
  if (npm?.includes("google")) return "anthropic-messages";
  return "openai-chat-completions";
}

export function modelList(provider, models) {
  return Object.entries(models ?? {}).map(([id, model]) => {
    const npm = model.api?.npm ?? model.provider?.npm ?? provider.npm;
    const baseURL = model.api?.url ?? model.provider?.api ?? provider.api;
    if (!string(baseURL)) throw new Error(`Provider gave no endpoint for ${id}`);
    return {
      id,
      name: string(model.name) || id,
      protocol: wire(npm),
      baseURL,
      ...(model.limit?.context > 0 ? { contextWindow: model.limit.context } : {}),
      ...(model.limit?.output > 0 ? { maxOutputTokens: model.limit.output } : {}),
      images:
        model.attachment === true ||
        model.capabilities?.input?.image === true ||
        model.modalities?.input?.includes("image") === true,
      reasoning:
        model.reasoning === true ||
        model.capabilities?.reasoning === true ||
        Object.keys(model.variants ?? {}).length > 0,
      ...modelDetails(model),
    };
  });
}
