import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelConfigRules,
  ProviderConfigMap,
  parsePersonalProviderConfigMap,
} from "@lcode/provider";
import { NodePersonalProviderConfigRepository } from "./personal-provider-config-repository.js";
import { encodeProviderConfigFile } from "./provider-config-file-codec.js";
import { ProviderConfigSnapshotCache } from "./providerConfigSnapshotCache.js";

test("100k configuration reads reuse a validated snapshot; replacement, sidecar, deletion and recovery remain visible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-config-cache-"));
  const filePath = join(directory, "providers.json");
  const repository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  t.after(async () => {
    repository.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const keys = Array.from({ length: 100_000 }, (_, index) => ({
    id: String(index),
    apiKey: `fixture-${index}`,
    enabled: true,
  }));
  const update = {
    providers: parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "test",
          config: { group: "standard-personal", access: { type: "api-key", apiKeys: keys } },
        },
      ],
    }),
    models: ModelConfigRules.empty(),
  };
  await writeFile(filePath, JSON.stringify(encodeProviderConfigFile(update)));
  const [first, concurrent] = await Promise.all([repository.read(), repository.read()]);
  assert.strictEqual(first, concurrent);
  for (let index = 0; index < 12; index++) assert.strictEqual(await repository.read(), first);
  await writeFile(
    `${filePath}.runtime.json`,
    JSON.stringify({ schemaVersion: 1, saveGenerations: { test: "new-generation" } }),
  );
  assert.equal((await repository.read()).saveGenerations?.test, "new-generation");
  const next = encodeProviderConfigFile({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  await writeFile(join(directory, "replacement.json"), JSON.stringify(next));
  await rename(join(directory, "replacement.json"), filePath);
  assert.equal((await repository.read()).providers.keys().length, 0);
  await rm(filePath);
  assert.equal((await repository.read()).providers.keys().length, 0);
  await writeFile(filePath, "broken JSON");
  assert.equal((await repository.read()).providers.keys().length, 0);
  await writeFile(filePath, JSON.stringify(encodeProviderConfigFile(update)));
  assert.equal((await repository.read()).providers.keys().length, 1);
});

test("a write invalidates an older in-flight read instead of returning it to post-write callers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-config-generation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "config.json");
  await writeFile(filePath, "old");
  const cache = new ProviderConfigSnapshotCache([filePath]);
  const snapshot = (revision: string) => ({
    revision,
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const old = cache.read(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return snapshot("old");
  });
  await started;
  await writeFile(filePath, "new");
  cache.clear();
  const current = await cache.read(async () => snapshot("new"));
  release();
  assert.equal((await old).revision, "old");
  assert.equal(current.revision, "new");
  assert.strictEqual(await cache.read(async () => snapshot("unexpected")), current);
});

test(
  "cached polling still notices external config and save-generation changes",
  { timeout: 5_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-config-poll-"));
    const filePath = join(directory, "providers.json");
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: 10,
    });
    t.after(async () => {
      repository.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const empty = encodeProviderConfigFile({
      providers: ProviderConfigMap.empty(),
      models: ModelConfigRules.empty(),
    });
    await writeFile(filePath, JSON.stringify(empty));
    await repository.read();
    const changed = (reason: string) =>
      new Promise<void>((resolve) => {
        const dispose = repository.onDidChange((event) => {
          if (event === reason) {
            dispose();
            resolve();
          }
        });
      });
    // 先等首次保存代次观察，之后的相同内容保存仍必须单独通知。
    await changed("save-generation");
    const configChanged = changed("poll-changed");
    const update = {
      providers: parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "external", config: { group: "standard-personal" } }],
      }),
      models: ModelConfigRules.empty(),
    };
    await writeFile(filePath, JSON.stringify(encodeProviderConfigFile(update)));
    await configChanged;
    assert.equal((await repository.read()).providers.keys().length, 1);
    const generationChanged = changed("save-generation");
    await writeFile(
      `${filePath}.runtime.json`,
      JSON.stringify({ schemaVersion: 1, saveGenerations: { external: "saved-again" } }),
    );
    await generationChanged;
    assert.equal((await repository.read()).saveGenerations?.external, "saved-again");
  },
);
