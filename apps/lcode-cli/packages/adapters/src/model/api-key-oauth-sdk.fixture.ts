import { parseProviderConfig, createRegistryProviderConfig } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "./runner-runtime.js";
let encoded = "";
for await (const chunk of process.stdin) encoded += String(chunk);
const { auth, mode } = JSON.parse(encoded);
const execution = new AiSdkModelExecution({ env: {} });
try {
  const parsed = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "oauth-account", channelId: "copilot" },
      api: { type: auth.protocol, baseUrl: "https://fixture.invalid/v1" },
    }),
  );
  if (!parsed.ok) throw new Error("fixture config");
  const binding = execution.bindModel({
    providerId: "oauth:copilot",
    modelId: "model",
    providerConfig: parsed.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  const resolveModel = () =>
    ({
      ...binding.resolveRequest({
        options: { reasoningLevel: "medium", maxOutputTokens: 20 },
        requestAuth: auth,
      }),
      properties: { contextWindow: 40 },
    }) as ResolvedAiSdkModel;
  const input = {
    env: {},
    modelIoFullRetentionEnabled: false,
    streamIdleTimeoutMs: 10000,
    request: { messages: [{ role: "user" as const, content: "fixture" }], maxOutputTokens: 20 },
    resolveModel,
    resolved: resolveModel(),
    runtime: defaultRuntime,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
  };
  let text = "";
  if (mode === "stream") {
    for await (const event of runStreamText(input))
      if (event.type === "text_delta") text += event.text;
  } else text = (await runGenerateText(input)).text;
  process.stdout.write(JSON.stringify({ text }));
} finally {
  await execution.disposeAndWait();
}
