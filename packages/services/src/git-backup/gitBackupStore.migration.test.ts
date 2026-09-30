import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
import { createBackupStore } from "./gitBackupStore.js";

const oss = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "git-backup-migration-test-"));
  const profile = join(root, "profile");
  await mkdir(profile);
  const path = join(profile, "git-backup-config.json");
  const original = JSON.stringify({ enabled: false, intervalMinutes: 5, oss, workspaces: [] });
  await writeFile(path, original);
  const values = new Map<string, string>();
  const credentials = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  return {
    root,
    profile,
    path,
    original,
    values,
    credentials,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("legacy sole plaintext secret migrates to a new immutable reference and survives profile move", async () => {
  const f = await fixture();
  try {
    const legacyKey = `git-backup:${createHash("sha256").update(f.profile).digest("hex").slice(0, 24)}:${oss.accessKeyId}`;
    f.values.set(legacyKey, "other-existing-secret");
    const store = createBackupStore(f.profile, f.credentials);
    const config = await store.loadConfig();
    assert.equal(config.oss!.accessKeySecret, "");
    const saved = await readFile(f.path, "utf8");
    assert.ok(!saved.includes(oss.accessKeySecret));
    const reference = JSON.parse(saved)._backup.credentialReferences.oss;
    assert.match(reference, /^git-backup:oss:/);
    assert.equal(f.values.get(legacyKey), "other-existing-secret");
    assert.equal((await store.resolveOss(config.oss!)).accessKeySecret, oss.accessKeySecret);
    const moved = join(f.root, "moved");
    await cp(f.profile, moved, { recursive: true });
    assert.equal((await createBackupStore(moved, f.credentials).getStatus()).configured, true);
  } finally {
    await f.close();
  }
});

for (const failure of ["credential", "document", "unavailable"] as const) {
  test(`${failure} migration failure keeps the original JSON and rolls back staged references`, async () => {
    const f = await fixture();
    try {
      if (failure === "credential") {
        const save = f.credentials.save;
        f.credentials.save = async (key, value) => {
          await save(key, value);
          throw new Error(`sensitive synthetic failure ${oss.accessKeySecret}`);
        };
      }
      const store = createBackupStore(
        f.profile,
        failure === "unavailable" ? undefined : f.credentials,
        {
          write:
            failure === "document"
              ? async () => {
                  throw new Error("document denied");
                }
              : atomicWritePrivateTextFile,
        },
      );
      await assert.rejects(
        store.loadConfig(),
        (error) => error instanceof Error && !error.message.includes(oss.accessKeySecret),
      );
      assert.equal(await readFile(f.path, "utf8"), f.original);
      assert.equal(f.values.size, 0);
      f.credentials.save = async (key, value) => {
        f.values.set(key, value);
      };
      const reopened = createBackupStore(f.profile, f.credentials);
      assert.equal((await reopened.getStatus()).configured, true);
    } finally {
      await f.close();
    }
  });
}
