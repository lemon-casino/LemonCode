import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "apps/lcode-cli/packages/lcode-cua-plugin");
const requiredPluginAssets = [
  ".lcode-plugin/plugin.json",
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
];

async function prepareDesktopStagingFixture(tempRepoRoot) {
  const tempBundle = join(tempRepoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
  await mkdir(dirname(tempBundle), { recursive: true });
  await writeFile(tempBundle, "// fixture bundle\n");
  // 完整 staging 的输入来自同一仓库，不借用用户 cache 或空 manifest 补齐自研插件。
  for (const packageName of ["lemon-workflow-plugin", "lcode-cua-plugin"]) {
    await cp(
      join(repoRoot, "apps/lcode-cli/packages", packageName),
      join(tempRepoRoot, "apps/lcode-cli/packages", packageName),
      { recursive: true },
    );
  }
}

test("clean desktop staging carries computer-use beside node_repl consumers", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "lcode-cua-desktop-"));
  try {
    await prepareDesktopStagingFixture(tempRepoRoot);
    stageAgentBundle({ repoRoot: tempRepoRoot, platformKey: "win32-x64", log: () => {} });
    const stagedRoot = join(
      tempRepoRoot,
      "packages/desktop/bundled-agents/win32-x64/glm/packages/lcode-cua-plugin",
    );
    for (const relativePath of requiredPluginAssets) {
      assert.equal(
        (await stat(join(stagedRoot, ...relativePath.split("/")))).isFile(),
        true,
        `desktop bundle omits ${relativePath}`,
      );
      assert.deepEqual(
        await readFile(join(stagedRoot, relativePath)),
        await readFile(join(pluginRoot, relativePath)),
        `desktop bundle changes ${relativePath}`,
      );
    }
  } finally {
    await rm(tempRepoRoot, { force: true, recursive: true });
  }
});

for (const relativePath of requiredPluginAssets) {
  test(`desktop staging rejects missing computer-use asset: ${relativePath}`, async () => {
    const tempRepoRoot = await mkdtemp(join(tmpdir(), "lcode-cua-missing-"));
    try {
      await prepareDesktopStagingFixture(tempRepoRoot);
      const missingPath = join(
        tempRepoRoot,
        "apps/lcode-cli/packages/lcode-cua-plugin",
        relativePath,
      );
      await rm(missingPath);
      assert.throws(
        () => stageAgentBundle({ repoRoot: tempRepoRoot, platformKey: "win32-x64", log: () => {} }),
        { message: `[stage:agent-bundle] missing official plugin asset: ${missingPath}` },
      );
    } finally {
      await rm(tempRepoRoot, { force: true, recursive: true });
    }
  });
}
