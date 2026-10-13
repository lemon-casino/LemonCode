import assert from "node:assert/strict";
import test from "node:test";
import { createPhysicalRequestAccounting, ModelRetryBudget } from "@lcode/contracts";
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

for (const mode of ["generate", "stream"] as const) {
  for (const maxAttempts of [1, 2]) {
    test(`${mode} Key rotation respects physical admission, accounting and ${maxAttempts} attempt budget`, async () => {
      const sent: string[] = [];
      const execution = new AiSdkModelExecution(
        {},
        {
          transport: async (input) => {
            const request = new Request(input);
            const auth = request.headers.get("authorization")!;
            sent.push(auth);
            if (auth.endsWith("first"))
              return new Response('{"error":{"message":"synthetic rejected key"}}', {
                status: 401,
                headers: { "content-type": "application/json" },
              });
            return mode === "generate"
              ? Response.json({
                  id: "fixture",
                  choices: [
                    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
              : new Response(
                  [
                    'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
                    'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
                    "data: [DONE]",
                  ].join("\n\n") + "\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                );
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
      const accounting = createPhysicalRequestAccounting({
        maxRequests: 4,
        maxReservedTokens: 480,
      });
      let active = 0,
        acquired = 0;
      const input = {
        env: { LCODE_RUNTIME_ENV: "test" },
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "synthetic" }],
          maxOutputTokens: 20,
          modelRequestAdmission: {
            acquire: async () => {
              active++;
              acquired++;
              return {
                publish() {},
                release: () => {
                  active--;
                },
              };
            },
          },
        },
        resolveModel,
        resolved: resolveModel(),
        runtime: defaultRuntime,
        retry: { maxAttempts, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
        statusSink: accounting,
        physicalRequestAccounting: accounting,
        streamIdleTimeoutMs: 1000,
      };
      const run = async () => {
        if (mode === "generate") return (await runGenerateText(input)).text;
        const events = [];
        for await (const event of runStreamText(input)) events.push(event);
        assert.equal(
          events.some((event) => event.type === "error"),
          false,
        );
        return "ok";
      };
      try {
        if (maxAttempts === 1)
          await assert.rejects(run, (error: unknown) => {
            assert.equal((error as Error).cause instanceof Error, true);
            assert.equal(((error as Error).cause as Error).message, "synthetic rejected key");
            return true;
          });
        else assert.equal(await run(), "ok");
        assert.deepEqual(
          sent,
          maxAttempts === 1 ? ["Bearer first"] : ["Bearer first", "Bearer second"],
        );
        const requests = accounting.snapshot().requests;
        assert.equal(requests.length, sent.length);
        assert.equal(new Set(requests.map((request) => request.requestId)).size, sent.length);
        assert.equal(accounting.snapshot().reservedTokens, sent.length * 120);
        assert.equal(active, 0);
        assert.equal(acquired, sent.length);
      } finally {
        await execution.disposeAndWait();
      }
      let closedAttempts = 0;
      const stopped = new AbortController();
      const closedInput = {
        ...input,
        request: {
          ...input.request,
          abortSignal: stopped.signal,
          modelRetryBudget: ModelRetryBudget.Unbounded,
          modelRequestAdmission: {
            acquire: async () => {
              if (++closedAttempts > 1) stopped.abort();
              return { publish() {}, release() {} };
            },
          },
        },
      };
      await assert.rejects(async () => {
        if (mode === "generate") await runGenerateText(closedInput);
        else
          for await (const _event of runStreamText(closedInput)) {
            /* consume cancellation */
          }
      });
      assert.equal(closedAttempts, 1, "closed owner must terminate even an unbounded request");
      assert.equal(sent.length, maxAttempts);
    });
  }
}
