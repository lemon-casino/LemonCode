import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigKey, ConfigScope } from "@lcode/contracts";
import {
  addSuppressedBuiltinInFileConfig,
  ConfigPortImpl,
  createConfigPort,
  createPrioritizedConfig,
  enablePluginsByDefaultInFileConfig,
  loadFileConfig,
  mergeConfigs,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
  updateUiLocaleInFileConfig,
} from "./index.js";
import { CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID } from "./schema.js";

test("configuration store preserves owner notifications, scope and precedence", () => {
  const config = new ConfigPortImpl();
  const seen: unknown[] = [];
  const unsubscribe = config.observe().subscribe(ConfigKey.UiLocale, (value, previous) => {
    seen.push([value, previous]);
  });
  config.set(ConfigKey.UiLocale, "zh-CN");
  assert.deepEqual(seen, [["zh-CN", "en-US"]]);
  assert.equal(config.getSources(ConfigKey.UiLocale)[0]?.scope, ConfigScope.Session);
  unsubscribe();
  config.set(ConfigKey.UiLocale, "en-US");
  assert.equal(seen.length, 1);
  assert.equal(config.getAll().ui.locale, "en-US");
  assert.equal(createConfigPort.length, 1);
  assert.equal(ConfigPortImpl.length, 1);
  assert.equal(loadFileConfig.length, 1);
  assert.equal(updatePluginOptionsInFileConfig.length, 3);

  const merged = mergeConfigs(
    createPrioritizedConfig(
      {
        plugins: {
          dirs: ["user"],
          enabledPlugins: { example: true },
          options: { example: { retained: true } },
        },
      },
      ConfigScope.User,
    ),
    createPrioritizedConfig(
      { plugins: { dirs: ["project"], options: { example: { newOption: 1 } } } },
      ConfigScope.Project,
    ),
  );
  assert.deepEqual(merged.plugins?.dirs, ["user", "project"]);
  assert.deepEqual(merged.plugins?.enabledPlugins, { example: true });
  assert.deepEqual(merged.plugins?.options, { example: { retained: true, newOption: 1 } });
});

test("file configuration preserves legacy migration, unrelated fields and option-level patches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-file-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      custom: { retained: true },
      ui: { theme: "dark" },
      plugins: {
        enabledPlugins: { [LEGACY_CUA_PLUGIN_ID]: false },
        options: { [LEGACY_CUA_PLUGIN_ID]: { retained: "fixture-value", clear: true } },
        suppressedBuiltins: [LEGACY_CUA_PLUGIN_ID],
      },
    }),
  );
  const loaded = loadFileConfig(path);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.config.plugins?.enabledPlugins?.[CANONICAL_CUA_PLUGIN_ID], false);
  let persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(LEGACY_CUA_PLUGIN_ID in persisted.plugins.enabledPlugins, false);
  assert.equal(persisted.plugins.options[CANONICAL_CUA_PLUGIN_ID].retained, "fixture-value");
  await updateUiLocaleInFileConfig(path, "zh-CN");
  await updatePluginOptionsInFileConfig(path, LEGACY_CUA_PLUGIN_ID, { newOption: 2 }, ["clear"]);
  await updatePluginEnabledInFileConfig(path, LEGACY_CUA_PLUGIN_ID, true);
  const enabled = await enablePluginsByDefaultInFileConfig(path, [
    CANONICAL_CUA_PLUGIN_ID,
    "new-plugin",
  ]);
  assert.deepEqual(enabled.enabledIds, ["new-plugin"]);
  await removePluginEnabledFromFileConfig(path, LEGACY_CUA_PLUGIN_ID);
  persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.ui, { theme: "dark", locale: "zh-CN" });
  assert.deepEqual(persisted.custom, { retained: true });
  assert.deepEqual(persisted.plugins.options[CANONICAL_CUA_PLUGIN_ID], {
    retained: "fixture-value",
    newOption: 2,
  });
  assert.equal(CANONICAL_CUA_PLUGIN_ID in persisted.plugins.enabledPlugins, false);
  await addSuppressedBuiltinInFileConfig(path, LEGACY_CUA_PLUGIN_ID);
  await removeSuppressedBuiltinInFileConfig(path, LEGACY_CUA_PLUGIN_ID);
  const removed = await removePluginFromFileConfig(path, LEGACY_CUA_PLUGIN_ID);
  assert.equal(removed.removedOptions, true);
  persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(persisted.plugins.suppressedBuiltins, []);
  assert.equal(CANONICAL_CUA_PLUGIN_ID in persisted.plugins.options, false);
  assert.ok((await readFile(path, "utf8")).endsWith("\n"));
});
