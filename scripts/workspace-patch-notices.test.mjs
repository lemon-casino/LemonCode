import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectWorkspacePatches } from "./generate-third-party-notices.mjs";

test("release notice records use workspace patch ownership and track changed patch bytes", async () => {
  const files = new Map([
    ["pnpm-workspace.yaml", "patchedDependencies:\n  'fixture@1.0.0': patches/fixture.patch\n"],
    ["package.json", JSON.stringify({ pnpm: { patchedDependencies: { stale: "missing.patch" } } })],
    ["patches/fixture.patch", "first revision\n"],
  ]);
  const reads = [];
  const readInput = async (file) => {
    reads.push(file);
    assert.ok(files.has(file), `missing input: ${file}`);
    return Buffer.from(files.get(file));
  };
  const first = await collectWorkspacePatches(readInput);
  assert.deepEqual(reads, ["pnpm-workspace.yaml", "patches/fixture.patch"]);
  assert.deepEqual(first, [
    {
      package: "fixture@1.0.0",
      file: "patches/fixture.patch",
      sha256: createHash("sha256").update("first revision\n").digest("hex"),
    },
  ]);
  files.set("patches/fixture.patch", "second revision\n");
  const second = await collectWorkspacePatches(readInput);
  assert.notEqual(second[0].sha256, first[0].sha256);
});
