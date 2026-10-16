import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRoutingPolicy, RoutingInvocation } from "@lcode/shared";
import type { AuthWireProtocol } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

async function fixture(
  t: test.TestContext,
  protocol: AuthWireProtocol = "openai-chat-completions",
  certified = true,
  recoveryFixture = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "routing-fixture-"));
  const saved = new Map<string, string>();
  const calls: string[] = [];
  let policy: ProviderRoutingPolicy | null = { version: 1, strategy: "share-rotation" };
  let status = 200;
  const auths = new Map<string, { baseURL: string; apiKey: string }>();
  const service = new ProviderAccounts({
    lockPath: join(directory, "accounts"),
    channels: [{ id: "fixture", name: "Fixture" }],
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    readRouting: async () => policy,
    factory: async () => ({
      routingSingleAttempt: certified ? true : undefined,
      methods: async () => [{ id: "fixture", label: "Fixture", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async (code) => ({ type: "oauth", access: `synthetic-${code}`, accountId: code }),
      }),
      models: async () => [
        {
          id: "model",
          name: "Model",
          baseURL: "https://fixture.invalid/v1",
          protocol,
          ...(recoveryFixture ? { routingPortability: "portable" as const } : {}),
        },
      ],
      fetch: async (_request, context) => {
        if (policy) assert.equal(context.routingSingleAttempt, true);
        calls.push(context.connectionId!);
        return new Response("fixture", {
          status,
          headers: {
            "retry-after-ms": recoveryFixture ? "0" : "1000",
            "x-lcode-rate-limit-scope": "key",
          },
        });
      },
    }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  for (const code of ["a", "b"]) {
    const authorization = await service.startAuthorization({
      channelId: "fixture",
      methodId: "fixture",
    });
    await service.completeAuthorization(authorization.attemptId, code);
  }
  const invocation = (attemptId: string, turnId = attemptId): RoutingInvocation => ({
    capability: "single-attempt-routing-v1",
    workspaceKey: "workspace",
    sessionId: "session",
    turnId,
    attemptId,
  });
  async function send(id: string, turn = id) {
    const auth = await service.resolveRequestAuth(
      "fixture",
      "model",
      protocol,
      "session",
      invocation(id, turn),
    );
    auths.set(id, auth);
    const suffix =
      protocol === "anthropic-messages"
        ? "/messages"
        : protocol === "openai-responses"
          ? "/responses"
          : "/chat/completions";
    const response = await fetch(auth.baseURL + suffix, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    await response.text();
    return response;
  }
  return {
    service,
    calls,
    send,
    auths,
    setPolicy: (next: typeof policy) => {
      policy = next;
    },
    setStatus: (next: number) => {
      status = next;
    },
  };
}

for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`enhanced OAuth has one POST per attempt and keeps turn binding (${protocol})`, async (t) => {
    const f = await fixture(t, protocol);
    await f.send("one", "turn");
    await f.send("tool", "turn");
    await f.send("next");
    assert.equal(f.calls[0], f.calls[1]);
    assert.notEqual(f.calls[1], f.calls[2]);
    f.setStatus(429);
    assert.equal((await f.send("failure")).status, 429);
    assert.equal(f.calls.length, 4);
  });

test("explicit OAuth routing requires a capable peer; absent policy keeps legacy tickets", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.resolveRequestAuth("fixture", "model", undefined, "session"),
    /routing-capability-required/,
  );
  f.setPolicy(null);
  assert.ok((await f.service.resolveRequestAuth("fixture", "model", undefined, "session")).apiKey);
});

test("uncertified drivers reject enhanced dispatch and retain legacy execution", async (t) => {
  const f = await fixture(t, "openai-chat-completions", false);
  for (const id of ["unsupported-one", "unsupported-two", "unsupported-three"]) {
    const response = await f.send(id);
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("x-zcode-routing-reason"), "routing-capability-required");
  }
  assert.equal(f.calls.length, 0);
  f.setPolicy(null);
  assert.equal((await f.send("legacy")).status, 200);
  assert.equal(f.calls.length, 1);
});

test("SDK usage feedback is authenticated by the original attempt ticket and never sends another model POST", async (t) => {
  const f = await fixture(t);
  await f.send("feedback");
  const auth = f.auths.get("feedback")!;
  const send = (
    apiKey: string,
    body = { workUnits: 8000, inputTokens: 6000, outputTokens: 2000 },
  ) =>
    fetch(auth.baseURL + "/routing/usage", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await send(auth.apiKey)).status, 204);
  assert.equal((await send(auth.apiKey)).status, 204);
  assert.equal((await send("invalid-ticket")).status, 403);
  assert.equal(f.calls.length, 1);
});

test("a clearly rejected first request releases only its provisional binding for the Runner's next permit", async (t) => {
  const f = await fixture(t);
  f.setPolicy({ version: 1, strategy: "primary-backup" });
  f.setStatus(429);
  assert.equal((await f.send("rejected", "same-turn")).status, 429);
  f.setStatus(200);
  assert.equal((await f.send("retry", "same-turn")).status, 200);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0], f.calls[1]);
});

for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`RCD-12 OAuth transport ${protocol} keeps recovery uncertain until authenticated normalized feedback`, async (t) => {
    const f = await fixture(t, protocol, true, true);
    f.setPolicy({ version: 1, strategy: "primary-backup" });
    f.setStatus(429);
    assert.equal((await f.send("failed")).status, 429);
    f.setStatus(200);
    assert.equal((await f.send("probe")).status, 200);
    const view = f.service.readRoutingDiagnostics("fixture")!;
    assert.equal(view.recovery[0]!.phase, "uncertain");
    assert.equal(view.owner.lastDecision?.effectiveStrategy, "primary-backup");
    await f.send("before-feedback");
    assert.equal(f.calls[0], f.calls[1]);
    assert.notEqual(f.calls[1], f.calls[2]);
    const auth = f.auths.get("probe")!;
    const feedback = await fetch(auth.baseURL + "/routing/usage", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "success" }),
    });
    assert.equal(feedback.status, 204);
    await f.send("recovered");
    assert.equal(f.calls[0], f.calls[3]);
    assert.equal(f.calls.length, 4);
    assert.equal(f.service.readRoutingDiagnostics("fixture")!.recovery[0]!.phase, "healthy");
  });
