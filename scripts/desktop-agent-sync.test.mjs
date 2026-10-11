import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import * as build from "./build-desktop-agent-cli.mjs";

const root = new URL("../", import.meta.url);

test("local Agent inputs regenerate worker before notices; release inputs only verify", async () => {
  for (const release of [false, true]) {
    const calls = [];
    await build.prepareDesktopAgentInputs({
      repoRoot: process.cwd(),
      env: { LCODE_VERIFY_RELEASE_INPUTS: release ? "1" : "0" },
      run: async (_command, args) => calls.push(args[0].split(/[\\/]/u).at(-1)),
      generate: async () => calls.push("generate"),
      verify: async () => calls.push("verify"),
    });
    assert.deepEqual(calls, ["build-auth-plugin-worker.mjs", release ? "verify" : "generate"]);
  }
});

test("failed worker or stale release notices stop the build input chain", async () => {
  const run = async () => {
    throw new Error("pin changed");
  };
  const generate = async () => assert.fail("must not generate after worker failure");
  await assert.rejects(
    build.prepareDesktopAgentInputs({ repoRoot: process.cwd(), run, generate }),
    /pin changed/u,
  );
  await assert.rejects(
    build.prepareDesktopAgentInputs({
      repoRoot: process.cwd(),
      env: { LCODE_VERIFY_RELEASE_INPUTS: "1" },
      run: async () => {},
      verify: async () => {
        throw new Error("stale notice");
      },
      generate,
    }),
    /stale notice/u,
  );
});

test("every Agent build mode replaces an existing bundle before staging", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "lcode-agent-sync-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const bundle = join(repoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
  await mkdir(join(bundle, ".."), { recursive: true });
  for (const mode of ["default", "turbo", "bootstrap"]) {
    await writeFile(bundle, "old bundle");
    const calls = [];
    await build.buildDesktopAgent({
      repoRoot,
      env: {
        LCODE_ENV: "production",
        LCODE_DESKTOP_AGENT_BUILD_MODE: mode,
        LCODE_BOOTSTRAP_WITH_REMOTE: mode === "bootstrap" ? "1" : "0",
      },
      prepare: async () => calls.push("inputs"),
      checkArtifact: async () => {},
      run: async (_command, args) => {
        calls.push(args);
        if (args.includes("build:desktop-agent") || args.includes("--desktop-agent"))
          await writeFile(bundle, `${mode} current bundle`);
      },
      stage: async () => {
        calls.push("stage");
        assert.equal(await readFile(bundle, "utf8"), `${mode} current bundle`);
      },
    });
    assert.equal(calls[0], "inputs");
    assert.equal(calls.at(-1), "stage");
    assert.ok(calls.length > 2);
    for (const plugin of ["node-repl-host", "browser-use-plugin"]) {
      assert.ok(
        calls.some((call) => Array.isArray(call) && call.includes(`@lcode/${plugin}`)) ||
          calls.some(
            (call) =>
              Array.isArray(call) &&
              call.some((value) =>
                value
                  .replaceAll("\\", "/")
                  .endsWith(`/apps/lcode-cli/packages/${plugin}/scripts/build.mjs`),
              ),
          ),
        `${mode} must rebuild ${plugin}`,
      );
    }
  }
});

test("build and input failures never stage old output; packaging leaves staging to its target", async () => {
  const options = {
    env: { LCODE_ENV: "production" },
    prepare: async () => {},
    checkArtifact: async () => {},
    stage: async () => assert.fail("must not stage"),
  };
  await assert.rejects(
    build.buildDesktopAgent({
      ...options,
      run: async () => {
        throw new Error("compile failed");
      },
    }),
    /compile failed/u,
  );
  await assert.rejects(
    build.buildDesktopAgent({
      ...options,
      prepare: async () => {
        throw new Error("input failed");
      },
      run: async () => assert.fail("must not compile"),
    }),
    /input failed/u,
  );
  await build.buildDesktopAgent({ ...options, run: async () => {}, stageBundle: false });
});

test("tag matrix enables committed-input verification and default local packaging synchronizes Agent", async () => {
  const workflow = YAML.parse(
    await readFile(new URL(".github/workflows/desktop-release.yml", root), "utf8"),
  );
  assert.equal(workflow.jobs.build.env.LCODE_VERIFY_RELEASE_INPUTS, "1");
  assert.equal(
    workflow.jobs.build.steps.find(
      (step) => step.name === "Package and verify desktop app identity",
    ).run,
    "pnpm bundle:desktop -- --os ${{ matrix.os }} --arch ${{ matrix.arch }}",
  );
  const prepare = await readFile(
    new URL("packages/desktop/scripts/prepare-agent-node-bundle.mjs", root),
    "utf8",
  );
  assert.match(prepare, /build-desktop-agent-cli\.mjs[\s\S]*?"--no-stage"/u);
  assert.doesNotMatch(prepare, /reuse existing official plugin runtime/u);
  assert.doesNotMatch(prepare, /function buildOfficialPluginRuntime/u);
});

test("CLI Turbo caches track the OAuth implementation and embedded notices", async () => {
  const turbo = JSON.parse(await readFile(new URL("apps/lcode-cli/turbo.json", root), "utf8"));
  for (const task of ["build:desktop-agent", "@lcode/cli#build"]) {
    assert.ok(
      turbo.tasks[task].inputs.includes("$TURBO_ROOT$/../../packages/provider-node/src/**"),
    );
    assert.ok(turbo.tasks[task].inputs.includes("$TURBO_ROOT$/../../THIRD-PARTY-NOTICES.md"));
  }
});
