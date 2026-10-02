import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isFileSystemPortError } from "@lcode/contracts";
import { createNodeFileSystemAdapter, NodeFileSystemAdapter } from "./index.js";

test("filesystem facade preserves method arity and default atomic text metadata", async (t) => {
  assert.equal(NodeFileSystemAdapter.length, 0);
  assert.equal(createNodeFileSystemAdapter.length, 0);
  assert.equal(NodeFileSystemAdapter.prototype.readTextFile.length, 1);
  assert.equal(NodeFileSystemAdapter.prototype.readBinaryFile.length, 1);
  assert.equal(NodeFileSystemAdapter.prototype.readTextFileRange.length, 2);
  assert.equal(NodeFileSystemAdapter.prototype.writeTextFile.length, 1);
  assert.equal(NodeFileSystemAdapter.prototype.removeFile.length, 2);
  assert.equal(NodeFileSystemAdapter.prototype.searchFiles.length, 2);

  const directory = await fixtureDirectory(t);
  const adapter = createNodeFileSystemAdapter();
  const path = join(directory, "nested", "example.txt");
  const written = await adapter.writeTextFile({
    path,
    content: "first\nsecond\nthird\n",
    lineEndings: "CRLF",
    createParents: true,
  });
  assert.equal(await readFile(path, "utf8"), "first\r\nsecond\r\nthird\r\n");
  const text = await adapter.readTextFile({ path });
  assert.equal(text.content, "first\nsecond\nthird\n");
  assert.equal(text.lineEndings, "CRLF");
  assert.deepEqual(text.revision, written.revision);
  const range = await adapter.readTextFileRange({ path, offsetLine: 1, limitLines: 1 });
  assert.equal(range.content, "second");
  assert.equal(range.startLine, 2);
  assert.equal(range.totalLines, 4);
  const truncated = await adapter.readTextFile({ path, maxBytes: 5 });
  assert.equal(truncated.content, "first");
  assert.equal(truncated.truncated, true);
  await assert.rejects(adapter.readBinaryFile({ path, maxBytes: 1 }), hasCode("too_large"));
  const bytes = await adapter.readBinaryFile({ path });
  assert.equal(Buffer.from(bytes.content).toString(), "first\r\nsecond\r\nthird\r\n");

  await writeFile(path, "changed content has a different size");
  await assert.rejects(
    adapter.writeTextFile({ path, content: "must not write", expectedRevision: written.revision }),
    hasCode("stale_write"),
  );
  assert.equal(await readFile(path, "utf8"), "changed content has a different size");
  assert.deepEqual(await adapter.removeFile({ path }), { path, removed: true });
  assert.deepEqual(await adapter.removeFile({ path, missingOk: true }), { path, removed: false });
});

test("filesystem retains absolute path, directory and cancellation guards", async (t) => {
  const directory = await fixtureDirectory(t);
  const adapter = createNodeFileSystemAdapter();
  await assert.rejects(adapter.readTextFile({ path: "relative.txt" }), hasCode("invalid_path"));
  await assert.rejects(adapter.readTextFile({ path: directory }), hasCode("is_directory"));
  await assert.rejects(adapter.readBinaryFile({ path: directory }), hasCode("is_directory"));
  await assert.rejects(adapter.readTextFileRange({ path: directory }), hasCode("is_directory"));
  const path = join(directory, "retained.txt");
  await writeFile(path, "retained");
  await assert.rejects(
    adapter.removeFile({ path }, { signal: AbortSignal.abort() }),
    hasCode("cancelled"),
  );
  assert.equal(await readFile(path, "utf8"), "retained");
});

test("atomic writes refuse symlinks without overwriting their target", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "target.txt");
  const link = join(directory, "linked.txt");
  await writeFile(path, "original");
  try {
    await symlink(path, link, "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("Current Windows account cannot create file symlinks");
      return;
    }
    throw error;
  }
  await assert.rejects(
    createNodeFileSystemAdapter().writeTextFile({ path: link, content: "overwritten" }),
    /Refusing to write through symlink/,
  );
  assert.equal(await readFile(path, "utf8"), "original");
});

async function fixtureDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-file-operations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isFileSystemPortError(error) && error.code === code;
}
