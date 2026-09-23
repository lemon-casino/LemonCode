import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveOfficialPluginRoots } from "../apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  resolveOfficialPluginHostMcpServerNames,
} from "../apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts";
import {
  getZCodePluginsOverview,
  resolveZCodePlugins,
  restoreBuiltinPlugin,
} from "../apps/zcode-cli/packages/bootstrap/src/plugins.ts";
import {
  collectSeaOfficialPluginAssets,
  seaOfficialPluginAssetPrefix,
} from "../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "apps/zcode-cli/packages/zcode-cua-plugin");
const computerUsePluginId = "computer-use@zcode-plugins-official";
const requiredPluginAssets = [
  ".zcode-plugin/plugin.json",
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
];

async function readRepoFile(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

test("computer-use is a repository-owned content plugin with the public identity", async () => {
  for (const relativePath of requiredPluginAssets) {
    assert.equal(
      (await stat(join(pluginRoot, ...relativePath.split("/")))).isFile(),
      true,
      `missing bundled plugin asset: ${relativePath}`,
    );
  }

  const manifest = JSON.parse(
    await readRepoFile("apps/zcode-cli/packages/zcode-cua-plugin/.zcode-plugin/plugin.json"),
  );
  assert.equal(manifest.name, "computer-use");
  assert.equal(manifest.version, "0.6.3");
  assert.equal(manifest.skills, "skills");

  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(({ name }) => name === "computer-use");
  assert.ok(definition);
  assert.equal(`${definition.name}@zcode-plugins-official`, "computer-use@zcode-plugins-official");
  assert.equal(definition.version, manifest.version);
  assert.deepEqual(definition.requiredSeedPaths, requiredPluginAssets.slice(1));
  assert.deepEqual(resolveOfficialPluginHostMcpServerNames("computer-use@zcode-plugins-official"), [
    "node_repl",
  ]);
});

test("computer-use SDK uses only the injected node_repl bridge and fails closed without it", async () => {
  const clientUrl = pathToFileURL(join(pluginRoot, "scripts/computer-use-client.mjs")).href;
  const { setupComputerUseRuntime } = await import(`${clientUrl}?test=${Date.now()}`);
  await assert.rejects(
    setupComputerUseRuntime({ globals: {} }),
    /Computer Use runtime bridge is unavailable/u,
  );

  const calls = [];
  const globals = {
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: {
      assertAvailable() {},
      async call(method, input) {
        calls.push({ input, method });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
      documentationRoot: join(pluginRoot, "docs"),
    },
  };
  const computerUse = await setupComputerUseRuntime({ globals });
  assert.equal(globals.agent.computerUse, computerUse);
  assert.equal(
    computerUse.computer.target,
    process.platform === "win32" ? "windows" : process.platform,
  );
  assert.deepEqual(await computerUse.computer.list_apps({ include_hidden: true }), { ok: true });
  assert.deepEqual(calls, [{ input: { include_hidden: true }, method: "list_apps" }]);
  assert.match(await globals.agent.documentation.get("computer-use"), /Computer Use/u);
});

test("bootstrap resolver seeds computer-use from the repository instead of a pre-existing cache", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-cua-resolver-"));
  try {
    resolveOfficialPluginRoots({ env: {}, storageRoot });
    const seededRoot = join(storageRoot, "cache/zcode-plugins-official/computer-use/0.6.3");
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        (await stat(join(seededRoot, ...relativePath.split("/")))).isFile(),
        true,
        `resolver did not seed ${relativePath}`,
      );
    }
    const marker = JSON.parse(await readFile(join(seededRoot, ".zcode-plugin-seed.json"), "utf8"));
    assert.equal(marker.source, "filesystem");
    assert.equal(marker.plugin, "computer-use");
    assert.equal(marker.pluginVersion, "0.6.3");
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("computer-use stays discoverable and only explicit plugin config enables it", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-cua-config-"));
  const userConfigPath = join(storageRoot, "config.json");
  const pluginStorageRoot = join(storageRoot, "plugins");
  const resolvePlugins = () =>
    resolveZCodePlugins({
      env: {},
      pluginStorageRoot,
      userConfigPath,
      workingDirectory: storageRoot,
    });

  try {
    await writeFile(userConfigPath, JSON.stringify({ plugins: { enabledPlugins: {} } }));
    const disabled = resolvePlugins().plugins.find(({ id }) => id === computerUsePluginId);
    assert.ok(disabled, "computer-use must remain discoverable while default-disabled");
    assert.equal(disabled.enabled, false);

    await writeFile(
      userConfigPath,
      JSON.stringify({
        plugins: { enabledPlugins: { [computerUsePluginId]: true } },
      }),
    );
    const enabled = resolvePlugins().plugins.find(({ id }) => id === computerUsePluginId);
    assert.ok(enabled);
    assert.equal(enabled.enabled, true);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("computer-use remains restorable without an internal environment bypass", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-cua-restorable-"));
  const userConfigPath = join(storageRoot, "config.json");
  try {
    await writeFile(
      userConfigPath,
      JSON.stringify({ plugins: { suppressedBuiltins: [computerUsePluginId] } }),
    );
    const overview = getZCodePluginsOverview({
      env: {},
      pluginStorageRoot: join(storageRoot, "plugins"),
      userConfigPath,
      workingDirectory: storageRoot,
    });
    assert.equal(
      overview.restorableBuiltins.some(({ id }) => id === computerUsePluginId),
      true,
    );
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("computer-use restore mutation does not require an internal environment bypass", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-cua-restore-"));
  const userConfigPath = join(storageRoot, "config.json");
  try {
    await writeFile(
      userConfigPath,
      JSON.stringify({ plugins: { suppressedBuiltins: [computerUsePluginId] } }),
    );
    await restoreBuiltinPlugin({
      env: {},
      pluginId: computerUsePluginId,
      pluginStorageRoot: join(storageRoot, "plugins"),
      userConfigPath,
      workingDirectory: storageRoot,
    });
    const config = JSON.parse(await readFile(userConfigPath, "utf8"));
    assert.equal(config.plugins.suppressedBuiltins.includes(computerUsePluginId), false);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

test("SEA embeds every computer-use seed asset in its hashed manifest", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-cua-sea-"));
  try {
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      root: join(repoRoot, "apps/zcode-cli"),
      stagingDirectory,
    });
    const computerUse = manifest.plugins.find((plugin) => plugin.name === "computer-use");
    assert.equal(computerUse?.version, "0.6.3");
    assert.match(manifest.hash, /^[a-f0-9]{64}$/u);
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        computerUse.files.some(
          (file) => file.path === relativePath && /^[a-f0-9]{64}$/u.test(file.sha256),
        ),
        true,
        `SEA manifest omits ${relativePath}`,
      );
      assert.ok(
        assets[
          `${seaOfficialPluginAssetPrefix}zcode-plugins-official/computer-use/0.6.3/${relativePath}`
        ],
      );
    }
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
});

test("clean desktop staging carries computer-use beside node_repl consumers", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "zcode-cua-desktop-"));
  try {
    const tempBundle = join(tempRepoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
    await mkdir(dirname(tempBundle), { recursive: true });
    await writeFile(tempBundle, "// fixture bundle\n");
    await cp(
      join(repoRoot, "apps/zcode-cli/packages/lemon-workflow-plugin"),
      join(tempRepoRoot, "apps/zcode-cli/packages/lemon-workflow-plugin"),
      { recursive: true },
    );
    await cp(pluginRoot, join(tempRepoRoot, "apps/zcode-cli/packages/zcode-cua-plugin"), {
      recursive: true,
    });

    stageAgentBundle({ repoRoot: tempRepoRoot, platformKey: "win32-x64", log: () => {} });
    const stagedRoot = join(
      tempRepoRoot,
      "packages/desktop/bundled-agents/win32-x64/glm/packages/zcode-cua-plugin",
    );
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        (await stat(join(stagedRoot, ...relativePath.split("/")))).isFile(),
        true,
        `desktop bundle omits ${relativePath}`,
      );
    }
  } finally {
    await rm(tempRepoRoot, { force: true, recursive: true });
  }
});

test("production staging and SEA list the repository-owned computer-use package", async () => {
  for (const relativePath of [
    "packages/desktop/scripts/prepare-agent-node-bundle.mjs",
    "apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs",
  ]) {
    const source = await readRepoFile(relativePath);
    assert.match(
      source,
      /apps\/zcode-cli\/packages\/zcode-cua-plugin|packages["', ]+zcode-cua-plugin/u,
    );
    assert.doesNotMatch(source, /plugins\/cache.*computer-use|private producer/iu);
  }
});
