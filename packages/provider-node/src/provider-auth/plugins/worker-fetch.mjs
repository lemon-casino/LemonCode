import { geminiRequest, codeAssistResponse } from "../native/google-wire.ts";
import { prepareToolSchemas } from "../native/tool-schema.ts";

export async function fetchPluginModel({
  channel,
  hooks,
  provider,
  loader,
  model,
  request: r,
  signal,
}) {
  const headers = new Headers(r.headers);
  for (const [key, value] of Object.entries(loader.headers ?? {}))
    if (!headers.has(key)) headers.set(key, value);
  let body = r.body ? new TextDecoder().decode(r.body) : undefined;
  let payload = body ? JSON.parse(body) : {};
  const addresses = [loader.baseURL, provider.api, model?.api?.url, model?.provider?.api].filter(
    Boolean,
  );
  const target = new URL(r.url);
  if (
    r.method !== "POST" ||
    !addresses.some((base) => new URL(base).origin === target.origin) ||
    !/\/(messages(?:\/count_tokens)?|chat\/completions|responses)$/.test(target.pathname)
  )
    throw new Error("Request is outside this provider's model endpoint");
  // Responses 同样要求 object 根；Factory 的 Messages 保留已有包装/解包。
  const messages = /\/messages(?:\/count_tokens)?$/.test(target.pathname);
  const responses = target.pathname.endsWith("/responses");
  if ((messages && channel !== "factory") || responses || channel === "cline") {
    payload = prepareToolSchemas(
      payload,
      messages ? "anthropic-messages" : responses ? "openai-responses" : "openai-chat-completions",
      {
        objectRoots: messages || responses,
        oneOfAsAnyOf: channel === "cline",
      },
    );
    body = JSON.stringify(payload);
  }
  const sessionID = headers.get("x-lcode-session-id");
  headers.delete("x-lcode-session-id");
  if (sessionID && hooks["chat.headers"]) {
    const output = { headers: {} };
    await hooks["chat.headers"](
      {
        sessionID,
        model: { ...model, id: payload.model, providerID: provider.id },
        provider: { info: provider, source: "custom", options: loader },
      },
      output,
    );
    for (const [key, value] of Object.entries(output.headers)) headers.set(key, value);
  }
  const google =
    channel === "zed" &&
    ((model?.api?.npm ?? model?.provider?.npm ?? provider.npm)?.includes("google") ||
      String(payload.model).startsWith("gemini"));
  if (google) {
    body = JSON.stringify(geminiRequest(payload));
    target.pathname =
      new URL(loader.baseURL).pathname.replace(/\/$/, "") +
      "/models/" +
      encodeURIComponent(payload.model) +
      ":streamGenerateContent";
    target.search = "?alt=sse";
  }
  signal.throwIfAborted();
  const request = new Request(target, { method: r.method, headers, body, signal });
  const response = await loader.fetch(request, { method: r.method, headers, body, signal });
  return {
    response: google
      ? codeAssistResponse(response, payload.model, payload.stream === true, signal)
      : response,
    signIn: response.headers.get("x-magpie-sign-in"),
  };
}
