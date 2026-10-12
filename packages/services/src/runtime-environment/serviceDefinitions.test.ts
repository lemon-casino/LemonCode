import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEnvironmentRecord } from "@lcode/shared";
import type { ResolvedProjectExecutionContext } from "./contract.js";
import { resolveProjectService } from "./adapters/serviceDefinitions.js";

test("desktop definition hands the frozen package manager to the original development launcher", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-frozen-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "lcode", scripts: { "dev:desktop": "fixture" } }),
  );
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: root },
    purpose: "worktree",
    currentRevision: 1,
    status: "ready",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  for (const extension of ["cjs", ...(process.platform === "win32" ? ["exe"] : [])]) {
    const pnpm = join(root, `frozen-pnpm.${extension}`);
    await writeFile(pnpm, "fixture");
    const context: ResolvedProjectExecutionContext = {
      environmentId: record.environmentId,
      revision: 1,
      manifestDigest: "frozen",
      executionScope: record.scope,
      cwd: root,
      toolPaths: { node: process.execPath, pnpm },
      envOverlay: { base: "inherit", set: {} },
      resourceLeaseToken: "private",
    };
    const definition = await resolveProjectService(record, "dev:desktop", context);
    assert.ok(definition);
    assert.deepEqual(definition.argv, [
      process.execPath,
      join(root, "scripts/dev-desktop-env.mjs"),
      "production",
      "--runtime-only",
    ]);
    assert.deepEqual(definition.env, { npm_execpath: pnpm });
    assert.equal(definition.cwd, root);
    assert.equal(await resolveProjectService(record, "untrusted", context), null);
  }
});
