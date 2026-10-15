import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_MODEL_INTERACTION_PROTOCOL,
  completeModelPropertiesDataSchema,
  resolveModelInteractionProtocol,
} from "@lcode/shared/model-config";
import {
  ModelConfig,
  ModelPropertiesConfig,
  createRegistryModelConfig,
  manualModelConfigSchema,
  parseModelConfig,
  parseLCodeBuiltinModelConfigRules,
  serializeRegistryModelConfig,
} from "../src/index.js";

const source = JSON.parse(
  // 重命名后旧包名/文件已不存在，必须从当前公开入口与内置配置执行真实回归。
  await readFile(resolve(process.cwd(), "config/provider/lcode-builtin.json"), "utf8"),
) as { config: { modelConfigRules: unknown } };
const rules = parseLCodeBuiltinModelConfigRules(source.config.modelConfigRules);

test("old model properties keep native tool calls without migration", () => {
  const properties = completeModelPropertiesDataSchema.parse({
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  });

  assert.equal(properties.interactionProtocol, undefined);
  assert.equal(resolveModelInteractionProtocol(properties), DEFAULT_MODEL_INTERACTION_PROTOCOL);
});

test("model config parses and overlays an explicit UI-TARS protocol", () => {
  const parsed = parseModelConfig({
    properties: { interactionProtocol: "ui-tars-text-actions" },
  });
  assert.deepEqual(parsed.toJSON(), {
    properties: { interactionProtocol: "ui-tars-text-actions" },
  });

  const inherited = new ModelPropertiesConfig({
    interactionProtocol: "native-tool-calls",
  }).overlay(new ModelPropertiesConfig());
  assert.equal(inherited.interactionProtocol, "native-tool-calls");
  assert.equal(
    inherited.overlay(new ModelPropertiesConfig({ interactionProtocol: "ui-tars-text-actions" }))
      .interactionProtocol,
    "ui-tars-text-actions",
  );
});

test("registry serialization preserves only an explicitly configured protocol", () => {
  const base = rules.resolve({
    providerId: "test-provider",
    modelId: "kimi-k2.6",
    apiType: "anthropic-messages",
    baseUrl: "https://example.test/v1",
  });
  const baseRegistry = createRegistryModelConfig(base);
  if (!baseRegistry.ok) assert.fail(JSON.stringify(baseRegistry.issues));
  const oldSerialized = serializeRegistryModelConfig(baseRegistry.config);
  assert.equal(oldSerialized.properties.interactionProtocol, undefined);

  const configured = base.overlay(
    new ModelConfig({
      properties: new ModelPropertiesConfig({
        interactionProtocol: "ui-tars-text-actions",
      }),
    }),
  );
  const configuredRegistry = createRegistryModelConfig(configured);
  if (!configuredRegistry.ok) assert.fail(JSON.stringify(configuredRegistry.issues));
  assert.equal(
    serializeRegistryModelConfig(configuredRegistry.config).properties.interactionProtocol,
    "ui-tars-text-actions",
  );
});

test("UI-TARS complete provider properties require image input", () => {
  const properties = new ModelPropertiesConfig({
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
    interactionProtocol: "ui-tars-text-actions",
  });

  assert.deepEqual(properties.validateComplete()[0]?.path, ["inputFormat", "supportsImage"]);
});

test("manual model properties retain the explicit protocol", () => {
  const result = manualModelConfigSchema.shape.properties.safeParse({
    contextWindow: 128_000,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
    interactionProtocol: "ui-tars-text-actions",
    inputFormat: { supportsImage: true, supportsVideo: false, supportsPdf: false },
  });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.interactionProtocol, "ui-tars-text-actions");
});
