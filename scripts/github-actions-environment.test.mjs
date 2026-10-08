import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("tag build toolchain matches mise, root package and CLI engines", async () => {
  const [mise, rootManifest, cliManifest, workflowSource] = await Promise.all([
    readFile(joinRoot("mise.toml"), "utf8"),
    readFile(joinRoot("package.json"), "utf8"),
    readFile(joinRoot("apps/lcode-cli/package.json"), "utf8"),
    readFile(joinRoot(".github/workflows/desktop-release.yml"), "utf8"),
  ]);
  const nodeVersion = mise.match(/^node\s*=\s*"([^"]+)"/m)?.[1];
  const pnpmVersion = mise.match(/^pnpm\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(nodeVersion);
  assert.ok(pnpmVersion);
  assert.equal(JSON.parse(rootManifest).packageManager, `pnpm@${pnpmVersion}`);
  assert.equal(JSON.parse(cliManifest).packageManager, `pnpm@${pnpmVersion}`);
  assert.equal(JSON.parse(cliManifest).engines.node, nodeVersion);
  for (const job of Object.values(YAML.parse(workflowSource).jobs)) {
    for (const step of job.steps ?? []) {
      // 工具升级后旧 CI pin 会让 tag 构建使用不同运行时；所有 matrix/release job 都要核对。
      if (step.uses?.startsWith("actions/setup-node@"))
        assert.equal(step.with["node-version"], nodeVersion);
      if (step.uses?.startsWith("pnpm/action-setup@")) assert.equal(step.with.version, pnpmVersion);
    }
  }
});

test("Actions uses Node 24 runtimes and prepares the isolated release job", async () => {
  const workflow = YAML.parse(
    await readFile(joinRoot(".github/workflows/desktop-release.yml"), "utf8"),
  );
  const requiredNode24Actions = new Map([
    ["actions/checkout", "actions/checkout@v7"],
    ["actions/setup-node", "actions/setup-node@v7"],
    ["actions/upload-artifact", "actions/upload-artifact@v7"],
    ["actions/download-artifact", "actions/download-artifact@v8"],
    ["pnpm/action-setup", "pnpm/action-setup@v6"],
  ]);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      const action = step.uses.split("@")[0];
      const expected = requiredNode24Actions.get(action);
      if (expected) assert.equal(step.uses, expected);
    }
  }

  const winArm64 = workflow.jobs.build.strategy.matrix.include.find(
    ({ os, arch }) => os === "win" && arch === "arm64",
  );
  assert.equal(winArm64.runner, "windows-11-vs2026-arm");

  const releaseSteps = workflow.jobs.release.steps;
  const pnpmSetupIndex = releaseSteps.findIndex((step) => step.uses === "pnpm/action-setup@v6");
  const nodeSetupIndex = releaseSteps.findIndex((step) => step.uses === "actions/setup-node@v7");
  const installIndex = releaseSteps.findIndex(
    (step) => step.name === "Install release verification dependencies",
  );
  const verifyIndex = releaseSteps.findIndex(
    (step) => step.name === "Verify all six platform packages",
  );
  assert.equal(releaseSteps[pnpmSetupIndex].with.version, "10.34.6");
  assert.equal(releaseSteps[pnpmSetupIndex].with.run_install, false);
  assert.equal(releaseSteps[nodeSetupIndex].with.cache, "pnpm");
  assert.equal(releaseSteps[installIndex].run, "pnpm install --frozen-lockfile --ignore-scripts");
  assert.ok(pnpmSetupIndex < nodeSetupIndex);
  assert.ok(nodeSetupIndex < installIndex);
  assert.ok(installIndex < verifyIndex);
});

function joinRoot(path) {
  return resolve(root, path);
}

test("root typecheck includes the strict Main leaf without emitting runtime bundles", async () => {
  const manifest = JSON.parse(await readFile(joinRoot("package.json"), "utf8"));
  assert.ok(
    manifest.scripts.typecheck.split(/\s+/u).includes("packages/desktop/tsconfig.main.json"),
  );
  const path = joinRoot("packages/desktop/tsconfig.main.json");
  const raw = ts.parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, joinRoot("packages/desktop"));
  assert.equal(config.options.noEmit, true);
  assert.equal(config.options.noUncheckedIndexedAccess, true);
  assert.ok(!config.options.lib.includes("lib.dom.d.ts"));
  const runtimePath = joinRoot("packages/desktop/tsconfig.browser-runtime.json");
  const runtimeRaw = ts.parseConfigFileTextToJson(runtimePath, await readFile(runtimePath, "utf8"));
  const runtime = ts.parseJsonConfigFileContent(
    runtimeRaw.config,
    ts.sys,
    joinRoot("packages/desktop"),
  );
  assert.ok(runtime.options.lib.includes("lib.dom.d.ts"));
  assert.equal(runtime.options.emitDeclarationOnly, true);
  for (const source of ["src/shared/armsRumShared.ts", "src/scheduler/schedulerProtocol.ts"]) {
    assert.ok(
      config.fileNames
        .map((file) => file.replaceAll("\\", "/"))
        .includes(joinRoot(`packages/desktop/${source}`).replaceAll("\\", "/")),
    );
  }
});

test("CLI task entrypoints resolve Turbo from the root hoisted installation", async () => {
  const cli = JSON.parse(await readFile(joinRoot("apps/lcode-cli/package.json"), "utf8"));
  // 嵌套工作区的 pnpm run 不保证继承根 .bin；不能让本地 PATH 或手动链接掩盖 CI 缺失入口。
  for (const task of ["build", "clean", "lint", "lint:fix", "typecheck"]) {
    assert.equal(
      cli.scripts[task],
      `pnpm --dir ../.. exec turbo --skip-infer --cwd apps/lcode-cli run ${task}`,
    );
  }
  assert.equal(cli.scripts.check, "pnpm registry:check && pnpm typecheck");
});

test("CLI trajectory tool checks its source despite the root CLI exclusion", async () => {
  const tool = JSON.parse(
    await readFile(joinRoot("apps/lcode-cli/tools/prompt-trajectory/package.json"), "utf8"),
  );
  assert.equal(
    tool.scripts.lint,
    "oxlint --config ../../oxlint.config.json src scripts --no-ignore",
  );
});

test("tag build checks dependency patches and both source workspaces before packaging", async () => {
  const workflow = YAML.parse(
    await readFile(joinRoot(".github/workflows/desktop-release.yml"), "utf8"),
  );
  const steps = workflow.jobs.build.steps;
  const checksIndex = steps.findIndex(
    (step) => step.name === "Verify dependency security and source checks",
  );
  const packageIndex = steps.findIndex(
    (step) => step.name === "Package and verify desktop app identity",
  );
  assert.ok(checksIndex >= 0 && checksIndex < packageIndex);
  assert.equal(steps[checksIndex].if, "matrix.os == 'linux' && matrix.arch == 'x64'");
  const commands = steps[checksIndex].run.trim().split(/\r?\n/u);
  for (const command of [
    "pnpm test:dependency-security",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm --dir apps/lcode-cli typecheck",
    "pnpm --dir apps/lcode-cli lint",
    "pnpm architecture:check",
  ]) {
    assert.ok(commands.includes(command), `Missing release check: ${command}`);
  }
});
