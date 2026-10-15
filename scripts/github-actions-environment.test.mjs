import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Copyright 2026 Lemon (zcode-full). SPDX-License-Identifier: Apache-2.0
// 修复依据：遗漏提交的材料必须在安装和原生构建前失败，不能由本机文件或安装副作用掩盖。
function assertSharedReleasePreflight(workflow) {
  const preflight = workflow.jobs["verify-inputs"];
  assert.ok(preflight, "release inputs require a shared preflight job");
  assert.equal(preflight["runs-on"], "ubuntu-24.04");
  assert.deepEqual(preflight.permissions, { contents: "read" });
  assert.equal(preflight.if, undefined, "preflight cannot be conditional");
  assert.equal(preflight["continue-on-error"], undefined);
  assert.equal(preflight.needs, undefined);
  assert.deepEqual(preflight.steps, [
    { uses: "actions/checkout@v7" },
    { uses: "actions/setup-node@v7", with: { "node-version": "24.21.0" } },
    { name: "Check release version", run: "node scripts/verify-release-version.mjs" },
    {
      name: "Verify committed release inputs",
      run: "node scripts/verify-release-inputs.mjs --source=HEAD",
    },
  ]);
  assert.equal(workflow.jobs["build-cua-linux-addon"].needs, "verify-inputs");
  assert.equal(workflow.jobs["remote-assets"].needs, "verify-inputs");
  assert.equal(workflow.jobs.build.needs, "build-cua-linux-addon");
  assert.deepEqual(workflow.jobs.release.needs, ["build", "remote-assets"]);
  function dependsOnPreflight(name, ancestors = new Set()) {
    if (name === "verify-inputs") return true;
    assert.ok(workflow.jobs[name], `unknown release dependency: ${name}`);
    assert.ok(!ancestors.has(name), `cyclic release dependency: ${name}`);
    const needs = workflow.jobs[name].needs;
    const dependencies = needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
    return dependencies.some((dependency) =>
      dependsOnPreflight(dependency, new Set([...ancestors, name])),
    );
  }
  // 默认 needs 失败传播负责准入；always() / continue-on-error 会绕过公共门禁。
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.ok(dependsOnPreflight(name), `${name} must depend on successful preflight`);
    assert.equal(job["continue-on-error"], undefined, `${name} must propagate failure`);
    if (name !== "release") assert.equal(job.if, undefined, `${name} must wait for needs`);
    for (const step of job.steps) {
      assert.equal(step["continue-on-error"], undefined, `${name} step must propagate failure`);
    }
  }
  assert.equal(workflow.jobs.release.if, "github.ref_type == 'tag'");
}

test("shared release preflight validates HEAD before all costly jobs without package installation", async () => {
  const workflow = YAML.parse(
    await readFile(joinRoot(".github/workflows/desktop-release.yml"), "utf8"),
  );
  assertSharedReleasePreflight(workflow);
});

test("release preflight contract rejects dependency bypasses and install-dependent checks", async () => {
  const original = YAML.parse(
    await readFile(joinRoot(".github/workflows/desktop-release.yml"), "utf8"),
  );
  assertSharedReleasePreflight(original);
  const mutations = [
    (workflow) => delete workflow.jobs["verify-inputs"],
    (workflow) => delete workflow.jobs["build-cua-linux-addon"].needs,
    (workflow) => delete workflow.jobs["remote-assets"].needs,
    (workflow) => (workflow.jobs.build.needs = "verify-inputs"),
    (workflow) => (workflow.jobs.release.needs = ["build"]),
    (workflow) => (workflow.jobs["unprotected-build"] = { steps: [{ run: "npm install" }] }),
    (workflow) => (workflow.jobs["verify-inputs"].if = "always()"),
    (workflow) => (workflow.jobs["remote-assets"].if = "always()"),
    (workflow) => (workflow.jobs.release.if = "always() && github.ref_type == 'tag'"),
    (workflow) => (workflow.jobs["verify-inputs"]["continue-on-error"] = true),
    (workflow) => (workflow.jobs["verify-inputs"].steps[3]["continue-on-error"] = true),
    (workflow) => (workflow.jobs["verify-inputs"].steps[1].with.cache = "pnpm"),
    (workflow) => workflow.jobs["verify-inputs"].steps.splice(2, 0, { run: "pnpm install" }),
    (workflow) =>
      (workflow.jobs["verify-inputs"].steps[3].run = "node scripts/verify-release-inputs.mjs"),
    (workflow) => workflow.jobs["verify-inputs"].steps.reverse(),
  ];
  for (const mutate of mutations) {
    const workflow = structuredClone(original);
    mutate(workflow);
    assert.throws(() => assertSharedReleasePreflight(workflow));
  }
});

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
    "pnpm test:remote-control",
    "pnpm test:remote-providers",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm --dir apps/lcode-cli typecheck",
    "pnpm --dir apps/lcode-cli lint",
    "pnpm architecture:check",
  ]) {
    assert.ok(commands.includes(command), `Missing release check: ${command}`);
  }
});
