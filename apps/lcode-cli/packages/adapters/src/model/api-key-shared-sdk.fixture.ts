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

const [directory, origin, mode] = process.argv.slice(2);
const execution = new AiSdkModelExecution({ env: {}, routingQuotaDirectory: directory });
const bound = execution.bindModel({
  providerId: "fixture",
  modelId: "fixture",
  providerSaveGeneration: "fixture-generation",
  providerConfig: new ProviderConfig({
    group: "standard-personal",
    routing: { version: 1, strategy: "share-rotation" },
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: `${origin}/v1` }),
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
const resolveModel = () =>
  ({
    ...bound.resolveRequest({ options: { maxOutputTokens: 20, reasoningLevel: "medium" } }),
    properties: { contextWindow: 40 },
  }) as unknown as ResolvedAiSdkModel;
const accounting = createPhysicalRequestAccounting({ maxRequests: 1, maxReservedTokens: 100 });
const input = {
  env: {},
  modelIoFullRetentionEnabled: false,
  streamIdleTimeoutMs: 10_000,
  request: { messages: [{ role: "user" as const, content: "fixture" }], maxOutputTokens: 20 },
  resolveModel,
  resolved: resolveModel(),
  runtime: defaultRuntime,
  retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
  statusSink: accounting,
  physicalRequestAccounting: accounting,
};
let ok = false;
try {
  if (mode === "stream")
    for await (const _event of runStreamText(input)) {
      /* drain the real SDK stream */
    }
  else await runGenerateText(input);
  ok = true;
} catch {
  /* Only redacted outcome and physical permit counts leave this test process. */
} finally {
  await execution.disposeAndWait();
}
process.stdout.write(JSON.stringify({ ok, requests: accounting.snapshot().requests.length }));
