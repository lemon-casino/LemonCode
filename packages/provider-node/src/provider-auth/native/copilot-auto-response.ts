import type { AuthWireProtocol } from "../driver.js";
import { list, number, record, sseData, text, type Json } from "./common.js";

function usage(value: unknown, anthropic: boolean): Json | undefined {
  const source = record(value);
  const input = number(source.input_tokens);
  const output = number(source.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const cached = anthropic
    ? number(source.cache_read_input_tokens)
    : number(record(source.input_tokens_details).cached_tokens);
  const created = anthropic ? number(source.cache_creation_input_tokens) : undefined;
  const prompt =
    input === undefined ? undefined : input + (anthropic ? (cached ?? 0) + (created ?? 0) : 0);
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(output === undefined ? {} : { completion_tokens: output }),
    ...(prompt === undefined || output === undefined ? {} : { total_tokens: prompt + output }),
    ...(cached === undefined && created === undefined
      ? {}
      : {
          prompt_tokens_details: {
            ...(cached === undefined ? {} : { cached_tokens: cached }),
            ...(created === undefined ? {} : { cache_creation_tokens: created }),
          },
        }),
    ...(source.output_tokens_details
      ? { completion_tokens_details: source.output_tokens_details }
      : {}),
  };
}
function finish(value: unknown, tools: boolean): string {
  return value === "max_tokens" || value === "incomplete"
    ? "length"
    : tools || value === "tool_use"
      ? "tool_calls"
      : "stop";
}
function messageResult(source: Json, model: string, anthropic: boolean): Json {
  let content = "";
  let reasoning = "";
  const tools: Json[] = [];
  const blocks = anthropic ? list(source.content) : list(source.output);
  for (const raw of blocks) {
    const block = record(raw);
    if (block.type === "text") content += text(block.text);
    if (block.type === "thinking") reasoning += text(block.thinking);
    if (block.type === "message")
      for (const rawPart of list(block.content)) content += text(record(rawPart).text);
    if (block.type === "reasoning")
      for (const rawPart of list(block.summary)) reasoning += text(record(rawPart).text);
    if (block.type === "function_call" || block.type === "tool_use")
      tools.push({
        id: block.call_id ?? block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: anthropic ? JSON.stringify(block.input ?? {}) : text(block.arguments),
        },
      });
  }
  return {
    id: text(source.id),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: text(source.model) || model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(tools.length ? { tool_calls: tools } : {}),
        },
        finish_reason: finish(source.stop_reason ?? source.status, tools.length > 0),
      },
    ],
    ...(usage(source.usage, anthropic) ? { usage: usage(source.usage, anthropic) } : {}),
  };
}

async function* streamChunks(
  response: Response,
  model: string,
  anthropic: boolean,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  let id = "";
  let actualModel = model;
  let roleSent = false;
  let done = false;
  let inputUsage: Json = {};
  const tools = new Map<number, number>();
  const chunk = (delta: Json, reason: string | null = null, tokenUsage?: Json) =>
    encoder.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: actualModel, choices: [{ index: 0, delta, finish_reason: reason }], ...(tokenUsage ? { usage: tokenUsage } : {}) })}\n\n`,
    );
  if (!response.body) throw new Error("Copilot returned an empty stream");
  for await (const event of sseData(response.body, signal)) {
    signal.throwIfAborted();
    const type = text(event.type);
    if (type === "error" || type === "response.failed" || event.error) {
      // 已有输出后只能报告错误，不能重放原请求或伪造正常结束。
      yield encoder.encode(
        'data: {"error":{"message":"Copilot stream failed","type":"provider_error"}}\n\n',
      );
      return;
    }
    const source = record(anthropic ? event.message : event.response);
    if (text(source.id)) id = text(source.id);
    if (text(source.model)) actualModel = text(source.model);
    if (!roleSent) {
      roleSent = true;
      yield chunk({ role: "assistant", content: "" });
    }
    if (anthropic) {
      if (type === "message_start") inputUsage = record(source.usage);
      const block = record(event.content_block);
      const delta = record(event.delta);
      const index = number(event.index) ?? 0;
      if (type === "content_block_start") {
        if (block.type === "tool_use") {
          const toolIndex = tools.size;
          tools.set(index, toolIndex);
          yield chunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments: Object.keys(record(block.input)).length
                    ? JSON.stringify(block.input)
                    : "",
                },
              },
            ],
          });
        } else if (block.type === "text" && block.text) yield chunk({ content: block.text });
        else if (block.type === "thinking" && block.thinking)
          yield chunk({ reasoning_content: block.thinking });
      }
      if (type === "content_block_delta") {
        if (delta.type === "text_delta") yield chunk({ content: text(delta.text) });
        else if (delta.type === "thinking_delta")
          yield chunk({ reasoning_content: text(delta.thinking) });
        else if (delta.type === "input_json_delta" && tools.has(index))
          yield chunk({
            tool_calls: [
              { index: tools.get(index), function: { arguments: text(delta.partial_json) } },
            ],
          });
      }
      if (type === "message_delta") {
        done = true;
        yield chunk(
          {},
          finish(delta.stop_reason, tools.size > 0),
          usage({ ...inputUsage, ...record(event.usage) }, true),
        );
      }
      if (type === "message_stop") break;
    } else {
      const index = number(event.output_index) ?? 0;
      const item = record(event.item);
      if (type === "response.output_text.delta") yield chunk({ content: text(event.delta) });
      else if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      )
        yield chunk({ reasoning_content: text(event.delta) });
      else if (type === "response.output_item.added" && item.type === "function_call") {
        const toolIndex = tools.size;
        tools.set(index, toolIndex);
        yield chunk({
          tool_calls: [
            {
              index: toolIndex,
              id: item.call_id ?? item.id,
              type: "function",
              function: { name: item.name, arguments: text(item.arguments) },
            },
          ],
        });
      } else if (type === "response.function_call_arguments.delta" && tools.has(index))
        yield chunk({
          tool_calls: [{ index: tools.get(index), function: { arguments: text(event.delta) } }],
        });
      else if (type === "response.completed" || type === "response.incomplete") {
        done = true;
        yield chunk(
          {},
          finish(type === "response.incomplete" ? "incomplete" : source.status, tools.size > 0),
          usage(source.usage, false),
        );
        break;
      }
    }
  }
  signal.throwIfAborted();
  if (!done) throw new Error("Copilot stream ended before completion");
  yield encoder.encode("data: [DONE]\n\n");
}

export async function autoResponse(
  response: Response,
  model: string,
  protocol: AuthWireProtocol,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  if (!response.ok || protocol === "openai-chat-completions") return response;
  const anthropic = protocol === "anthropic-messages";
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding"]) headers.delete(name);
  if (!stream) {
    const result = messageResult(record(await response.json()), model, anthropic);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(result), { status: response.status, headers });
  }
  headers.set("content-type", "text/event-stream");
  const controller = new AbortController();
  const joined = AbortSignal.any([signal, controller.signal]);
  const iterator = streamChunks(response, model, anthropic, joined);
  const body = new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        const next = await iterator.next();
        if (next.done) target.close();
        else target.enqueue(next.value);
      } catch (error) {
        target.error(error);
      }
    },
    async cancel() {
      controller.abort();
      await iterator.return(undefined).catch(() => {});
      if (!response.body?.locked) await response.body?.cancel().catch(() => {});
    },
  });
  return new Response(body, { status: response.status, headers });
}
