import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";
import { expandCliCustomCommandPrompt } from "../apps/lcode-cli/packages/cli/src/custom-command-expand.ts";
import {
  collectSeaOfficialPluginAssets,
  seaOfficialPluginAssetPrefix,
} from "../apps/lcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs";
import { resolveDynamicWorkflowClientConfig } from "../packages/shared/src/dynamic-workflow-feature.ts";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const pluginRoot = join(repoRoot, "apps/lcode-cli/packages/lemon-workflow-plugin");
const requiredPluginAssets = [
  ".lcode-plugin/plugin.json",
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
    await readRepoFile("apps/lcode-cli/packages/lemon-workflow-plugin/.lcode-plugin/plugin.json"),
  );
  assert.equal(manifest.name, "lemon-workflow");
  assert.equal(manifest.commands, "commands");
  assert.equal(manifest.skills, "skills");
});

test("lemon command starts or resumes without the broken snippet preflight", async () => {
  const command = await readRepoFile(
    "apps/lcode-cli/packages/lemon-workflow-plugin/commands/lemon.md",
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

test("lemon loads qualified skills and selects a review scope with actual changes", async () => {
  const source = await readRepoFile(
    "apps/lcode-cli/packages/lemon-workflow-plugin/commands/lemon.md",
  );
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
  assert.ok(frontmatter);
  const metadata = YAML.parse(frontmatter[1]);
  const skills = metadata.skills.split(",").map((name) => name.trim());
  assert.deepEqual(skills, [
    "lemon-workflow:dynamic-workflows",
    "lemon-workflow:ponytail",
    "lemon-workflow:caveman",
  ]);
  const { prompt } = expandCliCustomCommandPrompt({
    args: "用动态工作流审查当前改动",
    command: {
      content: source.slice(frontmatter[0].length),
      metadata: { name: "lemon", scope: "plugin", source: "lemon-workflow", skills },
    },
  });
  assert.match(prompt, /Required skills: `lemon-workflow:dynamic-workflows`/u);
  assert.doesNotMatch(prompt, /Required skills: `lemon`/u);
  assert.match(prompt, /`lemon` 不是技能/u);
  assert.match(prompt, /git\.changedFiles\(\)/u);
  assert.match(prompt, /git\.log\(2\)/u);
  assert.match(prompt, /git\.changedFiles\("HEAD\^"\)/u);
  assert.match(prompt, /git\.diff\("HEAD\^", path\)/u);
  assert.match(prompt, /明确指定.*不.*回退/u);
  assert.match(prompt, /无.*差异.*不.*审查/u);
});

test("lemon applies Ponytail to engineering actors and Caveman only to user-facing summaries", async () => {
  const command = await readRepoFile(
    "apps/lcode-cli/packages/lemon-workflow-plugin/commands/lemon.md",
  );

  assert.match(command, /规划、编码、重构或代码审查 actor/u);
  assert.match(command, /精简 Ponytail persona/u);
  assert.match(command, /先理解.*完整.*路径.*复用.*最小正确实现/su);
  assert.match(command, /不要为 Ponytail 单独创建 actor/u);
  assert.match(command, /Caveman.*`log\(\)`.*最终短摘要/su);
  assert.match(command, /typed result.*证据.*精确错误.*安全警告.*artifact.*保持完整/su);
  assert.match(command, /用户要求详细报告.*正常完整表达/su);
  assert.match(command, /不要为 Caveman 单独创建 actor/u);
  assert.match(command, /不要.*Caveman proxy.*engine.*rewriter.*生命周期 hook/su);
});

test("built desktop agent discovers /lemon and all three skills without user installation", async (t) => {
  const platform = `${process.platform}-${process.arch}`;
  const builtCli = join(repoRoot, "packages/desktop/bundled-agents", platform, "glm/lcode.cjs");
  try {
    await stat(builtCli);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("desktop CLI has not been built for this platform");
    return;
  }

  const tempHome = await mkdtemp(join(tmpdir(), "lcode-lemon-clean-home-"));
  try {
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      LCODE_HOME: join(tempHome, ".lcode"),
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
    assert.deepEqual(command.command.metadata.skills, [
      "lemon-workflow:dynamic-workflows",
      "lemon-workflow:ponytail",
      "lemon-workflow:caveman",
    ]);
    assert.match(command.command.content, /git\.changedFiles\("HEAD\^"\)/u);
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
  const stagingDirectory = await mkdtemp(join(tmpdir(), "lcode-lemon-sea-"));
  try {
    const { assets, manifest } = await collectSeaOfficialPluginAssets({
      root: join(repoRoot, "apps/lcode-cli"),
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
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "lcode-lemon-desktop-"));
  try {
    const tempPluginRoot = join(tempRepoRoot, "apps/lcode-cli/packages/lemon-workflow-plugin");
    const tempBundle = join(tempRepoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
    await mkdir(dirname(tempBundle), { recursive: true });
    await writeFile(tempBundle, "// fixture bundle\n");
    await cp(pluginRoot, tempPluginRoot, { recursive: true });
    // 完整 staging 同时需要自研 Computer Use；夹具不能只准备 lemon 或依赖用户缓存。
    await cp(
      join(repoRoot, "apps/lcode-cli/packages/lcode-cua-plugin"),
      join(tempRepoRoot, "apps/lcode-cli/packages/lcode-cua-plugin"),
      { recursive: true },
    );

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
    for (const relativePath of requiredPluginAssets) {
      assert.deepEqual(
        await readFile(join(stagedRoot, relativePath)),
        await readFile(join(pluginRoot, relativePath)),
        `desktop bundle changes ${relativePath}`,
      );
    }
    const cuaManifest = JSON.parse(
      await readFile(
        join(
          tempRepoRoot,
          "packages/desktop/bundled-agents/win32-x64/glm/packages/lcode-cua-plugin/.lcode-plugin/plugin.json",
        ),
        "utf8",
      ),
    );
    assert.equal(cuaManifest.name, "computer-use");
    assert.deepEqual(cuaManifest.author, { name: "Lemon" });
  } finally {
    await rm(tempRepoRoot, { recursive: true, force: true });
  }
});

test("every official plugin distribution path stages lemon workflow", async () => {
  const sourceContracts = [
    "apps/lcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts",
    "packages/shared/src/plugin-marketplaces.ts",
    "packages/desktop/scripts/stage-agent-bundle.mjs",
    "packages/desktop/scripts/prepare-agent-node-bundle.mjs",
    "apps/lcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs",
    "scripts/prepare-prebuilds.mjs",
    "packages/server/src/remote/lcodeAgentOfficialPluginAssets.ts",
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
