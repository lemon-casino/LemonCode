import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthDriver, AuthModel } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

test("fallback catalogs preserve prior models and sign-in reports remain scoped account facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-catalog-"));
  const store = new Map<string, string>();
  let fallback = false;
  const model = (id: string): AuthModel => ({
    id,
    name: id,
    protocol: "openai-responses",
    baseURL: "https://fixture.invalid",
  });
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: {
      load: async (k) => store.get(k) ?? null,
      save: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
    },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async (): Promise<AuthDriver> => ({
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async () => ({ type: "oauth", access: "private" }),
      }),
      models: async () => [model("fallback")],
      modelCatalog: async (context) => {
        await context.read();
        await context.reportSignIn?.(fallback ? "expired" : "renewed");
        return { models: [model(fallback ? "fallback" : "real")], fallback };
      },
      fetch: async () => new Response(),
    }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
  const complete = await service.completeAuthorization(attempt.attemptId, "code");
  let account = (await service.getView()).accounts[0]!;
  assert.equal(account.models[0]?.id, "real");
  assert.equal(account.authorizationStatus, "renewed");
  fallback = true;
  await service.refreshModels(complete.connectionId!);
  account = (await service.getView()).accounts[0]!;
  assert.equal(account.models[0]?.id, "real");
  assert.equal(account.authorizationStatus, "expired");
  assert.equal(account.status, "error");
  assert.equal(JSON.stringify(account).includes("private"), false);
});

test("an older Host catalog response cannot overwrite a reauthorized account from another Host", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-catalog-race-"));
  const store = new Map<string, string>();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slow = false;
  const model = (id: string): AuthModel => ({
    id,
    name: id,
    protocol: "openai-responses",
    baseURL: "https://fixture.invalid",
  });
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: {
      load: async (k) => store.get(k) ?? null,
      save: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => {
        store.delete(k);
      },
    },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async () => ({
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async () => ({ type: "oauth", access: "fixture" }),
      }),
      models: async (context) => {
        await context.read();
        if (slow) {
          entered();
          await gate;
        }
        return [model("old")];
      },
      fetch: async () => new Response(),
    }),
  });
  t.after(async () => {
    release();
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
  const completed = await service.completeAuthorization(attempt.attemptId, "code");
  slow = true;
  const refresh = service.refreshModels(completed.connectionId!);
  await waiting;
  const key = "model-provider-oauth-accounts-v1";
  const newer = JSON.parse(store.get(key)!);
  newer.accounts[0].generation++;
  newer.accounts[0].models = [model("new")];
  store.set(key, JSON.stringify(newer));
  release();
  await refresh;
  const account = (await service.getView()).accounts[0]!;
  assert.equal(account.models[0]?.id, "new");
  assert.equal(account.status, "ready");
});
