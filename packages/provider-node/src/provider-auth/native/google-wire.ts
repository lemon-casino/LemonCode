import { randomUUID } from "node:crypto";
import { digest, joinedSignal, list, number, record, sseData, text, type Json } from "./common.js";
import { googleToolSchema } from "./google-schema.js";

/** Anthropic Messages payload to the Gemini payload shared by Code Assist and plugin transports. */
export function geminiRequest(body: Json): Json {
  const toolNames = new Map<string, string>();
  for (const message of list(body.messages))
    for (const block of list(record(message).content)) {
      const part = record(block);
      if (part.type === "tool_use") toolNames.set(text(part.id), text(part.name));
    }
  const contents = list(body.messages).flatMap((value) => {
    const message = record(value);
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : list(message.content);
    const parts: Json[] = [];
    for (const value of blocks) {
      const block = record(value);
      switch (block.type) {
        case "text":
          parts.push({ text: text(block.text) });
          break;
        case "image": {
          const source = record(block.source);
          if (source.type === "base64")
            parts.push({
              inlineData: { mimeType: text(source.media_type), data: text(source.data) },
            });
          else if (source.type === "url") parts.push({ fileData: { fileUri: text(source.url) } });
          else throw new Error("Unsupported Google image source");
          break;
        }
        case "thinking":
          // 签名必须随模型的 thought 回放；缺失签名的旧文本不能伪造成厂商签名。
          if (block.signature)
            parts.push({
              text: text(block.thinking),
              thought: true,
              thoughtSignature: text(block.signature),
            });
          break;
        case "tool_use":
          parts.push({
            functionCall: { name: text(block.name), args: record(block.input), id: text(block.id) },
            thoughtSignature: text(block.signature) || "skip_thought_signature_validator",
          });
          break;
        case "tool_result": {
          const name = toolNames.get(text(block.tool_use_id));
          if (!name) throw new Error("Google tool result has no matching tool call");
          const result =
            typeof block.content === "string"
              ? block.content
              : list(block.content)
                  .filter((entry) => record(entry).type !== "image")
                  .map((entry) => record(entry).text ?? entry);
          parts.push({
            functionResponse: {
              name,
              id: text(block.tool_use_id),
              response: block.is_error ? { error: result } : { result },
            },
          });
          for (const entry of list(block.content)) {
            const item = record(entry);
            const source = record(item.source);
            if (item.type === "image" && source.type === "base64")
              parts.push({
                inlineData: { mimeType: text(source.media_type), data: text(source.data) },
              });
            if (item.type === "image" && source.type === "url")
              parts.push({ fileData: { fileUri: text(source.url) } });
          }
          break;
        }
        case "redacted_thinking":
          break;
        default:
          throw new Error("Unsupported Google message content block");
      }
    }
    const role = message.role === "assistant" ? "model" : "user";
    const responses = parts.filter((part) => part.functionResponse);
    const ordinary = parts.filter((part) => !part.functionResponse);
    // Gemini不允许同一个user content混合functionResponse与普通文本；保留顺序为工具结果先行。
    return responses.length && ordinary.length
      ? [
          { role, parts: responses },
          { role, parts: ordinary },
        ]
      : [{ role, parts }];
  });
  const generationConfig: Json = {};
  if (number(body.max_tokens) !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["top_k", "topK"],
    ["stop_sequences", "stopSequences"],
  ])
    if (from && to && body[from] !== undefined) generationConfig[to] = body[from];
  const thinking = record(body.thinking);
  const levelModel = /^gemini-(?:3|pro-agent)/u.test(text(body.model));
  const effort = text(record(body.output_config).effort);
  const level =
    effort === "low" || effort === "off" || effort === "none"
      ? "low"
      : effort === "medium" && text(body.model).includes("flash")
        ? "medium"
        : effort === "minimal" &&
            /-(?:minimal|extra-low)$/u.test(text(body.model)) &&
            text(body.model).includes("flash")
          ? "minimal"
          : "high";
  if (thinking.type === "disabled")
    // Gemini 3不接受budget=0；其最低合法档为low。2.5仍以零预算明确关闭。
    generationConfig.thinkingConfig = {
      includeThoughts: false,
      ...(levelModel ? { thinkingLevel: "low" } : { thinkingBudget: 0 }),
    };
  if (thinking.type === "enabled")
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: number(thinking.budget_tokens) ?? -1,
    };
  if (thinking.type === "adaptive")
    generationConfig.thinkingConfig = !levelModel
      ? {
          includeThoughts: true,
          thinkingBudget:
            (
              {
                minimal: 1024,
                low: 2048,
                medium: 8192,
                high: 16384,
                xhigh: 32768,
                max: 32768,
              } as Record<string, number>
            )[text(record(body.output_config).effort)] || 8192,
        }
      : {
          includeThoughts: true,
          thinkingLevel: level,
        };
  if (
    text(body.model).startsWith("gpt-oss") ||
    (text(body.model).startsWith("claude-") && !text(body.model).includes("thinking"))
  )
    delete generationConfig.thinkingConfig;
  const out: Json = { contents, generationConfig };
  if (body.system)
    out.systemInstruction = {
      parts:
        typeof body.system === "string"
          ? [{ text: body.system }]
          : list(body.system).map((part) => ({ text: text(record(part).text) })),
    };
  const declarations = list(body.tools).map((value) => {
    const tool = record(value);
    return {
      name: text(tool.name),
      description: text(tool.description),
      parameters: googleToolSchema(record(tool.input_schema)),
    };
  });
  if (declarations.length) out.tools = [{ functionDeclarations: declarations }];
  const choice = record(body.tool_choice);
  if (choice.type)
    out.toolConfig = {
      functionCallingConfig: {
        mode:
          choice.type === "none"
            ? "NONE"
            : choice.type === "any" || choice.type === "tool"
              ? "ANY"
              : "AUTO",
        ...(choice.type === "tool" ? { allowedFunctionNames: [text(choice.name)] } : {}),
      },
    };
  return out;
}

export function codeAssistRequest(body: Json, channel: string, project: string): Json {
  const request = geminiRequest(body);
  if (channel === "antigravity")
    request.sessionId =
      "-" +
      BigInt("0x" + digest(JSON.stringify(list(request.contents)[0])).slice(0, 15)).toString();
  return {
    model: text(body.model),
    project,
    request,
    ...(channel === "antigravity"
      ? { userAgent: "antigravity", requestType: "agent", requestId: "agent-" + randomUUID() }
      : { user_prompt_id: randomUUID() }),
  };
}

/** Rewrites raw Gemini or Code Assist SSE; errors retain their original HTTP status. */
export function codeAssistResponse(
  upstream: Response,
  model: string,
  stream: boolean,
  signal?: AbortSignal,
): Response {
  if (!upstream.ok || !upstream.body) return upstream;
  const cancellation = new AbortController();
  const joined = joinedSignal(signal, cancellation.signal);
  const encoder = new TextEncoder();
  const id = "msg_" + randomUUID().replaceAll("-", "");
  const content: Json[] = [];
  let index = -1;
  let active = "";
  let stopped = false;
  let tool = false;
  let finish = "end_turn";
  let seen = false;
  let usage: Json = { input_tokens: 0, output_tokens: 0 };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: Json) => {
        if (stream && !joined.aborted)
          controller.enqueue(
            encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`),
          );
      };
      const stop = () => {
        if (active) {
          emit("content_block_stop", { index });
          active = "";
        }
      };
      const begin = (kind: string, block: Json) => {
        stop();
        index++;
        active = kind;
        content.push(block);
        emit("content_block_start", { index, content_block: block });
      };
      emit("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      });
      try {
        const frames = upstream.headers.get("content-type")?.includes("text/event-stream")
          ? sseData(upstream.body!, joined)
          : (async function* () {
              yield record(await upstream.json());
            })();
        for await (const frame of frames) {
          joined.throwIfAborted();
          if (frame.error) throw new Error("Google response failed");
          const response = Object.keys(record(frame.response)).length
            ? record(frame.response)
            : frame;
          if (response.error) throw new Error("Google response failed");
          const metadata = record(response.usageMetadata);
          if (Object.keys(metadata).length) {
            const cached = number(metadata.cachedContentTokenCount) ?? 0;
            usage = {
              input_tokens: Math.max(0, (number(metadata.promptTokenCount) ?? 0) - cached),
              output_tokens:
                (number(metadata.candidatesTokenCount) ?? 0) +
                (number(metadata.thoughtsTokenCount) ?? 0),
              ...(cached ? { cache_read_input_tokens: cached } : {}),
            };
          }
          for (const value of list(response.candidates).slice(0, 1)) {
            seen = true;
            const candidate = record(value);
            if (candidate.finishReason === "MAX_TOKENS") finish = "max_tokens";
            if (
              ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"].includes(
                text(candidate.finishReason),
              )
            )
              finish = "refusal";
            for (const value of list(record(candidate.content).parts)) {
              const part = record(value);
              const call = record(part.functionCall);
              if (call.name) {
                const block: Json = {
                  type: "tool_use",
                  id: text(call.id) || "toolu_" + randomUUID().replaceAll("-", ""),
                  name: text(call.name),
                  input: {},
                };
                begin("tool_use", block);
                tool = true;
                emit("content_block_delta", {
                  index,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(record(call.args)),
                  },
                });
                block.input = record(call.args);
                stop();
              } else if (typeof part.text === "string" || part.thoughtSignature) {
                const kind = part.thought ? "thinking" : "text";
                if (active !== kind)
                  begin(
                    kind,
                    kind === "thinking"
                      ? { type: "thinking", thinking: "", signature: "" }
                      : { type: "text", text: "" },
                  );
                const block = content[index]!;
                if (part.text) {
                  const key = kind === "thinking" ? "thinking" : "text";
                  emit("content_block_delta", {
                    index,
                    delta: { type: key + "_delta", [key]: part.text },
                  });
                  block[key] = text(block[key]) + text(part.text);
                }
                if (part.thoughtSignature && kind === "thinking") {
                  emit("content_block_delta", {
                    index,
                    delta: { type: "signature_delta", signature: part.thoughtSignature },
                  });
                  block.signature = text(block.signature) + text(part.thoughtSignature);
                }
              }
            }
          }
          if (record(response.promptFeedback).blockReason)
            throw new Error("Google refused this prompt");
        }
        if (!seen) throw new Error("Google stream ended without a model response");
        stop();
        const reason = tool ? "tool_use" : finish;
        emit("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage });
        emit("message_stop", {});
        if (!stream)
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                id,
                type: "message",
                role: "assistant",
                model,
                content,
                stop_reason: reason,
                stop_sequence: null,
                usage,
              }),
            ),
          );
        joined.throwIfAborted();
        stopped = true;
        controller.close();
      } catch (error) {
        if (!joined.aborted) {
          if (stream) {
            emit("error", { error: { type: "api_error", message: "Google stream failed" } });
            stopped = true;
            controller.close();
          } else controller.error(error);
        } else if (!cancellation.signal.aborted) controller.error(joined.reason ?? error);
      }
    },
    cancel() {
      if (!stopped) cancellation.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": stream ? "text/event-stream" : "application/json",
      "cache-control": "no-store",
    },
  });
}
