import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhysicalRequestAccounting } from "@lcode/contracts";
import {
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderApiConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "./runner-runtime.js";

for (const mode of ["generate", "stream"] as const)
  test(
    `real SDK ${mode} cross-executor durable Token reservation blocks another Key before POST and settles actual usage`,
    { timeout: 15_000 },
    async (t) => {
      let posts = 0;
      let rejectRequest = false;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const server = createServer((request, response) => {
        posts++;
        request.resume();
        entered.resolve();
        if (rejectRequest) {
          response.writeHead(429, {
            "content-type": "application/json",
            "retry-after-ms": "0",
            "x-lcode-rate-limit-scope": "shared",
          });
          response.end(
            JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit_error" } }),
          );
          return;
        }
        void (async () => {
          if (posts === 1) await release.promise;
          if (mode === "stream") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
            );
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "fixture",
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
        })();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const directory = await mkdtemp(join(tmpdir(), "lcode-quota-sdk-"));
      const execution = new AiSdkModelExecution({ env: {}, routingQuotaDirectory: directory });
      const other = new AiSdkModelExecution({ env: {}, routingQuotaDirectory: directory });
      t.after(async () => {
        release.resolve();
        await execution.disposeAndWait();
        await other.disposeAndWait();
        await rm(directory, { recursive: true, force: true });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const modelInput = {
        providerId: "fixture",
        modelId: "fixture",
        providerSaveGeneration: "generation",
        providerConfig: new ProviderConfig({
          group: "standard-personal",
          routing: { version: 1, strategy: "share-rotation" },
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          }),
          access: new ApiKeyAccessConfig({
            apiKeys: ["a", "b"].map((id) => ({
              id,
              apiKey: `synthetic-${id}`,
              routing: { quotaPoolId: "team" },
            })),
          }),
        }) as RegistryProviderConfig,
        supportsJsonSchemaOutput: false,
        optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
      };
      const bound = execution.bindModel(modelInput);
      const otherBound = other.bindModel({
        ...modelInput,
        providerSaveGeneration: "next-generation",
      });
      execution.observeApiKeyRoutingQuota("fixture", {
        poolId: "team",
        windows: [
          {
            resourceId: "tokens",
            instanceId: "p",
            revision: 1,
            unit: "tokens",
            kind: "budget",
            quality: "fresh",
            remaining: 100,
            limit: 100,
          },
        ],
      });
      const generate = (alternate = false, small = false) => {
        const currentBound = alternate ? otherBound : bound;
        const resolveModel = () =>
          ({
            ...currentBound.resolveRequest({
              options: { maxOutputTokens: 20, reasoningLevel: "medium" },
            }),
            properties: { contextWindow: small ? 5 : 40 },
          }) as unknown as ResolvedAiSdkModel;
        const accounting = createPhysicalRequestAccounting({
          maxRequests: 1,
          maxReservedTokens: 100,
        });
        const input = {
          env: {},
          modelIoFullRetentionEnabled: false,
          streamIdleTimeoutMs: 10_000,
          request: {
            messages: [{ role: "user" as const, content: "fixture" }],
            maxOutputTokens: 20,
          },
          resolveModel,
          resolved: resolveModel(),
          runtime: defaultRuntime,
          retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
          statusSink: accounting,
          physicalRequestAccounting: accounting,
        };
        const promise =
          mode === "generate"
            ? runGenerateText(input)
            : (async () => {
                let text = "";
                for await (const event of runStreamText(input))
                  if (event.type === "text_delta") text += event.text;
                return { text };
              })();
        return { promise, accounting };
      };
      const first = generate();
      await entered.promise;
      const rejected = generate(true);
      await assert.rejects(rejected.promise);
      assert.equal(posts, 1);
      assert.equal(
        rejected.accounting.snapshot().requests.length,
        0,
        "local reservation rejection must not consume a physical POST permit",
      );
      release.resolve();
      assert.equal((await first.promise).text, "ok");
      const next = generate(true);
      assert.equal((await next.promise).text, "ok");
      assert.equal(posts, 2);
      const shared = await execution.readSharedApiKeyQuota("fixture", "team");
      assert.equal(shared!.resources[0]!.available, 70);
      await execution.observeSharedApiKeyQuota(
        "fixture",
        {
          poolId: "team",
          windows: [
            {
              resourceId: "tokens",
              instanceId: "p",
              revision: 2,
              unit: "tokens",
              kind: "budget",
              quality: "fresh",
              remaining: 100,
              limit: 100,
            },
          ],
        },
        shared!.sequence,
      );
      assert.equal(
        (await execution.readSharedApiKeyQuota("fixture", "team"))!.resources[0]!.available,
        100,
      );
      const diagnostic = execution.readApiKeyRoutingDiagnostics("fixture", { limit: 2 });
      assert.equal(JSON.stringify(diagnostic).includes("synthetic-"), false);
      rejectRequest = true;
      await assert.rejects(generate().promise);
      assert.equal(posts, 3);
      rejectRequest = false;
      const cooling = await execution.readSharedApiKeyQuota("fixture", "team");
      assert.equal(cooling!.recovery[0]!.phase, "probe-eligible");
      assert.equal((await generate(false, true).promise).text, "ok");
      assert.equal(posts, 4);
      assert.equal(
        (await execution.readSharedApiKeyQuota("fixture", "team"))!.recovery[0]?.phase ?? "healthy",
        "healthy",
      );
    },
  );
