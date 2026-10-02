import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "@lcode/contracts";
import type { LocalhostOAuthCallbackServer } from "../auth/localhost-callback.js";
import type { SharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import { InteractiveAuthorizationProvider } from "./oauth-interactive-provider.js";
import { loadCanonicalCredentials } from "./oauth-credentials.js";
import { deletePendingAuthorizationIfOwned, loadPendingAuthorization } from "./oauth-lease.js";

function memoryStore() {
  const values = new Map<string, string>();
  const writes: string[][] = [];
  const unexpected = async (): Promise<never> => {
    assert.fail("Unexpected fixture store operation");
  };
  const store: SharedLCodeCredentialStore = {
    filePath: "unused-memory-credentials.json",
    clearZaiLoginCredentials: unexpected,
    delete: unexpected,
    deleteIfValues: unexpected,
    deleteManyIfValue: unexpected,
    loadMany: unexpected,
    saveReplacing: unexpected,
    saveZaiLoginCredentials: unexpected,
    async load(key) {
      return values.get(key) ?? null;
    },
    async save(key, value) {
      writes.push([key]);
      values.set(key, value);
    },
    async saveMany(entries) {
      writes.push(Object.keys(entries));
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
    async deleteIfValue(key, expected) {
      if (values.get(key) !== expected) return false;
      return values.delete(key);
    },
  };
  return { store, values, writes };
}

function providerInput(store: SharedLCodeCredentialStore) {
  const callbackServer: LocalhostOAuthCallbackServer = {
    callbackPath: "/oauth/callback",
    callbackUrl: "http://127.0.0.1:12345/oauth/callback",
    close: async () => {},
    waitForCallback: async () => {
      assert.fail("memory provider must not open a callback listener");
    },
  };
  return {
    attemptId: "fixture-attempt",
    callbackServer,
    config: { type: "authorization_code" as const, scope: "read" },
    credentialStore: store,
    keyPrefix: "fixture-oauth",
    serverName: "fixture",
    state: "fixture-private-state",
    transactionTtlMs: 30_000,
  };
}

test("interactive OAuth keeps client registration and PKCE in the transaction and never refreshes", async () => {
  const { store, writes } = memoryStore();
  const provider = new InteractiveAuthorizationProvider({
    ...providerInput(store),
    requestedScope: "read write",
  });
  assert.equal(provider.clientInformation(), undefined);
  assert.equal(provider.tokens(), undefined);
  assert.throws(() => provider.codeVerifier(), /Missing MCP OAuth PKCE verifier/);
  provider.saveClientInformation({
    client_id: "fixture-client",
    client_secret: "fixture-client-secret",
  });
  provider.saveCodeVerifier("fixture-verifier-secret");
  assert.equal(provider.clientInformation()?.client_id, "fixture-client");
  assert.equal(provider.codeVerifier(), "fixture-verifier-secret");
  assert.equal(provider.clientMetadata.scope, "read write");
  assert.deepEqual(provider.clientMetadata.redirect_uris, [provider.redirectUrl]);
  assert.deepEqual(writes, []);
  const next = new InteractiveAuthorizationProvider(providerInput(store));
  assert.equal(next.clientInformation(), undefined);
  assert.throws(() => next.codeVerifier(), /Missing MCP OAuth PKCE verifier/);
});

test("OAuth publishes the canonical pair and legacy mirrors atomically without logging secrets", async () => {
  const { store, writes } = memoryStore();
  const logs: unknown[] = [];
  const logger = {
    info: (...args: unknown[]) => {
      logs.push(args);
    },
  } as unknown as Logger;
  const provider = new InteractiveAuthorizationProvider({ ...providerInput(store), logger });
  provider.saveClientInformation({
    client_id: "fixture-client",
    client_secret: "fixture-client-secret",
  });
  provider.saveAuthorizationServerUrl("https://auth.example.test");
  await provider.saveTokens({
    access_token: "fixture-access-secret",
    refresh_token: "fixture-refresh-secret",
    token_type: "Bearer",
    expires_in: 3600,
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.length, 3);
  const canonical = await loadCanonicalCredentials(store, "fixture-oauth");
  assert.equal(canonical?.tokens.access_token, "fixture-access-secret");
  assert.equal(canonical?.clientInformation.client_secret, "fixture-client-secret");
  assert.equal(canonical?.issuer, "https://auth.example.test");
  assert.ok(canonical?.generation);
  for (const value of [
    "fixture-client-secret",
    "fixture-access-secret",
    "fixture-refresh-secret",
    "fixture-private-state",
  ]) {
    assert.equal(JSON.stringify(logs).includes(value), false);
  }
});

test("OAuth publishes pending before notifications and stale attempts cannot erase a successor", async () => {
  const { store } = memoryStore();
  const events: string[] = [];
  const provider = new InteractiveAuthorizationProvider({
    ...providerInput(store),
    onAuthorizationRequired: async () => {
      assert.equal(
        (await loadPendingAuthorization(store, "fixture-oauth"))?.attemptId,
        "fixture-attempt",
      );
      events.push("required");
    },
    openAuthorizationUrl: () => {
      events.push("open");
    },
  });
  await provider.redirectToAuthorization(
    new URL("https://auth.example.test/authorize?state=fixture-private-state"),
  );
  assert.deepEqual(events, ["required", "open"]);
  const successor = new InteractiveAuthorizationProvider({
    ...providerInput(store),
    attemptId: "successor",
  });
  await successor.redirectToAuthorization(
    new URL("https://auth.example.test/authorize?state=successor"),
  );
  assert.equal(
    await deletePendingAuthorizationIfOwned(store, "fixture-oauth", "fixture-attempt"),
    false,
  );
  assert.equal((await loadPendingAuthorization(store, "fixture-oauth"))?.attemptId, "successor");
  assert.equal(await deletePendingAuthorizationIfOwned(store, "fixture-oauth", "successor"), true);
  assert.equal(await loadPendingAuthorization(store, "fixture-oauth"), undefined);
});
