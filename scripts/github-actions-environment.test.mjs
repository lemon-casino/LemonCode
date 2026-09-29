import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

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
  assert.equal(releaseSteps[pnpmSetupIndex].with.version, "10.33.2");
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
