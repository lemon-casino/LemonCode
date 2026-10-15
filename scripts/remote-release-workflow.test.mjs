import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");

test("tag releases build and verify remote runtimes before publishing desktop installers", async () => {
  const workflow = YAML.parse(
    await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8"),
  );
  const job = workflow.jobs["remote-assets"];
  assert.ok(job, "remote assets must have an independent job");
  assert.equal(job.needs, "verify-inputs");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.env.LCODE_ENV, "production");
  assert.equal(job.env.LCODE_VERIFY_RELEASE_INPUTS, "1");
  const steps = job.steps;
  assert.equal(
    steps.some((step) => step.name === "Verify committed release notice baseline"),
    false,
    "the shared preflight must finish before remote dependency installation",
  );
  const install = steps.findIndex((step) => step.name === "Install dependencies");
  const restore = steps.findIndex(
    (step) => step.name === "Restore committed release input after install",
  );
  const tests = steps.findIndex((step) => step.name === "Verify remote resource distribution");
  const build = steps.findIndex((step) => step.name === "Build and stage remote runtimes");
  const upload = steps.findIndex((step) => step.uses === "actions/upload-artifact@v7");
  assert.ok(install >= 0 && tests > install && build > tests && upload > build);
  assert.ok(install < restore && restore < tests);
  assert.match(steps[restore].run, /git diff -- pnpm-lock\.yaml/u);
  assert.match(steps[restore].run, /git restore --source=HEAD -- pnpm-lock\.yaml/u);
  assert.equal(steps[tests].run, "pnpm test:remote-assets");
  assert.equal(steps[build].run, "pnpm build:remote-release");
  assert.equal(steps[upload].with.name, "remote-runtime-assets");
  assert.equal(steps[upload].with.path, "packages/desktop/dist/remote-release-assets/*");
  assert.equal(steps[upload].with["if-no-files-found"], "error");
  const downloads = workflow.jobs.release.steps.filter(
    (step) => step.uses === "actions/download-artifact@v8",
  );
  assert.ok(
    downloads.some(
      (step) => step.with.name === "remote-runtime-assets" && step.with.path === "release-assets",
    ),
  );
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(
    rootPackage.scripts["build:remote-release"],
    "pnpm prepare:remote-assets && pnpm stage:remote-release",
  );
  const stageSource = await readFile(join(root, "scripts/stage-release-artifacts.mjs"), "utf8");
  assert.match(
    stageSource,
    /directory: resolve\(repoRoot, "release-assets"\),\s+remoteAssets: true/u,
  );
});
