import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const TEMP_PREFIX = "lcode-snippet-bundle-";
const sourceBundle = "apps/lcode-cli/packages/cli/dist/lcode.cjs";
const lemon = "apps/lcode-cli/packages/lemon-workflow-plugin";
const cua = "apps/lcode-cli/packages/lcode-cua-plugin";

test("new agent bundle and corrected authoring guidance survive actual staging", async (t) => {
  assert.ok(
    (await stat(resolve(repoRoot, sourceBundle))).isFile(),
    "build the current desktop-agent bundle before running this test",
  );
  const fixtureRoot = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  t.after(async () => {
    assert.equal(dirname(resolve(fixtureRoot)), resolve(tmpdir()));
    assert.ok(fixtureRoot.startsWith(join(tmpdir(), TEMP_PREFIX)));
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const bundleTarget = resolve(fixtureRoot, sourceBundle);
  await mkdir(dirname(bundleTarget), { recursive: true });
  await copyFile(resolve(repoRoot, sourceBundle), bundleTarget);
  for (const path of [lemon, cua])
    await cp(resolve(repoRoot, path), resolve(fixtureRoot, path), { recursive: true });
  const platformKey = `${process.platform}-${process.arch}`;
  const glm = resolve(fixtureRoot, "packages/desktop/bundled-agents", platformKey, "glm");
  // stage 清空的绝对目标是本测试新建的临时仓库；不触碰真实桌面资源或用户数据。
  assert.ok(glm.startsWith(`${fixtureRoot}${process.platform === "win32" ? "\\" : "/"}`));
  await stageAgentBundle({
    repoRoot: fixtureRoot,
    platformKey,
    koffiPackageRoot: resolve(repoRoot, "apps/lcode-cli/packages/adapters"),
    log: () => {},
  });
  const actual = await readFile(resolve(glm, "lcode.cjs"));
  assert.deepEqual(actual, await readFile(resolve(repoRoot, sourceBundle)));
  assert.ok(actual.includes(Buffer.from("Both `code` and `path` were provided")));
  assert.ok(actual.includes(Buffer.from("Neither `code` nor `path` was provided")));
  assert.ok(actual.includes(Buffer.from("tool.input.source_rejected")));
  for (const relative of ["commands/lemon.md", "skills/dynamic-workflows/SKILL.md"]) {
    assert.deepEqual(
      await readFile(resolve(glm, "packages/lemon-workflow-plugin", relative)),
      await readFile(resolve(repoRoot, lemon, relative)),
    );
  }
});
