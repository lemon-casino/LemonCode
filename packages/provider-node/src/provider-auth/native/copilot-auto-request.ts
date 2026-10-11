import type { AuthWireProtocol } from "../driver.js";
import { list, number, record, text, type Json } from "./common.js";
import { prepareToolSchemas } from "./tool-schema.js";

function parts(value: unknown, protocol: AuthWireProtocol, role: string): Json[] {
  if (typeof value === "string")
    return [
      {
        type:
          protocol === "openai-responses"
            ? role === "assistant"
              ? "output_text"
              : "input_text"
            : "text",
        text: value,
      },
    ];
  return list(value).flatMap((raw): Json[] => {
    const item = record(raw);
    if (item.type === "text") return parts(text(item.text), protocol, role);
    if (item.type !== "image_url") throw new Error("Copilot Auto cannot convert this content type");
    const url =
      typeof item.image_url === "string" ? item.image_url : text(record(item.image_url).url);
    if (protocol === "openai-responses")
      return [
        {
          type: "input_image",
          image_url: url,
          ...(record(item.image_url).detail ? { detail: record(item.image_url).detail } : {}),
        },
      ];
    const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return [
      {
        type: "image",
        source: data
          ? { type: "base64", media_type: data[1], data: data[2] }
          : { type: "url", url },
      },
    ];
  });
}
function tools(body: Json, protocol: AuthWireProtocol): Json[] {
  return list(body.tools).map((raw) => {
    const tool = record(raw);
    if (tool.type !== "function") throw new Error("Copilot Auto supports function tools only");
    const fn = record(tool.function);
    return protocol === "openai-responses"
      ? {
          type: "function",
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
          ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
        }
      : {
          name: fn.name,
          description: fn.description,
          input_schema: fn.parameters ?? { type: "object", properties: {} },
        };
  });
}
export function autoRequest(
  body: Json,
  model: string,
  protocol: AuthWireProtocol,
): { path: string; body: Json } {
  // Auto 后续可能切到 Messages/Responses，所有目标共用合法的函数 object 根。
  body = prepareToolSchemas(body, "openai-chat-completions", { objectRoots: true });
  if (protocol === "openai-chat-completions")
    return { path: "/chat/completions", body: { ...body, model } };
  const result: Json = { model, stream: body.stream === true };
  for (const field of ["temperature", "top_p"])
    if (body[field] !== undefined) result[field] = body[field];
  const max = number(body.max_completion_tokens) ?? number(body.max_tokens);
  if (body.tools) result.tools = tools(body, protocol);
  if (protocol === "openai-responses") {
    if (max !== undefined) result.max_output_tokens = max;
    if (body.reasoning_effort) result.reasoning = { effort: body.reasoning_effort };
    if (typeof body.parallel_tool_calls === "boolean")
      result.parallel_tool_calls = body.parallel_tool_calls;
    if (body.tool_choice)
      result.tool_choice =
        typeof body.tool_choice === "string"
          ? body.tool_choice
          : { type: "function", name: record(record(body.tool_choice).function).name };
    if (body.response_format) {
      const format = record(body.response_format);
      result.text = {
        format:
          format.type === "json_schema"
            ? { type: "json_schema", ...record(format.json_schema) }
            : format,
      };
    }
    result.input = list(body.messages).flatMap((raw): Json[] => {
      const message = record(raw);
      if (message.role === "tool")
        return [
          {
            type: "function_call_output",
            call_id: message.tool_call_id,
            output:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          },
        ];
      const out: Json[] = [];
      if (message.content != null)
        out.push({
          role: message.role,
          content: parts(message.content, protocol, text(message.role)),
        });
      for (const tool of list(message.tool_calls)) {
        const call = record(tool);
        const fn = record(call.function);
        out.push({
          type: "function_call",
          call_id: call.id,
          name: fn.name,
          arguments: text(fn.arguments) || "{}",
        });
      }
      return out;
    });
    return { path: "/responses", body: result };
  }
  result.max_tokens = max ?? 8192;
  if (body.stop) result.stop_sequences = typeof body.stop === "string" ? [body.stop] : body.stop;
  if (body.reasoning_effort && body.reasoning_effort !== "none") {
    result.thinking = { type: "adaptive" };
    result.output_config = { effort: body.reasoning_effort };
  }
  if (body.tool_choice)
    result.tool_choice =
      typeof body.tool_choice === "string"
        ? { type: body.tool_choice === "required" ? "any" : body.tool_choice }
        : { type: "tool", name: record(record(body.tool_choice).function).name };
  const system: Json[] = [];
  const messages: Json[] = [];
  for (const raw of list(body.messages)) {
    const message = record(raw);
    if (["system", "developer"].includes(text(message.role))) {
      system.push(...parts(message.content, protocol, "system"));
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content =
      message.role === "tool"
        ? [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content:
                typeof message.content === "string"
                  ? message.content
                  : parts(message.content, protocol, "user"),
            },
          ]
        : message.content == null
          ? []
          : parts(message.content, protocol, role);
    for (const rawCall of list(message.tool_calls)) {
      const call = record(rawCall);
      const fn = record(call.function);
      content.push({
        type: "tool_use",
        id: call.id,
        name: fn.name,
        input: JSON.parse(text(fn.arguments) || "{}"),
      });
    }
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content = [...list(previous.content), ...content];
    else messages.push({ role, content });
  }
  if (system.length) result.system = system;
  result.messages = messages;
  return { path: "/v1/messages", body: result };
}

export function autoPrompt(body: Json): string {
  const latest = list(body.messages)
    .map(record)
    .reverse()
    .find((message) => message.role === "user");
  if (!latest) return "hi";
  const prompt =
    typeof latest.content === "string"
      ? latest.content
      : list(latest.content)
          .map(record)
          .filter((part) => part.type === "text")
          .map((part) => text(part.text))
          .join("\n");
  return prompt.trim() || "hi";
}
