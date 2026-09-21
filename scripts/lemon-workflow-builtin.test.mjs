import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectSeaOfficialPluginAssets,
  seaOfficialPluginAssetPrefix,
} from "../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { resolveDynamicWorkflowClientConfig } from "../packages/shared/src/dynamic-workflow-feature.ts";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const pluginRoot = join(repoRoot, "apps/zcode-cli/packages/lemon-workflow-plugin");
const requiredPluginAssets = [
  ".zcode-plugin/plugin.json",
  "commands/lemon.md",
  "skills/ponytail/SKILL.md",
  "skills/caveman/SKILL.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
];

async function readRepoFile(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

test("lemon workflow plugin contains every runtime asset", async () => {
  for (const relativePath of requiredPluginAssets) {
    const asset = join(pluginRoot, ...relativePath.split("/"));
    assert.equal(
      (await stat(asset)).isFile(),
      true,
      `missing bundled plugin asset: ${relativePath}`,
    );
  }

  const manifest = JSON.parse(
    await readRepoFile("apps/zcode-cli/packages/lemon-workflow-plugin/.zcode-plugin/plugin.json"),
  );
  assert.equal(manifest.name, "lemon-workflow");
  assert.equal(manifest.commands, "commands");
  assert.equal(manifest.skills, "skills");
});

test("lemon command starts or resumes without the broken snippet preflight", async () => {
  const command = await readRepoFile(
    "apps/zcode-cli/packages/lemon-workflow-plugin/commands/lemon.md",
  );

  assert.match(command, /\u4e0d\u8981\u8c03\u7528 `EvalWorkflowSnippet`/u);
  assert.match(command, /CreateWorkflow/u);
  assert.match(command, /`script`/u);
  assert.match(command, /GetWorkflowRun|ListWorkflowRuns/u);
  assert.match(command, /ResumeWorkflowRun/u);
  assert.match(command, /status.*stopped/u);
  assert.match(command, /stopReason.*superseded/u);
  assert.doesNotMatch(command, /\u62a5\u544a\u4e3a `resumable`/u);
});

test("built desktop agent discovers /lemon and all three skills without user installation", async (t) => {
  const platform = `${process.platform}-${process.arch}`;
  const builtCli = join(repoRoot, "packages/desktop/bundled-agents", platform, "glm/zcode.cjs");
  try {
    await stat(builtCli);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("desktop CLI has not been built for this platform");
    return;
  }

  const tempHome = await mkdtemp(join(tmpdir(), "zcode-lemon-clean-home-"));
  try {
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      ZCODE_HOME: join(tempHome, ".zcode"),
    };
    const run = async (...args) => {
      const { stdout } = await exec(process.execPath, [builtCli, ...args], {
        cwd: repoRoot,
        env,
        maxBuffer: 8 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    };
    const command = await run("commands", "inspect", "lemon", "--json");
    assert.equal(command.command.metadata.source, "plugin");
    assert.match(command.command.metadata.path, /lemon-workflow/u);
    const result = await run("skills", "list", "--json");
    for (const name of ["ponytail", "caveman", "dynamic-workflows"]) {
      assert.ok(
        result.skills.some((skill) => skill.name === name && skill.pluginName === "lemon-workflow"),
      );
    }
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("dynamic workflow defaults on but remote can explicitly turn it off", () => {
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: undefined, env: {} }), {
    mode: "alwaysOn",
    enabled: true,
    source: "default",
  });
  assert.deepEqual(resolveDynamicWorkflowClientConfig({ remote: { mode: "disabled" }, env: {} }), {
    mode: "disabled",
    enabled: false,
    source: "remote",
  });
});

test("SEA embeds a complete lemon workflow content plugin", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-lemon-sea-"));
  try {
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      root: join(repoRoot, "apps/zcode-cli"),
      stagingDirectory,
    });
    const lemon = manifest.plugins.find((plugin) => plugin.name === "lemon-workflow");
    assert.equal(lemon?.version, "0.1.0");
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        lemon.files.some((file) => file.path === relativePath),
        true,
        `SEA manifest omits ${relativePath}`,
      );
      assert.ok(
        assets[
          `${seaOfficialPluginAssetPrefix}zcode-plugins-official/lemon-workflow/0.1.0/${relativePath}`
        ],
      );
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
});

test("desktop dev bundle stages the plugin beside the agent", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "zcode-lemon-desktop-"));
  try {
    const tempPluginRoot = join(tempRepoRoot, "apps/zcode-cli/packages/lemon-workflow-plugin");
    const tempBundle = join(tempRepoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
    await mkdir(dirname(tempBundle), { recursive: true });
    await writeFile(tempBundle, "// fixture bundle\n");
    await cp(pluginRoot, tempPluginRoot, { recursive: true });

    stageAgentBundle({ repoRoot: tempRepoRoot, platformKey: "win32-x64", log: () => {} });
    const stagedRoot = join(
      tempRepoRoot,
      "packages/desktop/bundled-agents/win32-x64/glm/packages/lemon-workflow-plugin",
    );
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        (await stat(join(stagedRoot, ...relativePath.split("/")))).isFile(),
        true,
        `desktop bundle omits ${relativePath}`,
      );
    }
  } finally {
    await rm(tempRepoRoot, { recursive: true, force: true });
  }
});

test("every official plugin distribution path stages lemon workflow", async () => {
  const sourceContracts = [
    "apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    "packages/shared/src/plugin-marketplaces.ts",
    "packages/desktop/scripts/stage-agent-bundle.mjs",
    "packages/desktop/scripts/prepare-agent-node-bundle.mjs",
    "apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs",
    "scripts/prepare-prebuilds.mjs",
    "packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts",
  ];

  for (const relativePath of sourceContracts) {
    const source = await readRepoFile(relativePath);
    assert.match(source, /lemon-workflow(?:-plugin)?/u, `${relativePath} omits lemon workflow`);
  }
});

test("third-party inventory tracks the two vendored MIT skills", async () => {
  const copiedComponents = JSON.parse(await readRepoFile("third-party/copied-components.json"));
  const ids = new Set(copiedComponents.map((component) => component.id));
  assert.equal(ids.has("Ponytail skill"), true);
  assert.equal(ids.has("Caveman skill"), true);
});
