import assert from "node:assert/strict";
import { createDecipheriv, constants, privateDecrypt } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureKeyPair, encryptBuffer } from "./gitBackupEncryption.js";

test("concurrent generation retains one durable RSA pair and compatible AES-CTR payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-backup-key-test-"));
  try {
    const pairs = await Promise.all(Array.from({ length: 6 }, () => ensureKeyPair(dir)));
    assert.ok(
      pairs.every(
        (pair) =>
          pair.privateKey === pairs[0]!.privateKey && pair.publicKey === pairs[0]!.publicKey,
      ),
    );
    const input = Buffer.from([0, 1, 255, 0, 10]);
    const payload = encryptBuffer(input, pairs[0]!.publicKey);
    const key = privateDecrypt(
      { key: pairs[0]!.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      payload.encryptedKey,
    );
    const decoder = createDecipheriv("aes-256-ctr", key, payload.iv);
    assert.deepEqual(
      Buffer.concat([decoder.update(payload.encryptedData), decoder.final()]),
      input,
    );
    const path = join(dir, "git-backup-keys", "backup.pem");
    const original = await readFile(path, "utf8");
    await unlink(join(dir, "git-backup-keys", "backup.pub"));
    await assert.rejects(ensureKeyPair(dir), /incomplete/);
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt key material is never replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-backup-key-test-"));
  try {
    await ensureKeyPair(dir);
    const path = join(dir, "git-backup-keys", "backup.pem");
    await writeFile(path, "fixture invalid key");
    await assert.rejects(ensureKeyPair(dir), /corrupt/);
    assert.equal(await readFile(path, "utf8"), "fixture invalid key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
