import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { WorkspaceHookTrustRecord } from "@lcode/contracts";
import { createFileWorkspaceHookTrustStore } from "./workspace-hook-trust-store.js";

function record(digest: string): WorkspaceHookTrustRecord {
  return {
    workspaceIdentity: "workspace:fixture",
    hookDeclarationDigest: digest.repeat(64),
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-01-01T00:00:00.000Z",
    eventAtGrant: "PreToolUse",
    displayCommandAtGrant: "fixture-command",
    sourcePathAtGrant: "fixture/hooks.json",
  };
}

test("trust store keeps one mutation queue and serializes independent writers", async (t) => {
  const filePath = await fixturePath(t);
  const left = createFileWorkspaceHookTrustStore({ filePath });
  const right = createFileWorkspaceHookTrustStore({ filePath });
  await Promise.all([
    left.grant([record("a")]),
    left.grant([record("b")]),
    right.grant([record("c")]),
  ]);
  const loaded = await left.load();
  assert.equal(loaded.status, "ok");
  assert.deepEqual(loaded.records.map((entry) => entry.hookDeclarationDigest).sort(), [
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  ]);
  await assert.rejects(
    left.revoke({ workspaceIdentity: "workspace:fixture", hookDeclarationDigests: [] }),
    /non-empty/,
  );
  const revoked = await right.revoke({
    workspaceIdentity: "workspace:fixture",
    hookDeclarationDigests: ["b".repeat(64)],
  });
  assert.equal(revoked.records.length, 2);
  await assert.rejects(stat(`${filePath}.lock`), hasCode("ENOENT"));
});

test("trust lock metadata failure closes and unlinks its own lock before retry", async (t) => {
  const filePath = await fixturePath(t);
  const primary = new Error("metadata write failed");
  const failed = createFileWorkspaceHookTrustStore({
    filePath,
    async writeLockOwnerMetadata() {
      throw primary;
    },
  });
  await assert.rejects(failed.grant([record("a")]), (error: unknown) => error === primary);
  await assert.rejects(stat(`${filePath}.lock`), hasCode("ENOENT"));
  assert.equal(
    (await createFileWorkspaceHookTrustStore({ filePath }).grant([record("a")])).records.length,
    1,
  );
});

test("trust lock release cannot unlink a replacement owner's token", async (t) => {
  const filePath = await fixturePath(t);
  const replacement = { pid: process.pid, token: "replacement-owner", startTime: 1 };
  const store = createFileWorkspaceHookTrustStore({
    filePath,
    beforeRename: () => writeFile(`${filePath}.lock`, JSON.stringify(replacement)),
  });
  await store.grant([record("a")]);
  assert.deepEqual(JSON.parse(await readFile(`${filePath}.lock`, "utf8")), replacement);
});

test("corrupt trust documents remain fail-closed after extraction", async (t) => {
  const filePath = await fixturePath(t);
  await writeFile(filePath, "{malformed");
  const loaded = await createFileWorkspaceHookTrustStore({ filePath }).load();
  assert.equal(loaded.status, "corrupt");
  assert.deepEqual(loaded.records, []);
});

async function fixturePath(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-trust-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "trust.json");
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}
