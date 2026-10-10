import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { deleteModelIODebugRecords, writeModelIODebugRecord } from "./runner-debug-writer.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-model-io-discard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = [join(root, "debug"), join(root, "rollout")];
  for (const dir of dirs) {
    writeModelIODebugRecord({ sessionId: "sess_owned", request: {}, response: {} }, dir, true);
    writeModelIODebugRecord({ sessionId: "sess_other", request: {}, response: {} }, dir, true);
  }
  return { root, dirs };
}

test("permanent chat cleanup removes only its exact model-I/O files in both profiles and is repeatable", async (t) => {
  const f = await fixture(t);
  await deleteModelIODebugRecords(["sess_owned"], f.dirs);
  await deleteModelIODebugRecords(["sess_owned"], f.dirs);
  for (const dir of f.dirs) {
    await assert.rejects(access(join(dir, "model-io-sess_owned.jsonl")), { code: "ENOENT" });
    await access(join(dir, "model-io-sess_other.jsonl"));
  }
  writeModelIODebugRecord({ sessionId: "sess_owned", request: {}, response: {} }, f.dirs[0], true);
  const baseline = JSON.parse(
    (await readFile(join(f.dirs[0]!, "model-io-sess_owned.jsonl"), "utf8")).trim(),
  );
  assert.equal(baseline.sessionId, "sess_owned");
});

test("unsafe or colliding IDs and redirected profile roots fail before deleting other records", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    deleteModelIODebugRecords(["sess_owned", "../sess_other"], f.dirs),
    /session|file/iu,
  );
  await access(join(f.dirs[0]!, "model-io-sess_owned.jsonl"));
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "model-io-sess_owned.jsonl"), "keep");
  const linked = join(f.root, "linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(deleteModelIODebugRecords(["sess_owned"], [linked]), /redirect|symlink/iu);
  assert.equal(await readFile(join(outside, "model-io-sess_owned.jsonl"), "utf8"), "keep");
});
