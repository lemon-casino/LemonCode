import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import { loadCredentialPair, publishCanonicalCredentials } from "./oauth-credentials.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";
import { saveDiscoveryRecord } from "./oauth-shared.js";

const keyPrefix = "fixture-refresh",
  issuer = "https://auth.example.test",
  serverUrl = "https://mcp.example.test/tools";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lcode-refresh-cas-"));
  const store = createSharedLCodeCredentialStore({
    filePath: join(directory, "credentials.json"),
    cipher: { encrypt: (value) => value, decrypt: (value) => value },
  });
  const publish = (access = "fixture-old", refresh = "fixture-refresh") =>
    publishCanonicalCredentials(store, keyPrefix, {
      clientInformation: { client_id: "fixture-client", token_endpoint_auth_method: "none" },
      issuer,
      publishedBy: "fixture",
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: "Bearer",
        expires_in: 3600,
      },
    });
  await publish();
  await saveDiscoveryRecord(store, keyPrefix, {
    authorizationServerUrl: issuer,
    resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    },
  });
  return { store, publish, close: () => rm(directory, { recursive: true, force: true }) };
}

test("MCP SDK keeps an omitted refresh token and sends the resource audience", async () => {
  const f = await fixture();
  try {
    const access = await refreshMcpOAuthTokensUnderLock({
      credentialStore: f.store,
      keyPrefix,
      reactive: true,
      serverName: "fixture",
      serverUrl,
      fetchFn: async (input, init) => {
        const request = new Request(input, init),
          form = new URLSearchParams(await request.text());
        assert.equal(request.url, issuer + "/token");
        assert.equal(form.get("refresh_token"), "fixture-refresh");
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("resource"), serverUrl);
        return Response.json({
          access_token: "fixture-next",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    });
    assert.equal(access, "fixture-next");
    assert.equal(
      (await loadCredentialPair(f.store, keyPrefix))?.tokens?.refresh_token,
      "fixture-refresh",
    );
  } finally {
    await f.close();
  }
});

for (const result of ["success", "invalid_grant", "network"] as const)
  test(`MCP ${result} cannot overwrite or reject a login published during refresh`, async () => {
    const f = await fixture();
    try {
      const access = await refreshMcpOAuthTokensUnderLock({
        credentialStore: f.store,
        keyPrefix,
        reactive: result !== "network",
        serverName: "fixture",
        serverUrl,
        fetchFn: async () => {
          await f.publish("fixture-winner", "fixture-winner-refresh");
          if (result === "network") throw new TypeError("fixture unavailable");
          return result === "success"
            ? Response.json({
                access_token: "fixture-stale",
                refresh_token: "fixture-stale-refresh",
                token_type: "Bearer",
              })
            : Response.json({ error: "invalid_grant" }, { status: 400 });
        },
      });
      assert.equal(access, "fixture-winner");
      assert.equal(
        (await loadCredentialPair(f.store, keyPrefix))?.tokens?.refresh_token,
        "fixture-winner-refresh",
      );
    } finally {
      await f.close();
    }
  });

test("MCP refresh cannot resurrect credentials removed during the exchange", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      refreshMcpOAuthTokensUnderLock({
        credentialStore: f.store,
        keyPrefix,
        reactive: false,
        serverName: "fixture",
        serverUrl,
        fetchFn: async () => {
          await Promise.all(
            ["authorization_credentials", "client_information", "tokens"].map((name) =>
              f.store.delete(`${keyPrefix}:${name}`),
            ),
          );
          return Response.json({ access_token: "fixture-stale", token_type: "Bearer" });
        },
      }),
    );
    assert.equal(await loadCredentialPair(f.store, keyPrefix), undefined);
  } finally {
    await f.close();
  }
});

test("MCP conditional publication observes legacy-only rotation and compares missing mirror keys", async () => {
  const f = await fixture();
  try {
    const previous = (await loadCredentialPair(f.store, keyPrefix))!;
    await f.store.save(
      `${keyPrefix}:tokens`,
      JSON.stringify({
        access_token: "fixture-legacy",
        refresh_token: "fixture-legacy-refresh",
        token_type: "Bearer",
      }),
    );
    const winner = (await loadCredentialPair(f.store, keyPrefix))!;
    assert.notEqual(winner.generation, previous.generation);
    assert.equal(
      await publishCanonicalCredentials(
        f.store,
        keyPrefix,
        {
          clientInformation: { client_id: "fixture-client" },
          publishedBy: "stale",
          tokens: { access_token: "fixture-stale", token_type: "Bearer" },
        },
        previous.expectedValues!,
      ),
      undefined,
    );
    assert.equal(
      (await loadCredentialPair(f.store, keyPrefix))?.tokens?.access_token,
      "fixture-legacy",
    );
    await f.store.delete(`${keyPrefix}:tokens`);
    const entries = { [`${keyPrefix}:guard-result`]: "fixture-value" };
    assert.equal(await f.store.saveManyIfValues({ [`${keyPrefix}:tokens`]: null }, entries), true);
    await f.store.save(`${keyPrefix}:tokens`, "fixture-new");
    assert.equal(
      await f.store.saveManyIfValues(
        { [`${keyPrefix}:tokens`]: null },
        { [`${keyPrefix}:guard-result`]: "stale" },
      ),
      false,
    );
    assert.equal(await f.store.load(`${keyPrefix}:guard-result`), "fixture-value");
    await assert.rejects(f.store.saveManyIfValues({}, entries), /requires a snapshot/);
  } finally {
    await f.close();
  }
});

test("MCP successful rotation with failed persistence never returns an old token as success", async () => {
  const f = await fixture();
  let exchanges = 0;
  try {
    const store = {
      ...f.store,
      saveManyIfValues: async () => {
        throw new Error("fixture disk unavailable");
      },
    };
    await assert.rejects(
      refreshMcpOAuthTokensUnderLock({
        credentialStore: store,
        keyPrefix,
        reactive: false,
        serverName: "fixture",
        serverUrl,
        fetchFn: async () => {
          exchanges++;
          return Response.json({
            access_token: "fixture-next",
            refresh_token: "fixture-rotated",
            token_type: "Bearer",
          });
        },
      }),
      { code: "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE" },
    );
    assert.equal(exchanges, 1);
  } finally {
    await f.close();
  }
});

for (const code of ["invalid_grant", "invalid_client"] as const)
  test(`MCP ${code} invalidation losing its CAS reads the new login`, async () => {
    const f = await fixture();
    try {
      const store = {
        ...f.store,
        deleteManyIfValue: async (...args: Parameters<typeof f.store.deleteManyIfValue>) => {
          await f.publish("fixture-winner");
          return f.store.deleteManyIfValue(...args);
        },
      };
      const access = await refreshMcpOAuthTokensUnderLock({
        credentialStore: store,
        keyPrefix,
        reactive: true,
        serverName: "fixture",
        serverUrl,
        fetchFn: async () => Response.json({ error: code }, { status: 400 }),
      });
      assert.equal(access, "fixture-winner");
    } finally {
      await f.close();
    }
  });
