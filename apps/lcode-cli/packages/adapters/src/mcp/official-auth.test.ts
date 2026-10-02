import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "@lcode/contracts";
import { createOfficialMcpAuthFetch, OfficialMcpAuthError } from "./official-auth.js";

const official = { pluginId: "demo@fixture", mcpKey: "tools", source: "plugin" as const };
const url = "https://mcp.example.test/tools";

function capturedLogger() {
  const entries: unknown[] = [];
  const logger = {
    child: () => logger,
    debug: (...args: unknown[]) => {
      entries.push(args);
    },
    info: (...args: unknown[]) => {
      entries.push(args);
    },
    warn: (...args: unknown[]) => {
      entries.push(args);
    },
    error: (...args: unknown[]) => {
      entries.push(args);
    },
  } as Logger;
  return { entries, logger };
}

test("official auth refuses foreign and credential-bearing origins without resolving secrets or sending", async () => {
  let sends = 0;
  let resolves = 0;
  const fetch = createOfficialMcpAuthFetch({
    official,
    url,
    serverName: "fixture",
    trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
    authHeadersPort: {
      resolveHeaders: async () => {
        resolves += 1;
        return { ok: true, headers: {} };
      },
    },
    baseFetch: async () => {
      sends += 1;
      return new Response();
    },
  });
  for (const target of [
    "https://foreign.example.test/tools",
    "https://user:fixture-secret@mcp.example.test/tools",
  ]) {
    await assert.rejects(
      fetch(target),
      (error) =>
        error instanceof OfficialMcpAuthError && error.kind === "official_mcp_origin_untrusted",
    );
  }
  assert.equal(sends, 0);
  assert.equal(resolves, 0);
});

test("official auth retries credentialed 401 once with fresh headers and never logs secret values", async () => {
  const { entries, logger } = capturedLogger();
  let resolves = 0;
  const requests: Headers[] = [];
  const fetch = createOfficialMcpAuthFetch({
    official,
    url,
    serverName: "fixture",
    logger,
    trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
    authHeadersPort: {
      resolveHeaders: async () => ({
        ok: true,
        headers: { Authorization: `Bearer fixture-secret-${++resolves}` },
      }),
    },
    baseFetch: async (_resource, init) => {
      requests.push(new Headers(init?.headers));
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: requests.length === 1 ? 401 : 200 });
    },
  });
  const response = await fetch(url, {
    headers: {
      Authorization: "stale-secret",
      "X-Request-Id": "forged",
      "X-Trace-Id": "forged",
      "Mcp-Session-Id": "fixture-session",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(resolves, 2);
  assert.equal(requests[0]?.get("authorization"), "Bearer fixture-secret-1");
  assert.equal(requests[1]?.get("authorization"), "Bearer fixture-secret-2");
  for (const headers of requests) {
    assert.equal(headers.get("x-request-id"), null);
    assert.equal(headers.get("x-trace-id"), null);
    assert.equal(headers.get("mcp-session-id"), "fixture-session");
  }
  assert.equal(JSON.stringify(entries).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(entries).includes("stale-secret"), false);
});

for (const [status, kind] of [
  [403, "official_auth_forbidden"],
  [302, "official_auth_redirect_blocked"],
] as const) {
  test(`official auth does not retry ${status} and keeps server request id on tool errors`, async () => {
    let sends = 0;
    const fetch = createOfficialMcpAuthFetch({
      official,
      url,
      serverName: "fixture",
      trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
      authHeadersPort: {
        resolveHeaders: async () => ({ ok: true, headers: { Authorization: "fixture-secret" } }),
      },
      baseFetch: async () => {
        sends += 1;
        return new Response(null, { status, headers: { "x-request-id": "server-request" } });
      },
    });
    await assert.rejects(
      fetch(url, {
        method: "POST",
        body: JSON.stringify({ method: "tools/call", params: { name: "demo" } }),
      }),
      (error) =>
        error instanceof OfficialMcpAuthError &&
        error.kind === kind &&
        error.message.endsWith(" - server-request"),
    );
    assert.equal(sends, 1);
  });
}

test("anonymous official auth 401 does not retry and tools/call does not clone its body", async () => {
  let sends = 0;
  const fetch = createOfficialMcpAuthFetch({
    official,
    url,
    serverName: "fixture",
    trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
    baseFetch: async () => {
      sends += 1;
      const response = new Response(null, { status: 401 });
      response.clone = () => {
        assert.fail("tool response must not be cloned");
      };
      return response;
    },
  });
  await assert.rejects(
    fetch(url, { method: "POST", body: JSON.stringify({ method: "tools/call" }) }),
    (error) => error instanceof OfficialMcpAuthError && error.kind === "official_auth_rejected",
  );
  assert.equal(sends, 1);
});
