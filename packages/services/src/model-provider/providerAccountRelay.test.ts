import { randomUUID as routingUuid } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChannelClient, ChannelServer, Emitter, ProxyChannel, type VSBuffer } from "@lcode/rpc";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  createAccountProviderConfigSnapshot,
  parseProviderConfig,
} from "@lcode/provider";
import {
  PROVIDER_ACCOUNT_RELAY_CHANNEL,
  type ProviderAccountRelayOpen,
  type ProviderRoutingPolicy,
} from "@lcode/shared";
import { ProviderAccounts } from "./providerAccounts.js";
import { PROVIDER_AUTH_CHANNELS } from "./providerAccountStoreSchema.js";
import { createProviderAccountsSource } from "./providerAccountsSource.js";
import { createProviderAccountRelaySource } from "./providerAccountRelaySource.js";
import { RemoteProviderAccounts } from "./remoteProviderAccounts.js";
import type { ProviderAccountRelayService } from "./providerAccountRelay.js";
import type { AuthDriverContext } from "@lcode/provider-node";

const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
const paths = ["/chat/completions", "/responses", "/messages"] as const;

async function fixture(
  t: test.TestContext,
  fetchHook?: (request: Request, context: AuthDriverContext) => Promise<Response>,
  routing?: ProviderRoutingPolicy,
) {
  const directory = await mkdtemp(join(tmpdir(), "remote-oauth-relay-"));
  const saved = new Map<string, string>();
  const calls: string[] = [];
  const local = new ProviderAccounts({
    readRouting: async () => routing,
    lockPath: join(directory, "accounts"),
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    factory: async (channelId) => {
      const index = PROVIDER_AUTH_CHANNELS.findIndex((channel) => channel.id === channelId);
      return {
        routingSingleAttempt: true,
        methods: async () => [{ id: "login", label: "Fixture", type: "oauth" }],
        authorize: async () => ({
          method: "code",
          complete: async () => ({ type: "oauth", access: `secret-${channelId}`, revision: 0 }),
        }),
        models: async () => [
          {
            id: "fixture-model",
            name: "Fixture",
            protocol: protocols[index % 3]!,
            baseURL: "https://fixture.invalid/v1",
            contextWindow: 200000,
            toolCall: true,
          },
        ],
        checkin: async () => ({ outcome: "claimed", credit: 10 }),
        fetch: async (request, context) => {
          const grant = (await context.read())!;
          assert.equal(grant.access, `secret-${channelId}`);
          await context.write({ ...grant, revision: Number(grant.revision) + 1 });
          assert.equal(new URL(request.url).pathname, `/v1${paths[index % 3]}`);
          assert.equal(request.headers.get("x-lcode-session-id"), null);
          calls.push(channelId);
          if (fetchHook) return fetchHook(request, context);
          const body = new TextEncoder().encode(
            `data: {"channel":"${channelId}","tool_calls":[],"usage":{"total_tokens":7}}\n\ndata: [DONE]\n\n`,
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(body.slice(0, 13));
                controller.enqueue(body.slice(13));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      };
    },
  });
  const source = createProviderAccountRelaySource(local);
  const remote = new RemoteProviderAccounts();
  const toLocal = new Emitter<VSBuffer>();
  const toRemote = new Emitter<VSBuffer>();
  const frames: VSBuffer[] = [];
  const localProtocol = {
    onMessage: toLocal.event,
    send: (frame: VSBuffer) => {
      frames.push(frame);
      queueMicrotask(() => toRemote.fire(frame));
    },
  };
  const remoteProtocol = {
    onMessage: toRemote.event,
    send: (frame: VSBuffer) => {
      frames.push(frame);
      queueMicrotask(() => toLocal.fire(frame));
    },
  };
  const localClient = new ChannelClient(localProtocol);
  const remoteClient = new ChannelClient(remoteProtocol);
  const localServer = new ChannelServer(localProtocol, "trusted-remote", 1000, true);
  localServer.registerChannel(
    PROVIDER_ACCOUNT_RELAY_CHANNEL,
    ProxyChannel.fromService(source.service),
  );
  localClient.onDidInitialize(() => localServer.ready());
  const remoteServer = new ChannelServer(remoteProtocol, "stdio");
  const proxy = ProxyChannel.toService<ProviderAccountRelayService>(
    remoteClient.getChannel(PROVIDER_ACCOUNT_RELAY_CHANNEL),
  );
  remote.attach(proxy);
  t.after(async () => {
    remote.dispose();
    source.dispose();
    localClient.dispose();
    remoteClient.dispose();
    localServer.dispose();
    remoteServer.dispose();
    await local.dispose();
    toLocal.dispose();
    toRemote.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { local, remote, source, proxy, saved, frames, calls };
}

test("enhanced relay negotiates capabilities, returns the actual strategy and sends usage to the original attempt", async (t) => {
  const policy = { version: 1, strategy: "headroom-balance" } as const;
  const f = await fixture(t, undefined, policy);
  const login = await f.local.startAuthorization({ channelId: "bigmodel", methodId: "login" });
  await f.local.completeAuthorization(login.attemptId, "fixture");
  const auth = await resolveAuth(
    f.remote,
    "bigmodel",
    "fixture-model",
    "openai-chat-completions",
    '["ssh-workspace","remote-session"]',
    {
      capability: "single-attempt-routing-v1",
      workspaceKey: "ssh-workspace",
      remoteSessionId: "attachment",
      sessionId: "remote-session",
      attemptId: "physical-1",
      turnId: "turn",
    },
  );
  const response = await fetch(auth.baseURL + "/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", stream: true }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(response.headers.get("x-zcode-routing-strategy"), "share-rotation");
  const feedback = await fetch(auth.baseURL + "/routing/usage", {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ workUnits: 7 }),
  });
  assert.equal(feedback.status, 204);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.frames.some((frame) => Buffer.from(frame.buffer).includes(Buffer.from("secret-"))),
    false,
  );
  const old = new RemoteProviderAccounts({ readRouting: async () => policy });
  t.after(() => old.dispose());
  old.attach({ ...f.source.service, getRoutingCapabilities: undefined });
  await assert.rejects(
    resolveAuth(old, "bigmodel", "fixture-model"),
    /routing-capability-required/,
  );
});

test("remote check-in and automatic settings call the original account owner and project no credentials", async (t) => {
  const f = await fixture(t);
  const attempt = await f.local.startAuthorization({ channelId: "workbuddy", methodId: "login" });
  const result = await f.local.completeAuthorization(attempt.attemptId, "fixture");
  const id = result.connectionId!;
  await f.remote.setAutomaticCheckin(id, true);
  const view = await f.remote.checkinAll("workbuddy");
  assert.equal(view.accounts[0]?.checkin?.result?.credit, 10);
  assert.equal((await f.local.getView()).accounts[0]?.checkin?.automatic, true);
  assert.doesNotMatch(JSON.stringify(view), /secret-|access|baseURL/);
  await f.remote.checkinAccount(id);
});

test("remote Registry selects API plus every OAuth channel and executes all three protocols over bidirectional RPC", async (t) => {
  const f = await fixture(t);
  for (const channel of PROVIDER_AUTH_CHANNELS) {
    const attempt = await f.local.startAuthorization({ channelId: channel.id, methodId: "login" });
    await f.local.completeAuthorization(attempt.attemptId, "fixture");
  }
  const empty = createAccountProviderConfigSnapshot("builtin", ProviderConfigMap.empty());
  const source = createProviderAccountsSource(
    { read: async () => empty, refresh: async () => empty, onDidChange: () => () => {} },
    f.remote,
  );
  const apiModelConfig = (await source.read()).modelRules!.rules()[0]!.config;
  const apiProviders = ProviderConfigMap.empty().setRule({
    providerId: "openai",
    providerName: "OpenAI",
    enabled: true,
    config: parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-api-key" },
      api: { type: "openai-responses", baseUrl: "https://api.invalid/v1" },
      builtinModelIds: ["api-model"],
    }),
  });
  const registry = new ProviderRegistryService({
    configSource: {
      read: async () => ({
        revision: "config",
        lcodeBuiltinRevision: "builtin",
        personalRevision: "personal",
        lcodeBuiltinProviders: apiProviders,
        lcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
        personalProviders: ProviderConfigMap.empty(),
        lcodeBuiltinModelRules: new ModelConfigRules([
          {
            type: "provider-model",
            providerId: "openai",
            modelId: "api-model",
            config: apiModelConfig,
          },
        ]),
        personalModels: ModelConfigRules.empty(),
      }),
      onDidChange: () => () => {},
    },
    accountSource: source,
  });
  t.after(() => registry.dispose());
  await registry.start();
  assert.equal(registry.listProviders().length, PROVIDER_AUTH_CHANNELS.length + 1);
  assert.equal(
    registry.validateSelection({
      providerId: "openai",
      modelId: "api-model",
      options: { reasoningLevel: "default" },
    }).ok,
    true,
  );
  for (const [index, channel] of PROVIDER_AUTH_CHANNELS.entries()) {
    assert.equal(
      registry.validateSelection({
        providerId: `oauth:${channel.id}`,
        modelId: "fixture-model",
        options: { reasoningLevel: "default" },
      }).ok,
      true,
      channel.id,
    );
    const auth = await resolveAuth(
      f.remote,
      channel.id,
      "fixture-model",
      undefined,
      '["ssh-workspace","remote-session"]',
    );
    const response = await fetch(`${auth.baseURL}${paths[index % 3]}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", stream: true }),
    });
    assert.equal(response.status, 200, channel.id);
    assert.match(await response.text(), new RegExp(`"channel":"${channel.id}"`));
  }
  assert.equal(f.calls.length, PROVIDER_AUTH_CHANNELS.length);
  assert.equal(
    f.frames.some((frame) => Buffer.from(frame.buffer).includes(Buffer.from("secret-"))),
    false,
  );
  assert.equal((await f.remote.getView()).accounts.length, PROVIDER_AUTH_CHANNELS.length);
});

test("remote account changes use the original local owner and removed accounts reject previously issued tickets", async (t) => {
  const f = await fixture(t);
  const changes: number[] = [];
  const off = f.remote.onDidChange((view) => changes.push(view.accounts.length));
  t.after(() => off.dispose());
  const attempt = await f.remote.startAuthorization({ channelId: "codex", methodId: "login" });
  const complete = await f.remote.completeAuthorization(attempt.attemptId, "fixture");
  assert.equal((await f.local.getView()).accounts.length, 1);
  const auth = await resolveAuth(f.remote, "codex", "fixture-model");
  await f.remote.removeAccount(complete.connectionId!);
  assert.equal((await f.local.getView()).accounts.length, 0);
  await assert.rejects(resolveAuth(f.remote, "codex", "fixture-model"));
  const response = await fetch(`${auth.baseURL}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model" }),
  });
  assert.equal(response.status, 502);
  assert.equal(f.calls.length, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(changes.includes(1));
  assert.ok(changes.includes(0));
});

test("private relay rejects arbitrary URLs, auth headers, malformed payloads and unknown request IDs", async (t) => {
  const f = await fixture(t);
  const request: ProviderAccountRelayOpen = {
    requestId: randomUUID(),
    routingInvocation: routingContext(),
    channelId: "codex",
    modelId: "fixture-model",
    protocol: "anthropic-messages",
    body: Buffer.from('{"model":"fixture-model"}').toString("base64"),
    headers: {},
  };
  await assert.rejects(
    f.proxy.open({ ...request, url: "https://arbitrary.invalid" } as typeof request),
  );
  await assert.rejects(
    f.proxy.open({
      ...request,
      headers: { authorization: "untrusted" },
    } as unknown as ProviderAccountRelayOpen),
  );
  await assert.rejects(f.proxy.open({ ...request, body: "%%%" }));
  await assert.rejects(f.proxy.read(randomUUID()));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function loginCodex(local: ProviderAccounts) {
  const attempt = await local.startAuthorization({ channelId: "codex", methodId: "login" });
  await local.completeAuthorization(attempt.attemptId, "fixture");
}
function request(lane = "fixture"): ProviderAccountRelayOpen {
  return {
    requestId: randomUUID(),
    routingInvocation: routingContext(),
    channelId: "codex",
    modelId: "fixture-model",
    protocol: "anthropic-messages",
    sessionId: '["ssh-workspace","remote-session"]',
    headers: {},
    body: Buffer.from(JSON.stringify({ model: "fixture-model", lane })).toString("base64"),
  };
}

test(
  "cancelling before response headers aborts the original driver and rejects late completion",
  { timeout: 10000 },
  async (t) => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const f = await fixture(t, async (_request, context) => {
      started.resolve(context.signal!);
      await new Promise<void>((resolve) =>
        context.signal!.addEventListener(
          "abort",
          () => {
            aborted.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      return new Response("late response");
    });
    await loginCodex(f.local);
    const input = request();
    const opening = f.proxy.open(input);
    const rejection = assert.rejects(opening, /OAuth relay model request failed/);
    await started.promise;
    await f.proxy.cancel(input.requestId);
    await rejection;
    await aborted.promise;
    await assert.rejects(f.proxy.read(input.requestId));
  },
);

test("relay response chunks preserve large binary contents and duplicate IDs are rejected", async (t) => {
  const bytes = Buffer.alloc(200000, 129);
  const f = await fixture(t, async () => new Response(bytes));
  await loginCodex(f.local);
  const input = request();
  assert.equal((await f.proxy.open(input)).status, 200);
  await assert.rejects(f.proxy.open(input), /unavailable/);
  const received: Buffer[] = [];
  while (true) {
    const chunk = await f.proxy.read(input.requestId);
    if (chunk.done) break;
    const part = Buffer.from(chunk.data, "base64");
    assert.ok(part.length <= 65536);
    received.push(part);
  }
  assert.deepEqual(Buffer.concat(received), bytes);
  await assert.rejects(f.proxy.read(input.requestId));
});

test(
  "closing one connection cancels its stream while the shared local account remains usable",
  { timeout: 10000 },
  async (t) => {
    const aborted = deferred<void>();
    const f = await fixture(t, async (request, context) => {
      const { lane } = (await request.json()) as { lane: string };
      if (lane === "second") return new Response("second succeeds");
      context.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
        }),
      );
    });
    await loginCodex(f.local);
    const secondSource = createProviderAccountRelaySource(f.local);
    t.after(() => secondSource.dispose());
    const first = request("first");
    await f.proxy.open(first);
    const firstChunk = await f.proxy.read(first.requestId);
    assert.equal(firstChunk.done, false);
    f.source.dispose();
    await aborted.promise;
    await assert.rejects(f.proxy.read(first.requestId));
    const second = request("second");
    assert.equal((await secondSource.service.open(second)).status, 200);
    let text = "";
    while (true) {
      const chunk = await secondSource.service.read(second.requestId);
      if (chunk.done) break;
      text += Buffer.from(chunk.data, "base64").toString("utf8");
    }
    assert.equal(text, "second succeeds");
    assert.equal((await f.local.getView()).accounts.length, 1);
    const account = JSON.parse(f.saved.get("model-provider-oauth-accounts-v1")!).accounts[0];
    assert.equal(
      account.grant.revision,
      2,
      "both requests refreshed the one local credential owner",
    );
  },
);

test("an unattached or closed remote adapter cannot keep waiting or mint a ticket", async () => {
  const remote = new RemoteProviderAccounts();
  const waiting = assert.rejects(remote.getView(), /closed/);
  remote.dispose();
  await waiting;
  await assert.rejects(resolveAuth(remote, "codex", "fixture-model"), /closed/);
});

test("manually configured OAuth model IDs reuse the original fixed endpoint and disabled accounts remain unavailable", async (t) => {
  const f = await fixture(t);
  await loginCodex(f.local);
  const auth = await resolveAuth(
    f.remote,
    "codex",
    "manually-added",
    undefined,
    '["ssh-workspace","remote-session"]',
  );
  const response = await fetch(`${auth.baseURL}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "manually-added" }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const account = (await f.local.getView()).accounts[0]!;
  await f.local.setAccountEnabled(account.connectionId, false);
  await assert.rejects(resolveAuth(f.remote, "codex", "fixture-model"));
  await assert.rejects(resolveAuth(f.remote, "codex", "manually-added"));
});

test("empty successes and upstream rate-limit responses retain status, headers and body through the relay", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () =>
    ++calls === 1
      ? new Response(null, { status: 204 })
      : new Response('{"error":"fixture rate limit"}', {
          status: 429,
          headers: { "retry-after": "12", "content-type": "application/json" },
        }),
  );
  await loginCodex(f.local);
  for (const status of [204, 429]) {
    const auth = await resolveAuth(
      f.remote,
      "codex",
      "fixture-model",
      undefined,
      '["ssh-workspace","remote-session"]',
    );
    const response = await fetch(`${auth.baseURL}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model" }),
    });
    assert.equal(response.status, status);
    if (status === 204) assert.equal(await response.text(), "");
    else {
      assert.equal(response.headers.get("retry-after"), "12");
      assert.deepEqual(await response.json(), { error: "fixture rate limit" });
    }
  }
});

function routingContext() {
  return {
    capability: "single-attempt-routing-v1" as const,
    workspaceKey: "fixture-workspace",
    sessionId: "fixture-session",
    attemptId: routingUuid(),
    turnId: routingUuid(),
    tokens: { total: 8192, quality: "bound" as const },
  };
}
function resolveAuth(
  service: Pick<ProviderAccounts, "resolveRequestAuth">,
  ...args: Parameters<ProviderAccounts["resolveRequestAuth"]>
) {
  return service.resolveRequestAuth(
    args[0],
    args[1],
    args[2],
    args[3] ?? "fixture-session",
    args[4] ?? routingContext(),
  );
}
