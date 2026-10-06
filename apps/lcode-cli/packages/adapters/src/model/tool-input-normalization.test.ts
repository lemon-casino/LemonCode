import assert from "node:assert/strict";
import test from "node:test";
import type { Logger, ModelStreamEvent } from "@lcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import { normalizeToolCalls, normalizeToolResults } from "./runner-normalization.js";
import { runStreamText } from "./runner-stream.js";
import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";

const malformed = '{"file_path":"fixture.txt","content":"private fixture content';
const options = { source: "streamText", toolName: "Write" } as const;

function captureLogger(warnings: unknown[]): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    error() {},
    warn(...args) {
      warnings.push(args);
    },
    child() {
      return logger;
    },
  };
  return logger;
}

test("malformed model JSON retains a safe parse failure instead of an executable empty object", () => {
  const warnings: unknown[] = [];
  const logger = captureLogger(warnings);
  assert.deepEqual(normalizeModelToolInput(malformed, { ...options, logger }), {
    input: {},
    inputError: { code: "invalid_json", inputLength: malformed.length },
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(
    JSON.stringify(warnings),
    /private fixture content|fixture\.txt|empty_object/,
  );
});

test("null inputs retain their cause while valid and genuinely absent inputs stay compatible", () => {
  assert.deepEqual(normalizeModelToolInput(null, options), {
    input: {},
    inputError: { code: "null_input" },
  });
  assert.deepEqual(normalizeModelToolInput("null", options), {
    input: {},
    inputError: { code: "null_input", inputLength: 4 },
  });
  const input = { file_path: "fixture.txt", content: "complete" };
  for (const value of [input, JSON.stringify(input), `\uFEFF${JSON.stringify(input)}`]) {
    assert.deepEqual(normalizeModelToolInput(value, options), { input });
  }
  for (const value of [undefined, "", "{}"]) {
    assert.deepEqual(normalizeModelToolInput(value, options), { input: {} });
  }
  for (const value of [false, 42, [1, 2]]) {
    assert.deepEqual(normalizeModelToolInput(value, options), { input: value });
  }
});

test("non-streaming calls retain parse failures and tool results reuse the safe normalized input", () => {
  const result = {
    toolCalls: [{ toolCallId: "bad-call", toolName: "Write", input: malformed }],
    toolResults: [
      { toolCallId: "bad-call", toolName: "Write", input: malformed, output: "invalid" },
    ],
  } as never;
  const calls = normalizeToolCalls(result);
  assert.deepEqual(calls?.[0]?.inputError, { code: "invalid_json", inputLength: malformed.length });
  assert.deepEqual(normalizeToolResults(result, calls)?.[0]?.input, {});
  const explicitNull = normalizeToolCalls({
    toolCalls: [
      { toolCallId: "null-call", toolName: "Write", input: null, args: { fallback: true } },
    ],
  } as never);
  assert.deepEqual(explicitNull?.[0]?.inputError, { code: "null_input" });
});

for (const finishReason of ["error", "length"]) {
  test(`streaming ${finishReason} keeps the parse failure and closes the final call once`, async () => {
    const warnings: unknown[] = [];
    const logger = captureLogger(warnings);
    let attempts = 0;
    const runtime = {
      async generateText() {
        throw new Error("unexpected generateText");
      },
      streamText() {
        attempts++;
        return {
          fullStream: (async function* () {
            yield { type: "start" };
            yield { type: "tool-input-start", id: "bad-call", toolName: "Write" };
            yield { type: "tool-input-delta", id: "bad-call", delta: malformed };
            yield { type: "tool-input-end", id: "bad-call" };
            const call = {
              type: "tool-call",
              toolCallId: "bad-call",
              toolName: "Write",
              input: malformed,
            };
            yield call;
            yield call;
            yield {
              type: "finish",
              finishReason,
              rawFinishReason: finishReason,
              totalUsage: { outputTokens: 8, totalTokens: 8 },
            };
          })(),
        };
      },
    } as unknown as AiSdkModelRuntime;
    const resolved = {
      model: {},
      modelId: "fixture-model",
      providerId: "fixture-provider",
      providerKind: "openai-compatible",
      properties: { supportsMidConversationSystem: true },
    } as unknown as ResolvedAiSdkModel;
    const events: ModelStreamEvent[] = [];
    for await (const event of runStreamText({
      env: { LCODE_RUNTIME_ENV: "test" },
      logger,
      modelIoFullRetentionEnabled: false,
      request: { messages: [] },
      resolveModel: () => resolved,
      resolved,
      runtime,
      retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      streamIdleTimeoutMs: 1_000,
    }))
      events.push(event);
    const calls = events.filter((event) => event.type === "tool_call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].toolCall.inputError, {
      code: "invalid_json",
      inputLength: malformed.length,
    });
    assert.equal(attempts, 1);
    const finish = events.at(-1);
    assert.equal(finish?.type, "finish");
    if (finish?.type === "finish") assert.equal(finish.finishReason, finishReason);
    const parseWarnings = warnings.filter((warning) =>
      JSON.stringify(warning).includes("model.tool_input.normalize_failed"),
    );
    assert.equal(parseWarnings.length, 1);
    assert.doesNotMatch(JSON.stringify(parseWarnings), /private fixture content|fixture\.txt/);
  });
}
