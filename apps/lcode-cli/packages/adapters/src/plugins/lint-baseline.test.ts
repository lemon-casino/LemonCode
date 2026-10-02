import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginConfig, PluginDiagnostic } from "@lcode/contracts";
import { LCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@lcode/contracts";
import { LCODE_PLUGIN_ID_ENV_KEY } from "@lcode/shared";
import {
  addMarketplace,
  discoverNodePluginsSync,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadMarketplaceManifestSync,
  NodePluginAdapter,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
} from "./index.js";
import { resolvePluginMcpServers } from "./mcp.js";
import { resolveHttpZipSource, resolveZipPluginSource } from "./zip-source.js";
import type { LoadedPlugin } from "./types.js";

function pluginConfig(): PluginConfig {
  return {
    enabled: true,
    dirs: [],
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
  };
}

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lcode-plugin-lint-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

test("plugin discovery keeps official defaults, explicit overrides, stable ids and suppression", async () => {
  await withFixture(async (root) => {
    const storageRoot = join(root, "storage");
    const pluginRoot = join(root, "demo");
    await mkdir(join(pluginRoot, ".lcode-plugin"), { recursive: true });
    await writeJson(join(pluginRoot, ".lcode-plugin", "plugin.json"), {
      name: "demo",
      mcpServers: { helper: { command: "fixture-command" } },
    });
    const id = `demo@${LCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;
    const request = {
      config: pluginConfig(),
      officialPluginRoots: [pluginRoot],
      storageRoot,
      workingDirectory: root,
    };
    const disabled = discoverNodePluginsSync(request);
    assert.equal(disabled.plugins[0]?.id, id);
    assert.equal(disabled.plugins[0]?.enabled, false);
    assert.deepEqual(disabled.plugins[0]?.declaredMcpServerNames, ["helper"]);
    assert.deepEqual(disabled.mcpServers, {});
    const enabled = discoverNodePluginsSync({
      ...request,
      officialPluginsEnabledByDefault: new Set([id]),
    });
    assert.equal(enabled.plugins[0]?.enabled, true);
    assert.ok(enabled.mcpServers["plugin:demo:helper"]);
    request.config.enabledPlugins[id] = false;
    assert.equal(
      discoverNodePluginsSync({ ...request, officialPluginsEnabledByDefault: new Set([id]) })
        .plugins[0]?.enabled,
      false,
    );
    request.config.suppressedBuiltins.push(id);
    assert.deepEqual(discoverNodePluginsSync(request).plugins, []);
    assert.equal(NodePluginAdapter.prototype.discoverPlugins.length, 2);
    assert.equal(NodePluginAdapter.prototype.discoverPluginsSync.length, 2);
    assert.equal(discoverNodePluginsSync.length, 2);
  });
});

test("marketplace installs dependency-first using manifest version and rejects official id takeover", async () => {
  await withFixture(async (root) => {
    const storageRoot = join(root, "storage");
    const sourceRoot = join(root, "market");
    for (const name of ["first", "second"]) {
      await mkdir(join(sourceRoot, name, ".lcode-plugin"), { recursive: true });
      await writeJson(join(sourceRoot, name, ".lcode-plugin", "plugin.json"), {
        name,
        version: "2.3.4",
      });
    }
    await writeJson(join(sourceRoot, "marketplace.json"), {
      name: "fixture-market",
      plugins: [
        { name: "second", source: "./second", dependencies: ["first"] },
        { name: "first", source: "./first", version: "1.0.0" },
      ],
    });
    await addMarketplace({ source: { source: "directory", path: sourceRoot }, storageRoot });
    const installed = await installMarketplacePlugin({
      marketplace: "fixture-market",
      name: "second",
      storageRoot,
    });
    assert.deepEqual(installed.closure, ["first@fixture-market", "second@fixture-market"]);
    assert.deepEqual(
      installed.installed.map((entry) => entry.version),
      ["2.3.4", "2.3.4"],
    );
    assert.equal(
      installed.installed[0]?.installPath,
      join(storageRoot, "cache", "fixture-market", "first", "2.3.4"),
    );
    assert.equal(listInstalledPluginRecords(storageRoot).length, 2);
    const before = await readFile(
      join(storageRoot, "marketplaces", "fixture-market", "marketplace.json"),
      "utf8",
    );
    await writeJson(join(sourceRoot, "marketplace.json"), {
      name: LCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: [],
    });
    await assert.rejects(
      addMarketplace({ source: { source: "directory", path: sourceRoot }, storageRoot }),
      /reserved for the official marketplace/,
    );
    assert.equal(loadMarketplaceManifestSync(storageRoot, LCODE_OFFICIAL_PLUGIN_MARKETPLACE), null);
    assert.equal(
      await readFile(
        join(storageRoot, "marketplaces", "fixture-market", "marketplace.json"),
        "utf8",
      ),
      before,
    );
  });
});

test("source entrypoints preserve identity pin precedence and source parsing", async () => {
  assert.equal(readPluginSourceSha.length, 1);
  assert.equal(
    readPluginSourceIdentityPin({
      source: "url",
      type: "zip",
      url: "https://example.test/demo.zip",
      sha256: "a".repeat(64),
      sha: "old",
    }),
    "a".repeat(64),
  );
  assert.equal(readPluginSourceSha({ sha: "preferred", commit: "legacy" }), "preferred");
  assert.equal(readPluginSourceIdentityPin({ commit: "legacy" }), "legacy");
  assert.deepEqual(await parseMarketplaceSourceInput("fixture/plugins@release"), {
    source: "github",
    repo: "fixture/plugins",
    ref: "release",
  });
  assert.deepEqual(await parseMarketplaceSourceInput("https://example.test/plugins.git#release"), {
    source: "git",
    url: "https://example.test/plugins.git",
    ref: "release",
  });
});

test("MCP plugin resolver keeps authority-owned identity and secrets out of public fields", () => {
  const diagnostics: PluginDiagnostic[] = [];
  const loaded: LoadedPlugin = {
    id: "demo@fixture",
    marketplace: "fixture",
    rootPath: "/fixture/plugin",
    manifestPath: "/fixture/plugin/plugin.json",
    source: "inline",
    manifest: {
      name: "demo",
      userConfig: { token: { sensitive: true, default: "fixture-secret" } },
    },
  };
  const servers = resolvePluginMcpServers({
    dataPath: "/fixture/data",
    diagnostics,
    env: {},
    loaded,
    options: {},
    workingDirectory: "/fixture/workspace",
    definitions: {
      safe: {
        command: "fixture",
        env: { TOKEN: "${user_config.token}", [LCODE_PLUGIN_ID_ENV_KEY]: "forged@official" },
      },
      unsafe: { command: "fixture", args: ["${user_config.token}"] },
      reserved: {
        type: "http",
        url: "https://example.test/mcp",
        auth: { type: "lcode_official", provider: "jwt_token" },
        headers: { Authorization: "fixture-secret" },
      },
    },
  });
  const safe = servers["plugin:demo:safe"];
  assert.equal(safe?.type, "stdio");
  if (safe?.type !== "stdio") assert.fail("expected stdio fixture");
  assert.equal(safe.env?.TOKEN, "fixture-secret");
  assert.equal(safe.env?.[LCODE_PLUGIN_ID_ENV_KEY], loaded.id);
  assert.equal(servers["plugin:demo:unsafe"], undefined);
  assert.equal(servers["plugin:demo:reserved"], undefined);
  assert.equal(diagnostics.length, 2);
  assert.equal(JSON.stringify(diagnostics).includes("fixture-secret"), false);
});

test("zip source rejects unsafe paths, secret headers and insecure URLs before any download", async () => {
  const base = { url: "https://example.test/plugin.zip", sha256: "a".repeat(64) };
  for (const path of ["../escape", "/absolute", "C:/escape", "a\\b", "a/../b", "a\0b"]) {
    await assert.rejects(resolveZipPluginSource({ ...base, path }), /Unsafe plugin zip path/);
  }
  for (const header of ["Authorization", "cookie", "Proxy-Authorization", "Set-Cookie"]) {
    await assert.rejects(
      resolveHttpZipSource({ ...base, headers: { [header]: "fixture-secret" } }),
      /header is not allowed/,
    );
  }
  await assert.rejects(
    resolveZipPluginSource({ ...base, url: "http://example.test/plugin.zip" }),
    /must be HTTPS/,
  );
  await assert.rejects(resolveZipPluginSource({ ...base, sha256: "invalid" }), /64 character hex/);
});
