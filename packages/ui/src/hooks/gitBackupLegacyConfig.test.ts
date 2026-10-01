import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLegacyGitBackupConfig,
  clearLegacyGitBackupOnboarding,
  hasLegacyGitBackupOnboarding,
  readLegacyGitBackupConfig,
} from "./gitBackupLegacyConfig.js";

function makeStorage(entries: Record<string, string>) {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test("legacy configuration becomes a draft without changing storage or enabling backup", () => {
  const storage = makeStorage({
    "git-backup-config": JSON.stringify({
      enabled: true,
      oss: {
        accessKeyId: " example-id ",
        accessKeySecret: " example-secret ",
        bucket: " example-bucket ",
        region: " oss-cn-hangzhou ",
      },
    }),
  });
  const draft = readLegacyGitBackupConfig(storage);
  assert.equal(draft?.accessKeyId, "example-id");
  assert.equal(draft?.region, "oss-cn-hangzhou");
  assert.equal(draft?.pathPrefix, "");
  assert.ok(storage.getItem("git-backup-config"));
  assert.equal("enabled" in (draft ?? {}), false);
  clearLegacyGitBackupConfig(storage);
  assert.equal(storage.getItem("git-backup-config"), null);
});

test("malformed and inaccessible legacy storage is ignored without leaking raw data", () => {
  for (const raw of ["invalid", "null", "{}", '{"oss":{"bucket":"bucket"}}']) {
    assert.equal(readLegacyGitBackupConfig(makeStorage({ "git-backup-config": raw })), null);
  }
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.equal(readLegacyGitBackupConfig(blocked), null);
  assert.equal(hasLegacyGitBackupOnboarding(blocked), false);
  assert.equal(readLegacyGitBackupConfig(null), null);
});

test("legacy onboarding is removed only after explicit migration acknowledgement", () => {
  const storage = makeStorage({ "git-backup-onboarding-done": "1" });
  assert.equal(hasLegacyGitBackupOnboarding(storage), true);
  assert.equal(storage.getItem("git-backup-onboarding-done"), "1");
  clearLegacyGitBackupOnboarding(storage);
  assert.equal(hasLegacyGitBackupOnboarding(storage), false);
});
