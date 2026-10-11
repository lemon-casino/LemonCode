import { digest, list, record, text, type Json } from "./common.js";
import { prepareToolSchemas } from "./tool-schema.js";
type OpenAIChannel = "codex" | "chatgpt-api";
export function prepareResponses(incoming: Json, channel: OpenAIChannel, instructions = ""): Json {
  const body = structuredClone(incoming);
  const dropped = [
    "max_output_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "previous_response_id",
    "user",
    "safety_identifier",
  ];
  if (channel === "chatgpt-api")
    dropped.push(
      "background",
      "conversation",
      "max_tool_calls",
      "metadata",
      "moderation",
      "multi_agent",
      "prompt",
      "prompt_cache_retention",
      "top_logprobs",
      "truncation",
    );
  for (const key of dropped) delete body[key];
  let input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
      : list(body.input).map((item) => {
          const value = record(item);
          return value.role === "system" ? { ...value, role: "developer" } : value;
        });
  const ownInstructions = text(body.instructions);
  if (channel === "codex") input = codexInput(input);
  if (channel === "codex" && instructions) {
    if (ownInstructions && ownInstructions.split("\n")[0] !== instructions.split("\n")[0])
      input.unshift({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: body.instructions }],
      });
    body.instructions =
      ownInstructions && ownInstructions.split("\n")[0] === instructions.split("\n")[0]
        ? ownInstructions
        : instructions;
  }
  body.input = input;
  body.store = false;
  body.stream = true;
  body.prompt_cache_key ??= digest(
    JSON.stringify([
      ownInstructions,
      input.slice(
        0,
        Math.max(
          0,
          input.findIndex((item) => item.role === "user"),
        ) + 1,
      ),
    ]),
  );
  if (channel === "codex") {
    if (!["priority", "ultrafast"].includes(text(body.service_tier))) delete body.service_tier;
    body.tool_choice = "auto";
    body.parallel_tool_calls ??= true;
    body.text ??= { verbosity: "medium" };
    if (input.some((item) => item.type === "web_search_call")) {
      const additional = input.find((item) => item.type === "additional_tools");
      const target = additional || body;
      if (!list(target.tools).some((item) => text(record(item).type).startsWith("web_search")))
        target.tools = [...list(target.tools), { type: "web_search", external_web_access: false }];
    }
  }
  if (channel === "chatgpt-api") {
    const hosted = [
      "image_generation",
      "file_search",
      "code_interpreter",
      "computer_use",
      "computer_use_preview",
      "computer",
      "mcp",
      "tool_search",
    ];
    const ownTools = (tools: unknown) =>
      list(tools).filter((item) => !hosted.includes(text(record(item).type)));
    for (const item of input)
      if (item.type === "additional_tools") item.tools = ownTools(item.tools);
    if (Array.isArray(body.tools)) {
      body.tools = ownTools(body.tools);
      if (!list(body.tools).length) {
        delete body.tools;
        delete body.tool_choice;
      }
    }
  }
  if (body.reasoning) {
    const reasoning = record(body.reasoning);
    if (reasoning.effort === "ultra") reasoning.effort = "max";
    if (reasoning.effort !== "none") {
      reasoning.summary ??= "auto";
      body.include = [...new Set([...list(body.include), "reasoning.encrypted_content"])];
    } else if (channel === "codex") delete body.include;
  } else if (channel === "codex")
    body.include = [...new Set([...list(body.include), "reasoning.encrypted_content"])];
  // Responses 函数工具要求 object 根；不改工具名、调用参数或历史内容。
  const normalized = prepareToolSchemas(body, "openai-responses", { objectRoots: true });
  normalized.input = list(normalized.input).map((value) => {
    const item = record(value);
    return item.type === "additional_tools"
      ? prepareToolSchemas(item, "openai-responses", { objectRoots: true })
      : value;
  });
  return normalized;
}

function codexInput(input: Json[]): Json[] {
  const calls = new Map<string, string>();
  const outputs: Record<string, string> = {
    function_call: "function_call_output",
    custom_tool_call: "custom_tool_call_output",
    local_shell_call: "local_shell_call_output",
  };
  for (const item of input) {
    if (typeof item.call_id === "string" && item.call_id.length > 64)
      item.call_id = digest(item.call_id.trim());
    if (outputs[text(item.type)]) calls.set(text(item.call_id).trim(), outputs[text(item.type)]!);
  }
  return input
    .filter((item) => item.type !== "item_reference")
    .map((item) => {
      const type = text(item.type),
        id = text(item.call_id).trim();
      if (["function_call_output", "custom_tool_call_output"].includes(type) && !id) return item;
      delete item.id;
      if (
        Object.values(outputs).includes(type) &&
        calls.get(id) !== type &&
        !(type === "function_call_output" && calls.get(id) === "local_shell_call_output")
      ) {
        const result = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
        return {
          type: "message",
          role: "assistant",
          content: `[Previous ${text(item.name) || "tool"} result; call_id=${id || "unknown"}]: ${(result || "").slice(0, 16000)}`,
        };
      }
      return item;
    });
}
