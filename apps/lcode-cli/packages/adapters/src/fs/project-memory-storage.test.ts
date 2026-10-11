import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveProjectMemoryRoot } from "@lcode/shared/node";
import { NodeFileSystemAdapter } from "./index.js";

test("prepared project-local files register under a fresh owner and use governed read/write receipts", async (t) => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-runtime-location-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const input = { workspacePath: join(base, "project"), cliStorageRoot: join(base, "cli") };
  await mkdir(input.workspacePath);
  const profileRoot = resolveProjectMemoryRoot(input);
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(profileRoot, "MEMORY.md"), "- [Fixture](fact.md)");
  await writeFile(join(profileRoot, "fact.md"), "durable project fixture");
  const adapter = new NodeFileSystemAdapter();
  await adapter.projectMemory.registerRoot(profileRoot);
  const profileOwner = await readFile(
    join(dirname(profileRoot), "memory-state", "owner.json"),
    "utf8",
  );
  const prepared = await adapter.projectMemory.prepareStorage({
    ...input,
    storageLocation: "workspace",
  });
  assert.equal(prepared.copiedCount, 2);
  await adapter.projectMemory.registerRoot(prepared.rootDir);
  assert.equal(
    (await adapter.readTextFile({ path: join(prepared.rootDir, "MEMORY.md") })).content,
    "- [Fixture](fact.md)",
  );
  const target = join(prepared.rootDir, "fact.md");
  const before = await adapter.readTextFile({ path: target });
  await adapter.writeTextFile({
    path: target,
    content: "updated target fixture",
    expectedRevision: before.revision,
  });
  assert.equal((await adapter.projectMemory.listChanges(prepared.rootDir)).length, 1);
  assert.equal((await adapter.projectMemory.listChanges(profileRoot)).length, 0);
  assert.equal(await readFile(join(profileRoot, "fact.md"), "utf8"), "durable project fixture");
  assert.equal(
    await readFile(join(dirname(profileRoot), "memory-state", "owner.json"), "utf8"),
    profileOwner,
  );
  assert.equal(
    JSON.parse(
      await readFile(join(dirname(prepared.rootDir), "memory-state", "owner.json"), "utf8"),
    ).rootDir,
    prepared.rootDir,
  );
});
