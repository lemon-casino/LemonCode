import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireFileLock } from "./atomicFileLock.js";

async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "lcode-shared-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "checkout");
}

test("shared owners coexist and exclusive access waits for every owner", async (t) => {
  const path = await fixture(t);
  const shared = () => acquireFileLock(path, [5], 1000, 80, { shared: true });
  const exclusive = () => acquireFileLock(path, [5], 1000, 80);
  const first = await shared();
  const second = await shared();
  t.after(first);
  t.after(second);
  assert.equal((await readdir(`${path}.lock`)).length, 2);
  await assert.rejects(exclusive(), { code: "LCODE_FILE_LOCK_TIMEOUT" });
  await first();
  await assert.rejects(exclusive(), { code: "LCODE_FILE_LOCK_TIMEOUT" });
  await second();
  const releaseExclusive = await exclusive();
  t.after(releaseExclusive);
  await assert.rejects(shared(), { code: "LCODE_FILE_LOCK_TIMEOUT" });
  await releaseExclusive();
  await (
    await shared()
  )();
});

test("legacy exclusive callers and shared callers never bypass one another", async (t) => {
  const path = await fixture(t);
  const legacy = await acquireFileLock(path, [5], 1000, 80);
  t.after(legacy);
  await assert.rejects(acquireFileLock(path, [5], 1000, 80, { shared: true }), {
    code: "LCODE_FILE_LOCK_TIMEOUT",
  });
  await legacy();
  const shared = await acquireFileLock(path, [5], 1000, 80, { shared: true });
  t.after(shared);
  await assert.rejects(acquireFileLock(path, [5], 1000, 80), {
    code: "LCODE_FILE_LOCK_TIMEOUT",
  });
});

test("simultaneous shared acquisition and release preserve each owner", async (t) => {
  const path = await fixture(t);
  const owners = await Promise.all(
    Array.from({ length: 24 }, () => acquireFileLock(path, [5], 1000, 2000, { shared: true })),
  );
  for (const release of owners) t.after(release);
  assert.equal((await readdir(`${path}.lock`)).length, owners.length);
  await Promise.all(owners.slice(0, -1).map((release) => release()));
  assert.equal((await readdir(`${path}.lock`)).length, 1);
  await assert.rejects(acquireFileLock(path, [5], 1000, 80), {
    code: "LCODE_FILE_LOCK_TIMEOUT",
  });
  await owners.at(-1)!();
  await (
    await acquireFileLock(path, [5], 1000, 80)
  )();
});

test("malformed abandoned metadata is reclaimed without treating it as shared", async (t) => {
  const path = await fixture(t);
  await mkdir(`${path}.lock`);
  await writeFile(join(`${path}.lock`, "owner-abandoned.json"), "null");
  const release = await acquireFileLock(path, [5], 1000, 200, { shared: true });
  t.after(release);
  assert.equal((await readdir(`${path}.lock`)).length, 1);
});
