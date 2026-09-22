import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { resolveProviderSaveGeneration } from "./provider-registry-model-runtime.js";

test("identical resave publishes a cross-process generation for only that provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-save-generation-"));
  const personal = new NodePersonalProviderConfigRepository({
    filePath: join(directory, "provider_config.json"),
    pollingIntervalMs: false,
  });
  const builtin = emptyLayerSource();
  const configService = new ProviderConfigService({
    zcodeBuiltinSource: builtin,
    personalRepository: personal,
  });
  const registry = new ProviderRegistryService({
    configSource: configService,
    accountSource: {
      read: async () => ({
        revision: "account",
        basedOnZCodeBuiltinRevision: (await configService.read()).zcodeBuiltinRevision,
        providers: ProviderConfigMap.empty(),
      }),
      onDidChange: () => () => undefined,
    },
  });
  try {
    await registry.start();
    const seeded = await personal.update((current) => ({
      ...current,
      savedProviderId: "provider-a",
    }));
    await registry.refresh("seed");
    const before = registry.getSnapshot()?.config.personalSaveGenerations?.["provider-a"];
    const viewRevision = registry.getView().revision;
    assert.equal(before, seeded.saveGenerations?.["provider-a"]);
    assert.equal(typeof before, "string");

    await personal.update((current) => ({ ...current, savedProviderId: "provider-a" }));
    const resaved = await personal.read();
    const after = resaved.saveGenerations?.["provider-a"];
    assert.equal(resaved.revision, seeded.revision);
    assert.notEqual(after, before);
    await registry.refresh("resave");

    assert.equal(registry.getSnapshot()?.config.personalSaveGenerations?.["provider-a"], after);
    assert.equal(registry.getView().revision, viewRevision);

    const reader = new NodePersonalProviderConfigRepository({
      filePath: join(directory, "provider_config.json"),
      pollingIntervalMs: false,
    });
    try {
      assert.equal((await reader.read()).saveGenerations?.["provider-a"], after);
    } finally {
      reader.dispose();
    }

    const savedB = await personal.update((current) => ({
      ...current,
      savedProviderId: "provider-b",
    }));
    await registry.refresh("save-provider-b");
    assert.equal(savedB.saveGenerations?.["provider-a"], after);
    assert.equal(
      registry.getSnapshot()?.config.personalSaveGenerations?.["provider-a"],
      after,
    );
    assert.equal(
      registry.getSnapshot()?.config.personalSaveGenerations?.["provider-b"],
      savedB.saveGenerations?.["provider-b"],
    );

    assert.deepEqual(resolveProviderSaveGeneration(registry, "provider-a"), {
      providerSaveGeneration: after,
    });
    assert.deepEqual(resolveProviderSaveGeneration(registry, "provider-b"), {
      providerSaveGeneration: savedB.saveGenerations?.["provider-b"],
    });
    assert.deepEqual(resolveProviderSaveGeneration(registry, "provider-c"), {});
  } finally {
    registry.dispose();
    personal.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyLayerSource(): ProviderSource<ProviderConfigLayerSnapshot> {
  const snapshot: ProviderConfigLayerSnapshot = Object.freeze({
    revision: "builtin",
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  return {
    read: async () => snapshot,
    onDidChange: () => () => undefined,
  };
}
