import assert from "node:assert/strict";
import test from "node:test";
import { createPhysicalRequestAccounting } from "@lcode/contracts";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "./runner-runtime.js";

const textFrame =
  'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n';
const finishFrame =
  'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function fixture(
  mode: "generate" | "stream",
  failure: "http" | "json" | "sse" | "committed",
  scope: string | undefined,
) {
  const sent: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const auth = new Request(input).headers.get("authorization")!;
        sent.push(auth);
        if (auth.endsWith("first")) {
          const headers = new Headers({ "retry-after": "120", "content-type": "application/json" });
          if (scope) headers.set("x-lcode-rate-limit-scope", scope);
          const error = { error: { code: 429, message: "fixture rate limited" } };
          if (failure === "sse" || failure === "committed")
            return new Response(
              (failure === "committed" ? textFrame : "") + `data: ${JSON.stringify(error)}\n\n`,
              { headers },
            );
          return new Response(JSON.stringify(error), {
            status: failure === "http" ? 429 : 200,
            headers,
          });
        }
        return mode === "generate"
          ? Response.json({
              id: "fixture",
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          : new Response(textFrame + finishFrame, {
              headers: { "content-type": "application/json" },
            });
      },
    },
  );
  const bound = execution.bindModel({
    providerId: "fixture",
    modelId: "fixture",
    providerSaveGeneration: "save-1",
    providerConfig: new ProviderConfig({
      group: "standard-personal",
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://example.test/v1",
      }),
      access: new ApiKeyAccessConfig({
        apiKeys: [
          { id: "first", apiKey: "first", enabled: true },
          { id: "second", apiKey: "second", enabled: true },
        ],
      }),
    }) as RegistryProviderConfig,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  const resolveModel = () =>
    ({
      ...bound.resolveRequest({ options: { maxOutputTokens: 20, reasoningLevel: "medium" } }),
      properties: {
        contextWindow: 100,
        inputFormat: { text: true },
        outputFormat: { text: true },
        supportsToolCall: true,
      },
    }) as unknown as ResolvedAiSdkModel;
  const accounting = createPhysicalRequestAccounting({ maxRequests: 4, maxReservedTokens: 480 });
  const controller = new AbortController();
  let active = 0,
    admitted = 0,
    cancelOnRelease = false;
  const input = {
    env: { LCODE_RUNTIME_ENV: "test" },
    modelIoFullRetentionEnabled: false,
    request: {
      messages: [{ role: "user" as const, content: "fixture" }],
      maxOutputTokens: 20,
      abortSignal: controller.signal,
      modelRequestAdmission: {
        acquire: async () => {
          active++;
          admitted++;
          return {
            publish() {},
            release() {
              active--;
              if (cancelOnRelease) controller.abort();
            },
          };
        },
      },
    },
    resolveModel,
    resolved: resolveModel(),
    runtime: defaultRuntime,
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
    statusSink: accounting,
    physicalRequestAccounting: accounting,
    streamIdleTimeoutMs: 1000,
  };
  const run = async () => {
    if (mode === "generate") return (await runGenerateText(input)).text;
    let text = "";
    for await (const event of runStreamText(input))
      if (event.type === "text_delta") text += event.text;
    return text;
  };
  return {
    input,
    execution,
    run,
    sent,
    accounting,
    get active() {
      return active;
    },
    get admitted() {
      return admitted;
    },
    cancelAfterAdmissionRelease() {
      cancelOnRelease = true;
    },
  };
}

for (const mode of ["generate", "stream"] as const)
  for (const failure of (mode === "stream" ? ["http", "json", "sse"] : ["http", "json"]) as Array<
    "http" | "json" | "sse"
  >) {
    test(
      `${mode} ${failure} 429 rotates only an explicitly scoped Key with separate physical accounting`,
      { timeout: 3000 },
      async () => {
        const f = fixture(mode, failure, "key");
        try {
          assert.equal(await f.run(), "ok");
          assert.deepEqual(f.sent, ["Bearer first", "Bearer second"]);
          assert.equal(f.accounting.snapshot().requests.length, 2);
          assert.equal(f.admitted, 2);
          assert.equal(f.active, 0);
        } finally {
          await f.execution.disposeAndWait();
        }
      },
    );
  }

for (const mode of ["generate", "stream"] as const)
  test(
    `${mode} shared cooldown releases admission before waiting and does not account unsent requests`,
    { timeout: 3000 },
    async () => {
      const f = fixture(mode, "http", undefined);
      try {
        f.input.retry.maxAttempts = 1;
        await assert.rejects(f.run);
        f.cancelAfterAdmissionRelease();
        await assert.rejects(f.run);
        assert.deepEqual(f.sent, ["Bearer first"]);
        assert.equal(f.active, 0);
        assert.equal(f.admitted, 2);
        assert.equal(f.accounting.snapshot().requests.length, 1);
      } finally {
        await f.execution.disposeAndWait();
      }
    },
  );

test(
  "SSE 429 after committed text cools the Key without replaying output",
  { timeout: 3000 },
  async () => {
    const f = fixture("stream", "committed", "key");
    try {
      await assert.rejects(f.run);
      assert.deepEqual(f.sent, ["Bearer first"]);
      assert.equal(f.accounting.snapshot().requests.length, 1);
      const next = await f.input.resolved.acquireApiKeyAttempt!();
      next.release();
      assert.equal(f.active, 0);
    } finally {
      await f.execution.disposeAndWait();
    }
  },
);
