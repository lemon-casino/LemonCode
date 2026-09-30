import assert from "node:assert/strict";
import test from "node:test";
import { getGitBackupAggregateProviders } from "./gitBackup.js";
import { EMPTY_BACKUP_STATE, parseState } from "./gitBackupStoreDocument.js";

const history = { ...EMPTY_BACKUP_STATE, lastBackupAt: "success", error: "failure" };

test("empty aggregate history has no destination ownership", () => {
  assert.deepEqual(getGitBackupAggregateProviders(EMPTY_BACKUP_STATE, "success"), []);
  assert.deepEqual(getGitBackupAggregateProviders(EMPTY_BACKUP_STATE, "error"), []);
});

test("aggregate ownership uses recorded providers independent of switches", () => {
  const state = {
    ...history,
    lastBackupProviders: ["minio" as const],
    errorProviders: ["oss" as const],
  };
  assert.deepEqual(getGitBackupAggregateProviders(state, "success"), ["minio"]);
  assert.deepEqual(getGitBackupAggregateProviders(state, "error"), ["oss"]);
});

test("old v2 history infers ownership from destination evidence or conservatively includes both", () => {
  const state = {
    ...history,
    destinations: { minio: { lastBackupAt: "success", error: "failure" } },
  };
  assert.deepEqual(getGitBackupAggregateProviders(state, "success"), ["minio"]);
  assert.deepEqual(getGitBackupAggregateProviders(state, "error"), ["minio"]);
  assert.deepEqual(getGitBackupAggregateProviders(history, "success"), ["oss", "minio"]);
  assert.deepEqual(getGitBackupAggregateProviders(history, "error"), ["oss", "minio"]);
});

for (const field of ["lastBackupProviders", "errorProviders"] as const) {
  test(`${field} rejects corrupt ownership without overwriting accepted state`, () => {
    for (const providers of ["oss", ["other"], ["oss", "oss"], [null]]) {
      assert.throws(
        () => parseState({ ...history, [field]: providers }),
        /Invalid Git backup result providers/,
      );
    }
    assert.deepEqual(parseState({ ...history, [field]: ["oss", "minio"] })[field], [
      "oss",
      "minio",
    ]);
  });
}
