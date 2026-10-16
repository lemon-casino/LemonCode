import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
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
  'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';

for (const strategy of [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const)
  for (const mode of ["generate", "stream"] as const)
    test(
      `real HTTP ${mode} ${strategy}: wire POST count equals original Runner permits`,
      { timeout: 10_000 },
      async (t) => {
        const posts: string[] = [];
        const server = createServer((request, response) => {
          if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(400);
            response.end();
            return;
          }
          posts.push(request.headers.authorization ?? "missing");
          request.resume();
          if (request.headers.authorization === "Bearer synthetic-first") {
            response.writeHead(429, {
              "content-type": "application/json",
              "retry-after": "120",
              "x-lcode-rate-limit-scope": "key",
            });
            response.end(
              JSON.stringify({ error: { code: 429, message: "synthetic key cooldown" } }),
            );
          } else if (mode === "generate") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "fixture",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            );
          } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(textFrame + finishFrame);
          }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const execution = new AiSdkModelExecution({ env: {} });
        t.after(async () => {
          await execution.disposeAndWait();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const bound = execution.bindModel({
          providerId: "fixture",
          modelId: "fixture",
          providerSaveGeneration: "generation",
          providerConfig: new ProviderConfig({
            group: "standard-personal",
            routing: { version: 1, strategy },
            api: new ProviderApiConfig({
              type: "openai-chat-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            }),
            access: new ApiKeyAccessConfig({
              apiKeys: [
                { id: "a", apiKey: "synthetic-first" },
                { id: "b", apiKey: "synthetic-second" },
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
          admissions = 0;
        const input = {
          env: { LCODE_RUNTIME_ENV: "test" },
          modelIoFullRetentionEnabled: false,
          resolved: resolveModel(),
          resolveModel,
          runtime: defaultRuntime,
          request: {
            messages: [{ role: "user" as const, content: "synthetic fixture" }],
            maxOutputTokens: 20,
            modelRequestAdmission: {
              acquire: async () => {
                admissions++;
                active++;
                return {
                  publish() {},
                  release() {
                    active--;
                  },
                };
              },
            },
          },
          retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
          statusSink: accounting,
          physicalRequestAccounting: accounting,
          streamIdleTimeoutMs: 1000,
        };
        let text = "";
        if (mode === "generate") text = (await runGenerateText(input)).text;
        else
          for await (const event of runStreamText(input))
            if (event.type === "text_delta") text += event.text;
        assert.equal(text, "ok");
        assert.deepEqual(posts, ["Bearer synthetic-first", "Bearer synthetic-second"]);
        assert.equal(accounting.snapshot().requests.length, posts.length);
        assert.equal(admissions, posts.length);
        assert.equal(active, 0);
      },
    );
