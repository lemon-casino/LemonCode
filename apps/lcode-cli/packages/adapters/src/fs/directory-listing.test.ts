import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isFileSystemPortError } from "@lcode/contracts";

import { createNodeFileSystemAdapter } from "./index.js";
import { readBoundedDirectoryEntries } from "./directory-listing.js";

test("listDirectory preserves complete sorted behavior when limit is omitted", async (t) => {
  const directory = await createFixtureDirectory(t, ["charlie.md", "alpha.md", "bravo.md"]);
  const result = await createNodeFileSystemAdapter().listDirectory({ path: directory });

  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["alpha.md", "bravo.md", "charlie.md"],
  );
  assert.equal(result.numEntries, 3);
  assert.equal(result.truncated, false);
});

test("listDirectory enforces a bounded adapter result", async (t) => {
  const directory = await createFixtureDirectory(t, [
    "one.md",
    "two.md",
    "three.md",
    "four.md",
    "five.md",
  ]);
  const result = await createNodeFileSystemAdapter().listDirectory({ path: directory, limit: 3 });

  assert.equal(result.entries.length, 3);
  assert.equal(result.numEntries, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    result.entries.map((entry) => entry.name).toSorted(),
  );
});

test("listDirectory reports a complete bounded result when EOF precedes the limit", async (t) => {
  const directory = await createFixtureDirectory(t, ["one.md", "two.md"]);
  const result = await createNodeFileSystemAdapter().listDirectory({ path: directory, limit: 5 });

  assert.equal(result.entries.length, 2);
  assert.equal(result.truncated, false);
});

test("listDirectory rejects invalid limits without falling back to an unbounded read", async (t) => {
  const directory = await createFixtureDirectory(t, ["one.md"]);
  for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      createNodeFileSystemAdapter().listDirectory({ path: directory, limit }),
      (error: unknown) => isFileSystemPortError(error) && error.code === "invalid_limit",
    );
  }
});

test("bounded iteration closes its directory handle after cancellation", async () => {
  const controller = new AbortController();
  let closeCount = 0;
  let readCount = 0;
  const entry = createFakeDirent("one.md");

  await assert.rejects(
    readBoundedDirectoryEntries({
      directory: {
        async close() {
          closeCount += 1;
        },
        async read() {
          readCount += 1;
          controller.abort();
          return entry;
        },
      },
      limit: 3,
      path: join(tmpdir(), "bounded-directory"),
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(readCount, 1);
  assert.equal(closeCount, 1);
});

test("listDirectory normalizes cancellation through the filesystem port", async (t) => {
  const directory = await createFixtureDirectory(t, ["one.md"]);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    createNodeFileSystemAdapter().listDirectory(
      { path: directory, limit: 1 },
      { signal: controller.signal },
    ),
    (error: unknown) => isFileSystemPortError(error) && error.code === "cancelled",
  );
});

async function createFixtureDirectory(
  t: TestContext,
  filenames: readonly string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-directory-listing-"));
  t.after(async () => await rm(directory, { force: true, recursive: true }));
  await Promise.all(filenames.map(async (name) => await writeFile(join(directory, name), name)));
  return directory;
}

function createFakeDirent(name: string): Dirent {
  return {
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false,
    name,
    parentPath: "",
    path: "",
  } as Dirent;
}
