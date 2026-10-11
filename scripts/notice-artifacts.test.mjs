import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as generator from "./generate-third-party-notices.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "lcode-notice-write-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "third-party"));
  const notice = join(root, "THIRD-PARTY-NOTICES.md");
  const inventory = join(root, "third-party/inventory.json");
  await fs.writeFile(notice, "old notice");
  await fs.writeFile(inventory, "old inventory");
  return { root, notice, inventory };
}

const generated = { notices: Buffer.from("new notice"), inventory: { schemaVersion: 1 } };
const locked = () => Object.assign(new Error("Windows mapped file"), { code: "UNKNOWN" });

async function assertClean(root) {
  assert.deepEqual((await fs.readdir(root)).sort(), ["THIRD-PARTY-NOTICES.md", "third-party"]);
  assert.deepEqual(await fs.readdir(join(root, "third-party")), ["inventory.json"]);
}

test("notice generation replaces files without truncating an occupied destination", async (t) => {
  const { root, notice, inventory } = await fixture(t);
  const io = {
    ...fs,
    async writeFile(path, bytes, options) {
      if (path === notice || path === inventory) throw locked();
      return fs.writeFile(path, bytes, options);
    },
  };
  await generator.writeNoticeArtifacts({ root, ...generated }, { io });
  assert.equal(await fs.readFile(notice, "utf8"), "new notice");
  assert.deepEqual(JSON.parse(await fs.readFile(inventory, "utf8")), generated.inventory);
  await assertClean(root);
});

test("inventory temporary write failure preserves both previous artifacts", async (t) => {
  const { root, notice, inventory } = await fixture(t);
  const io = {
    ...fs,
    async writeFile(path, bytes, options) {
      if (path.startsWith(`${inventory}.`)) throw locked();
      return fs.writeFile(path, bytes, options);
    },
  };
  await assert.rejects(generator.writeNoticeArtifacts({ root, ...generated }, { io }), {
    code: "UNKNOWN",
  });
  assert.equal(await fs.readFile(notice, "utf8"), "old notice");
  assert.equal(await fs.readFile(inventory, "utf8"), "old inventory");
  await assertClean(root);
});

test("failed inventory replacement restores the previous notice with bounded retries", async (t) => {
  const { root, notice, inventory } = await fixture(t);
  const waits = [];
  let replacements = 0;
  const io = {
    ...fs,
    async rename(source, target) {
      if (target === inventory) {
        replacements++;
        throw locked();
      }
      return fs.rename(source, target);
    },
  };
  await assert.rejects(
    generator.writeNoticeArtifacts(
      { root, ...generated },
      { io, platform: "win32", wait: async (ms) => waits.push(ms) },
    ),
    { code: "UNKNOWN" },
  );
  assert.equal(replacements, 5);
  assert.deepEqual(waits, [25, 50, 100, 200]);
  assert.equal(await fs.readFile(notice, "utf8"), "old notice");
  assert.equal(await fs.readFile(inventory, "utf8"), "old inventory");
  await assertClean(root);
});

test("temporary Windows rename failures recover, permanent disk errors never retry", async (t) => {
  const { root, inventory } = await fixture(t);
  let attempts = 0;
  const io = {
    ...fs,
    async rename(source, target) {
      if (target === inventory && ++attempts < 3) throw locked();
      return fs.rename(source, target);
    },
  };
  await generator.writeNoticeArtifacts(
    { root, ...generated },
    { io, platform: "win32", wait: async () => {} },
  );
  assert.equal(attempts, 3);
  const wait = () => assert.fail("disk errors must not retry");
  await assert.rejects(
    generator.writeNoticeArtifacts(
      { root, ...generated },
      {
        platform: "win32",
        wait,
        io: {
          ...fs,
          rename: async () => {
            throw Object.assign(new Error("full"), { code: "ENOSPC" });
          },
        },
      },
    ),
    { code: "ENOSPC" },
  );
  await assertClean(root);
});
