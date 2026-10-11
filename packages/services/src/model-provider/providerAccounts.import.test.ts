import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthDriver, AuthGrant, AuthImportEntry } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

async function fixture(t: test.TestContext, entries: () => Promise<readonly AuthImportEntry[]>) {
  const dir = await mkdtemp(join(tmpdir(), "oauth-import-"));
  const store = new Map([["existing-api", "untouched"]]);
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: {
      load: async (key) => store.get(key) ?? null,
      save: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async (): Promise<AuthDriver> => ({
      methods: async () => [{ id: "import-file", label: "Import", type: "oauth", kind: "import" }],
      authorize: async () => ({
        method: "code",
        complete: async () => {
          throw new Error("Single completion must not run");
        },
        completeMany: entries,
      }),
      models: async () => [
        {
          id: "model",
          name: "Model",
          protocol: "openai-responses",
          baseURL: "https://fixture.invalid/v1",
        },
      ],
      fetch: async () => new Response(),
    }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const start = () =>
    service.startAuthorization({
      channelId: "fixture",
      methodId: "import-file",
      inputs: { files: "[]" },
    });
  const run = async () => service.completeAuthorization((await start()).attemptId, "");
  return { service, store, start, run };
}
const grant = (identity: string, refresh: string): AuthGrant => ({
  type: "oauth",
  identityKey: identity,
  displayName: "Same email",
  refresh,
  access: "private-access-" + refresh,
});

test("batch import preserves successful rows and distinct workspaces without exposing grants", async (t) => {
  const f = await fixture(t, async () => [
    { status: "ready", grant: grant("user:workspace-a", "one") },
    { status: "failed", error: "private-secret", label: "file 2" },
    { status: "ready", grant: grant("user:workspace-b", "two") },
  ]);
  const result = await f.run();
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.results?.map((row) => row.status),
    ["added", "failed", "added"],
  );
  assert.equal((await f.service.getView()).accounts.length, 2);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(f.store.get("existing-api"), "untouched");
});

test("reimport updates stable identity and preserves connection and disabled state", async (t) => {
  let token = "one";
  const f = await fixture(t, async () => [
    { status: "ready", grant: grant("user:workspace-a", token) },
  ]);
  const first = await f.run();
  const id = first.connectionId!;
  await f.service.setAccountEnabled(id, false);
  token = "two";
  const second = await f.run();
  assert.equal(second.results?.[0]?.status, "updated");
  assert.equal(second.connectionId, id);
  assert.equal((await f.service.getView()).accounts[0]?.enabled, false);
  const third = await f.run();
  assert.equal(third.results?.[0]?.status, "exists");
  assert.equal((await f.service.getView()).accounts.length, 1);
});

test("cancelled batch cannot commit late imported credentials", async (t) => {
  let release!: (rows: readonly AuthImportEntry[]) => void;
  const f = await fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const attempt = await f.start();
  const completion = f.service.completeAuthorization(attempt.attemptId, "");
  await f.service.cancelAuthorization(attempt.attemptId);
  release([{ status: "ready", grant: grant("late", "private") }]);
  await completion;
  assert.equal((await f.service.getView()).accounts.length, 0);
  assert.equal((await f.service.getAuthorization(attempt.attemptId)).status, "cancelled");
});
