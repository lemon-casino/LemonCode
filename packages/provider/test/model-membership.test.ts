import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplate,
  ProviderTemplateMap,
  parseProviderConfig,
} from "../src/index.js";
import {
  createMembershipFixture,
  defaultSelection,
  manualModelConfig,
  roundtrip,
} from "./model-membership.fixture.js";

for (const [providerId, modelId] of [
  ["builtin", "Base"],
  ["template", "Base"],
  ["personal", "Custom"],
] as const) {
  test(`${providerId}: deletion removes membership, order and exact rules without changing sources`, async (t) => {
    const f = await createMembershipFixture(t);
    const sourcesBefore = JSON.stringify([
      f.builtin.snapshot.providers,
      f.builtin.snapshot.providerTemplates,
    ]);
    await f.repository.update((current) => ({
      ...current,
      models: current.models
        .setExact(providerId, modelId, manualModelConfig, false)
        .setExact("other", modelId, new ModelConfig({ enabled: true })),
    }));
    await f.registry.refresh("seed-exact");
    assert.ok(f.ids(providerId).includes(modelId));
    assert.ok(f.registry.getModel(providerId, modelId));

    await f.settings.deletePersonalModel(providerId, ` ${modelId} `);
    const saved = f.repository.snapshot;
    const provider = saved.providers.get(providerId)!;
    assert.deepEqual(provider.excludedModelIds, [modelId]);
    assert.equal(provider.personalModelIds?.includes(modelId), false);
    assert.equal(provider.modelOrder?.includes(modelId), false);
    assert.equal(saved.models.getExact(providerId, modelId), undefined);
    assert.ok(saved.models.getExact("other", modelId));
    assert.equal(f.ids(providerId).includes(modelId), false);
    assert.equal(f.registry.getModel(providerId, modelId), undefined);
    assert.deepEqual(saved.defaultModelSelection, defaultSelection);
    assert.equal(f.repository.updates.at(-1)?.savedProviderId, providerId);
    assert.equal(saved.saveGenerations?.other, "untouched-generation");
    assert.equal(
      JSON.stringify([f.builtin.snapshot.providers, f.builtin.snapshot.providerTemplates]),
      sourcesBefore,
    );

    assert.deepEqual(roundtrip(saved).providers.get(providerId)?.excludedModelIds, [modelId]);
    f.builtin.snapshot = { ...f.builtin.snapshot, revision: "builtin-2" };
    await f.settings.refresh("source-refresh");
    assert.equal(f.ids(providerId).includes(modelId), false);
    assert.equal(f.registry.getModel(providerId, modelId), undefined);
  });

  test(`${providerId}: explicit add restores a deleted member and duplicate add preserves manual parameters`, async (t) => {
    const f = await createMembershipFixture(t);
    await f.settings.deletePersonalModel(providerId, modelId);
    await f.settings.addPersonalModel(providerId, ` ${modelId} `, {}, true);
    assert.equal(f.ids(providerId).filter((id) => id === modelId).length, 1);
    assert.deepEqual(f.repository.snapshot.providers.get(providerId)?.excludedModelIds, []);
    const personalIds = f.repository.snapshot.providers.get(providerId)?.personalModelIds ?? [];
    assert.equal(personalIds.includes(modelId), providerId === "personal");
    assert.equal(
      f.settings
        .getView()
        .providers.find((item) => item.providerId === providerId)
        ?.models.find((model) => model.modelId === modelId)?.builtin,
      providerId !== "personal",
    );

    const fixed = manualModelConfig.overlay(new ModelConfig({ enabled: false }));
    await f.settings.savePersonalModelDraft({
      providerId,
      originalModelId: modelId,
      nextModelId: modelId,
      personalConfig: fixed.toJSON(),
      useRecommendedConfig: false,
      basedOnRevision: f.settings.getView().revision,
    });
    const before = roundtrip(f.repository.snapshot);
    const generations = f.repository.snapshot.saveGenerations;
    await f.settings.addPersonalModel(
      providerId,
      ` ${modelId} `,
      { properties: { contextWindow: 999 } },
      true,
    );
    assert.deepEqual(roundtrip(f.repository.snapshot), before);
    assert.deepEqual(f.repository.snapshot.saveGenerations, generations);
    assert.equal(
      f.repository.snapshot.models.getExactRule(providerId, modelId)?.type,
      "manual-provider-model",
    );
    assert.equal(f.ids(providerId).filter((id) => id === modelId).length, 1);
    assert.equal(f.registry.getModel(providerId, modelId), undefined);
    await f.settings.setPersonalModelEnabled(providerId, modelId, true);
    assert.ok(f.registry.getModel(providerId, modelId));
    assert.deepEqual(
      f.repository.snapshot.models.getExact(providerId, modelId)?.properties?.toJSON(),
      fixed.properties?.toJSON(),
    );
  });
}

test("deleting all template and personal members leaves an empty list after refresh", async (t) => {
  const f = await createMembershipFixture(t);
  for (const id of f.ids("template")) await f.settings.deletePersonalModel("template", id);
  await f.settings.refresh("empty-list");
  assert.deepEqual(f.ids("template"), []);
  assert.equal(f.registry.getProvider("template"), undefined);
  assert.deepEqual(
    new Set(f.repository.snapshot.providers.get("template")?.excludedModelIds),
    new Set(["Base", "TemplateOnly", "Custom"]),
  );
  await f.settings.addPersonalModel("template", "Base", {});
  assert.deepEqual(f.ids("template"), ["Base"]);
  assert.deepEqual(
    new Set(f.repository.snapshot.providers.get("template")?.excludedModelIds),
    new Set(["TemplateOnly", "Custom"]),
  );
});

test("normal provider saves and reorders preserve exclusions and cannot edit membership", async (t) => {
  const f = await createMembershipFixture(t);
  await f.settings.deletePersonalModel("template", "Base");
  await f.settings.savePersonalProviderOverlay(
    "template",
    {
      ...f.repository.snapshot.providers.get("template")!.toJSON(),
      excludedModelIds: [],
      personalModelIds: ["Injected"],
      modelOrder: ["Base", "Injected"],
    },
    { providerName: "Renamed" },
  );
  await f.settings.reorderPersonalModels("template", [
    " Base ",
    " Custom ",
    "Custom",
    "TemplateOnly",
  ]);
  await f.settings.reorderPersonalProviders(["other", "personal", "template"]);
  const saved = f.repository.snapshot;
  assert.deepEqual(saved.providers.get("template")?.excludedModelIds, ["Base"]);
  assert.deepEqual(saved.providers.get("template")?.personalModelIds, ["Custom"]);
  assert.deepEqual(saved.providers.get("template")?.modelOrder, ["Custom", "TemplateOnly"]);
  assert.deepEqual(f.ids("template"), ["Custom", "TemplateOnly"]);
  assert.equal(saved.providers.getRule("template")?.providerName, "Renamed");
  assert.deepEqual(saved.defaultModelSelection, defaultSelection);
});

test("deleted members reject late enable/draft commands even with a fresh revision", async (t) => {
  const f = await createMembershipFixture(t);
  for (const [providerId, modelId] of [
    ["builtin", "Base"],
    ["template", "Base"],
    ["personal", "Custom"],
  ]) {
    await f.settings.deletePersonalModel(providerId!, modelId!);
    const before = f.repository.snapshot;
    for (const enabled of [false, true]) {
      await assert.rejects(
        f.settings.setPersonalModelEnabled(providerId!, modelId!, enabled),
        /Model 不存在/,
      );
    }
    await assert.rejects(
      f.settings.savePersonalModelDraft({
        providerId: providerId!,
        originalModelId: modelId!,
        nextModelId: modelId!,
        personalConfig: { enabled: true },
        basedOnRevision: f.settings.getView().revision,
      }),
      /Model 不存在/,
    );
    assert.equal(f.repository.snapshot, before);
  }
});

test("Facade queues deletion ahead of already queued enable and draft writes", async (t) => {
  const f = await createMembershipFixture(t);
  const revision = f.settings.getView().revision;
  const results = await Promise.allSettled([
    f.settings.deletePersonalModel("template", "Base"),
    f.settings.setPersonalModelEnabled("template", "Base", true),
    f.settings.savePersonalModelDraft({
      providerId: "template",
      originalModelId: "Base",
      nextModelId: "Base",
      personalConfig: {},
      basedOnRevision: revision,
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "rejected"],
  );
  assert.equal(f.ids("template").includes("Base"), false);
  assert.equal(f.repository.snapshot.models.getExact("template", "Base"), undefined);
});

test("distinct case, version and provider identities are not merged", async (t) => {
  const f = await createMembershipFixture(t);
  await f.settings.addPersonalModel("personal", " Custom ", {});
  await f.settings.addPersonalModel("personal", "CUSTOM", {});
  await f.settings.deletePersonalModel("personal", "Custom");
  assert.deepEqual(f.ids("personal"), ["Custom-v2", "custom", "CUSTOM"]);
  assert.deepEqual(f.ids("other"), ["Custom"]);
  await f.settings.addPersonalModel("personal", "Custom", {});
  assert.deepEqual(f.ids("personal"), ["Custom-v2", "custom", "CUSTOM", "Custom"]);
});

test("Account replacement and empty membership never fall back to the static list", async (t) => {
  const f = await createMembershipFixture(t);
  const replace = async (ids: readonly string[]) => {
    f.account.providers = new ProviderConfigMap([
      ["account:test", new ProviderConfig({ builtinModelIds: ids })],
    ]);
    await f.registry.refresh("account-replacement");
  };
  await replace([" Dynamic ", "Dynamic", "Another"]);
  assert.deepEqual(f.ids("account:test"), ["Dynamic", "Another"]);
  await f.settings.deletePersonalModel("account:test", "Dynamic");
  assert.deepEqual(f.ids("account:test"), ["Another"]);
  await f.settings.addPersonalModel("account:test", "Dynamic", {});
  assert.deepEqual(f.repository.snapshot.providers.get("account:test")?.personalModelIds, []);
  assert.equal(f.ids("account:test").includes("Static"), false);
  await f.settings.deletePersonalModel("account:test", "Dynamic");
  await replace(["Replacement"]);
  assert.deepEqual(f.ids("account:test"), ["Replacement"]);
  await replace(["Dynamic", "Another"]);
  assert.deepEqual(f.ids("account:test"), ["Another"]);
  await replace([]);
  assert.deepEqual(f.ids("account:test"), []);
  await assert.rejects(
    f.settings.setPersonalModelEnabled("account:test", "Static", true),
    /Model 不存在/,
  );
  await f.settings.reorderPersonalModels("account:test", ["Static", "Dynamic"]);
  assert.deepEqual(f.repository.snapshot.providers.get("account:test")?.modelOrder, []);
});

test("rename and draft rename cannot bypass explicit re-add of a deleted identity", async (t) => {
  const f = await createMembershipFixture(t);
  await f.settings.deletePersonalModel("personal", "Custom");
  const before = f.repository.snapshot;
  await assert.rejects(f.settings.renamePersonalModel("personal", "custom", "Custom"), /显式添加/);
  await assert.rejects(
    f.service.savePersonalModelDraft(
      "personal",
      "custom",
      "Custom",
      new ModelConfig(),
      before.revision,
    ),
    /显式添加/,
  );
  assert.equal(f.repository.snapshot, before);
  await f.settings.renamePersonalModel("personal", "custom", "Renamed");
  await f.settings.savePersonalModelDraft({
    providerId: "personal",
    originalModelId: "Renamed",
    nextModelId: "DraftRenamed",
    personalConfig: {},
    basedOnRevision: f.settings.getView().revision,
  });
  assert.deepEqual(f.ids("personal"), ["Custom-v2", "DraftRenamed"]);
  assert.deepEqual(f.repository.snapshot.providers.get("personal")?.excludedModelIds, ["Custom"]);
  assert.deepEqual(f.repository.snapshot.providers.get("personal")?.modelOrder, [
    "Custom-v2",
    "DraftRenamed",
  ]);
});

test("membership and personal revision assertions still run on duplicate adds", async (t) => {
  const f = await createMembershipFixture(t);
  const context = {
    providerId: "template",
    inheritedModelIds: ["Base", "TemplateOnly"],
    personalRevision: f.repository.snapshot.revision,
  };
  const before = f.repository.snapshot;
  await assert.rejects(
    f.service.addPersonalModel("template", "Base", new ModelConfig(), {
      ...context,
      assertCurrent: () => {
        throw new Error("stale-snapshot");
      },
    }),
    /stale-snapshot/,
  );
  await assert.rejects(
    f.service.addPersonalModel("template", "Base", new ModelConfig(), {
      ...context,
      personalRevision: "stale-personal",
      assertCurrent: () => undefined,
    }),
    /membership revision conflict/,
  );
  await assert.rejects(
    f.service.savePersonalModelDraft(
      "template",
      "Base",
      "Base",
      new ModelConfig(),
      "stale-personal",
    ),
    /revision conflict/,
  );
  assert.equal(f.repository.snapshot, before);
});

test("deleted provider cannot be resurrected by late member commands", async (t) => {
  const f = await createMembershipFixture(t);
  await f.settings.deletePersonalProvider("template");
  const before = f.repository.snapshot;
  await assert.rejects(
    f.service.addPersonalModel("template", "Base", new ModelConfig()),
    /Provider 不存在/,
  );
  await assert.rejects(f.service.setPersonalModelEnabled("template", "Base", true), /Model 不存在/);
  await assert.rejects(
    f.service.savePersonalModelDraft(
      "template",
      "Base",
      "Base",
      new ModelConfig(),
      before.revision,
    ),
    /Model 不存在/,
  );
  assert.equal(f.repository.snapshot, before);
});

test("exclusion wins over overlapping inherited/personal members and later source additions", async (t) => {
  const f = await createMembershipFixture(t);
  await f.overlay(
    "template",
    parseProviderConfig({ personalModelIds: [" Base ", "Base", "Custom", " Custom "] }),
  );
  assert.equal(f.ids("template").filter((id) => id === "Base").length, 1);
  await f.settings.deletePersonalModel("template", "Base");
  await f.settings.deletePersonalModel("template", "Custom");
  const template = f.builtin.snapshot.providerTemplates.get("definition")!;
  f.builtin.snapshot = {
    ...f.builtin.snapshot,
    revision: "builtin-added-model",
    providerTemplates: f.builtin.snapshot.providerTemplates.overlay(
      new ProviderTemplateMap([
        [
          "definition",
          new ProviderTemplate({
            ...template,
            config: template.config.withBuiltinModelIds(["Base", "TemplateOnly", "Custom"]),
          }),
        ],
      ]),
    ),
  };
  await f.settings.refresh("template-added-deleted-personal");
  assert.deepEqual(f.ids("template"), ["TemplateOnly"]);
  await f.settings.addPersonalModel("template", "Custom", {});
  assert.equal(
    f.repository.snapshot.providers.get("template")?.personalModelIds?.includes("Custom"),
    false,
  );
});
