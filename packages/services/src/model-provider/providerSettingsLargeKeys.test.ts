import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelConfigRules,
  parsePersonalProviderConfigMap,
  isApiKeyAccess,
  ProviderSettingsFacade,
  serializeRegistryProviderConfig,
} from "@lcode/provider";
import { encodeProviderConfigFile } from "@lcode/provider-node";
import { BufferReader, BufferWriter, serialize, deserialize } from "@lcode/rpc";
import { createProviderConfigRuntime } from "./providerConfigRuntime.js";
import { ProviderRuntime } from "./providerRuntime.js";

function roundTrip(value: unknown) {
  const start = performance.now();
  const writer = new BufferWriter();
  serialize(writer, value);
  const wire = writer.buffer;
  const decoded = deserialize(new BufferReader(wire));
  return { decoded, bytes: wire.byteLength, ms: performance.now() - start };
}

test(
  "100k keys stay out of startup, model mutations and change events; lazy reads and edits preserve every key",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-key-view-"));
    const personalFilePath = join(directory, "personal.json");
    const builtinFilePath = join(directory, "builtin.json");
    await writeFile(
      builtinFilePath,
      await readFile(new URL("../../../../config/provider/lcode-builtin.json", import.meta.url)),
    );
    const keys = Array.from({ length: 100_000 }, (_, i) => ({
      id: String(i),
      apiKey: `synthetic-${"x".repeat(180)}-${i}`,
      label: `Fixture ${i}`,
      enabled: i % 5 !== 0,
    }));
    await writeFile(
      personalFilePath,
      JSON.stringify(
        encodeProviderConfigFile({
          providers: parsePersonalProviderConfigMap({
            providerRules: [
              {
                providerId: "large-test",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: keys[1]!.apiKey, apiKeys: keys },
                  api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:1" },
                },
              },
            ],
          }),
          models: ModelConfigRules.empty(),
        }),
        null,
        2,
      ),
    );
    const runtime = new ProviderRuntime({
      configRuntime: createProviderConfigRuntime({
        personalFilePath,
        lcodeBuiltinFilePath: builtinFilePath,
        watch: false,
        personalPollingIntervalMs: false,
      }),
    });
    t.after(async () => {
      runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    await runtime.start();
    const facade = new ProviderSettingsFacade(runtime.registryService);
    const full = roundTrip(facade.getView());
    const compact = roundTrip(await runtime.providerSettings.getView());
    assert.ok(full.bytes > 40_000_000);
    assert.ok(compact.bytes < 250_000);
    const events: number[] = [];
    const subscription = runtime.providerSettings.onDidChange((view) =>
      events.push(roundTrip(view).bytes),
    );
    t.after(() => subscription.dispose());
    const added = await runtime.providerSettings.addPersonalModel("large-test", "gpt-6-sol", {});
    assert.ok(roundTrip(added).bytes < 250_000);
    const selection = await runtime.modelSelection.getView();
    const selectedProvider = selection.providers.find(
      (provider) => provider.providerId === "large-test",
    );
    assert.ok(selectedProvider);
    assert.ok(isApiKeyAccess(selectedProvider.config.access));
    assert.equal(selectedProvider.config.access.apiKeys, undefined);
    assert.equal(selectedProvider.config.access.apiKey, keys[1]!.apiKey);
    assert.ok(roundTrip(selection).bytes < 250_000);
    const registryProvider = runtime.registryService
      .getView()
      .providers.find((provider) => provider.providerId === "large-test");
    assert.ok(registryProvider);
    const completeAccess = serializeRegistryProviderConfig(registryProvider.config).access;
    assert.ok(isApiKeyAccess(completeAccess));
    assert.equal(completeAccess.apiKeys?.length, keys.length);
    const initial = added.providers.find((provider) => provider.providerId === "large-test")!;
    assert.deepEqual(initial.apiKeySummary, { total: 100_000, enabled: 80_000 });
    await runtime.providerSettings.savePersonalProviderOverlay(
      "large-test",
      {
        ...initial.personalConfig,
        api: { ...initial.personalConfig?.api, baseUrl: "http://127.0.0.1:2" },
      },
      { preserveApiKeys: true },
    );
    assert.deepEqual(JSON.parse(await runtime.providerSettings.getApiKeysJson("large-test")), keys);
    const deletionStarted = performance.now();
    const deleted = await runtime.providerSettings.deletePersonalModel("large-test", "gpt-6-sol");
    const deletionMs = performance.now() - deletionStarted;
    assert.ok(
      !deleted.providers
        .find((provider) => provider.providerId === "large-test")
        ?.models.some((model) => model.modelId === "gpt-6-sol"),
    );
    assert.ok(roundTrip(deleted).bytes < 250_000);
    assert.deepEqual(JSON.parse(await runtime.providerSettings.getApiKeysJson("large-test")), keys);
    assert.ok(events.length > 0 && events.every((bytes) => bytes < 250_000));
    // 明确保存空数组仍可删除全部，不能被摘要的保留标记阻断。
    const cleared = await runtime.providerSettings.savePersonalProviderOverlay(
      "large-test",
      {
        ...initial.personalConfig,
        access: { type: "api-key", apiKey: null, apiKeys: [] },
      },
      { preserveApiKeys: true },
    );
    assert.equal(
      cleared.providers.find((provider) => provider.providerId === "large-test")?.apiKeysOmitted,
      undefined,
    );
    assert.deepEqual(JSON.parse(await runtime.providerSettings.getApiKeysJson("large-test")), []);
    await runtime.providerSettings.savePersonalProviderOverlay(
      "large-test",
      {
        ...initial.personalConfig,
        api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:3" },
      },
      { preserveApiKeys: true },
    );
    assert.deepEqual(
      JSON.parse(await runtime.providerSettings.getApiKeysJson("large-test")),
      [],
      "stale summaries cannot restore a cleared primary key",
    );
    t.diagnostic(
      `100k Settings RPC ${full.bytes} -> ${compact.bytes} bytes; round trip ${Math.round(full.ms)} -> ${compact.ms.toFixed(2)}ms; model deletion ${Math.round(deletionMs)}ms`,
    );
  },
);
