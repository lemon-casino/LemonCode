import assert from "node:assert/strict";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withFileLock } from "@lcode/shared/node";
import { NodeFileSystemAdapter } from "./index.js";
import { digest, hasCode, memoryFixture } from "./project-memory.test-support.js";

test("only explicitly registered Markdown writes require full raw-byte preconditions", async (t) => {
  const { base, rootDir, adapter, memory } = await memoryFixture(t);
  const ordinary = join(base, "unregistered.md");
  await adapter.writeTextFile({ path: ordinary, content: "ordinary" });
  await adapter.writeTextFile({ path: ordinary, content: "legacy overwrite" });
  await adapter.writeTextFile({ path: join(rootDir, "ordinary.txt"), content: "not Markdown" });
  const path = join(rootDir, "fact.md");
  await assert.rejects(
    adapter.writeTextFile({ path, content: "missing condition" }),
    hasCode("stale_write"),
  );
  const written = await adapter.writeTextFile({
    path,
    content: "first\nsecond\n",
    lineEndings: "CRLF",
    expectedMissing: true,
  });
  assert.equal(written.revision?.hash, digest("first\r\nsecond\r\n"));
  assert.deepEqual((await adapter.readTextFile({ path })).revision, written.revision);
  assert.equal((await memory.listChanges(rootDir)).length, 1);
  await assert.rejects(
    adapter.writeTextFile({ path, content: "unguarded" }),
    hasCode("stale_write"),
  );
  const metadata = await adapter.stat({ path });
  await assert.rejects(
    adapter.writeTextFile({ path, content: "mtime only", expectedRevision: metadata.revision }),
    hasCode("stale_write"),
  );
  await assert.rejects(
    adapter.writeTextFile({
      path,
      content: "both",
      expectedMissing: true,
      expectedRevision: written.revision,
    }),
    hasCode("stale_write"),
  );
  await adapter.writeTextFile({
    path,
    content: "replacement",
    expectedRevision: written.revision,
    atomic: false,
  });
  assert.equal(await readFile(path, "utf8"), "replacement");
  assert.equal((await memory.listChanges(rootDir)).length, 2);
});

test("same-size same-mtime edits are stale because the full hash is authoritative", async (t) => {
  const { rootDir, adapter } = await memoryFixture(t);
  const path = join(rootDir, "fact.md");
  await writeFile(path, "old!");
  const snapshot = await adapter.readTextFile({ path });
  const info = await stat(path);
  await writeFile(path, "new!");
  await utimes(path, info.atime, info.mtime);
  await assert.rejects(
    adapter.writeTextFile({ path, content: "lost update", expectedRevision: snapshot.revision }),
    hasCode("stale_write"),
  );
  assert.equal(await readFile(path, "utf8"), "new!");
});

test("two adapters serialize both replace conflicts and exclusive-create races", async (t) => {
  const { rootDir, adapter, memory } = await memoryFixture(t);
  const other = new NodeFileSystemAdapter();
  await other.projectMemory.registerRoot(rootDir);
  const path = join(rootDir, "fact.md");
  const initial = await adapter.writeTextFile({ path, content: "base", expectedMissing: true });
  for (const creating of [false, true]) {
    const target = creating ? join(rootDir, "new.md") : path;
    const condition = creating ? { expectedMissing: true } : { expectedRevision: initial.revision };
    const results = await Promise.allSettled(
      [adapter, other].map((writer, i) =>
        writer.writeTextFile({ path: target, content: `writer-${i}`, ...condition }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && hasCode("stale_write")(rejected.reason));
  }
  assert.equal(
    (await memory.listChanges(rootDir)).filter((change) => change.status === "committed").length,
    3,
  );
});

test("expectedMissing also performs non-clobbering publication outside a registered root", async (t) => {
  const { base, adapter } = await memoryFixture(t);
  const path = join(base, "ordinary.md");
  const results = await Promise.allSettled(
    ["a", "b"].map((content) =>
      adapter.writeTextFile({ path, content, expectedMissing: true, atomic: false }),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && hasCode("stale_write")(rejected.reason));
});

test("cancellation is checked again after waiting for the shared root lock", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "cancelled.md");
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const lock = withFileLock(join(stateDir, "writer"), async () => {
    entered();
    await holding;
  });
  await ready;
  const controller = new AbortController();
  const operation = adapter.writeTextFile(
    { path, content: "must not commit", expectedMissing: true },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(operation, hasCode("cancelled"));
  controller.abort();
  release();
  await lock;
  await rejected;
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.deepEqual(await memory.listChanges(rootDir), []);
  await assert.rejects(
    memory.listChanges(rootDir, { signal: AbortSignal.abort() }),
    hasCode("cancelled"),
  );
});
