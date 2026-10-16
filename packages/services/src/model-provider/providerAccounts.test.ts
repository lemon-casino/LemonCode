import { randomUUID as routingUuid } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccounts } from "./providerAccounts.js";
import { createProviderAccountsSource } from "./providerAccountsSource.js";
import {
  ModelConfigRules,
  ModelConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  createAccountProviderConfigSnapshot,
  parseProviderConfig,
} from "@lcode/provider";
import type { AuthDriver, AuthGrant } from "@lcode/provider-node";

test("same supplier keeps independent accounts, fails over and never changes API credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-accounts-"));
  const saved = new Map([["existing-api", "unchanged"]]);
  let sequence = 0;
  const calls: string[] = [];
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async (): Promise<AuthDriver> => ({
      routingSingleAttempt: true,
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async (): Promise<AuthGrant> => ({
          type: "oauth",
          access: String(++sequence),
          displayName: "fixture@example.invalid",
        }),
      }),
      models: async () => [
        {
          id: "model",
          name: "Model",
          protocol: "openai-chat-completions",
          baseURL: "https://fixture.invalid/v1",
          contextWindow: 200000,
          maxOutputTokens: 32000,
          reasoningEfforts: ["high", "low"],
          inputModalities: ["text", "image", "pdf"],
        },
      ],
      fetch: async (_request, context) => {
        const access = (await context.read())!.access!;
        calls.push(access);
        return new Response(access, {
          status: access === "1" ? 429 : 200,
          headers: { "x-lcode-rate-limit-scope": "key" },
        });
      },
    }),
  });
  try {
    for (let i = 0; i < 2; i++) {
      const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
      await service.completeAuthorization(attempt.attemptId, "code");
    }
    const view = await service.getView();
    assert.equal(view.accounts.length, 2);
    assert.equal(saved.get("existing-api"), "unchanged");
    assert.equal(JSON.stringify(view).includes('"access"'), false);
    const empty = createAccountProviderConfigSnapshot("test", ProviderConfigMap.empty());
    const source = createProviderAccountsSource(
      { read: async () => empty, refresh: async () => empty, onDidChange: () => () => {} },
      service,
    );
    const projected = await source.read();
    const api = parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "preserved" },
      api: { type: "openai-chat-completions", baseUrl: "https://api.invalid/v1" },
    });
    const personal = new ProviderConfigMap([["existing", api]]);
    const resolution = new ProviderConfigResolver().resolve({
      lcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders: personal,
      lcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: ModelConfigRules.empty(),
      accountProviders: projected.providers,
      accountModelRules: projected.modelRules,
    });
    assert.deepEqual(resolution.issues, []);
    assert.equal(resolution.registryProviders.length, 1);
    assert.equal(resolution.registryProviders[0]!.providerId, "oauth:fixture");
    assert.equal(resolution.registryProviders[0]!.models[0]!.modelId, "model");
    assert.equal(projected.providers.getRule("oauth:fixture")!.providerName, "Fixture");
    const inherited = resolution.registryProviders[0]!.models[0]!.config;
    assert.equal(inherited.properties.contextWindow, 200000);
    assert.equal(inherited.properties.inputFormat.supportsPdf, true);
    assert.deepEqual(inherited.optionSpecs.reasoningLevel.values, ["default", "low", "high"]);
    const refreshed = await source.refresh("user");
    const customized = new ProviderConfigResolver().resolve({
      lcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders: personal,
      lcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "oauth:fixture",
          modelId: "model",
          config: ModelConfig.fromData({
            properties: { contextWindow: 160000, interactionProtocol: "native-tool-calls" },
            optionSpecs: {
              maxOutputTokens: { max: 16000, map: '{"max_tokens": maxOutputTokens}' },
            },
          }),
        },
      ]),
      accountProviders: refreshed.providers,
      accountModelRules: refreshed.modelRules,
    });
    const edited = customized.registryProviders[0]!.models[0]!.config;
    assert.equal(edited.properties.contextWindow, 160000);
    assert.equal(edited.optionSpecs.maxOutputTokens.max, 16000);
    assert.deepEqual(personal.get("existing")!.toJSON(), api.toJSON());
    const auth = await resolveAuth(service, "fixture", "model", "openai-chat-completions");
    const response = await fetch(`${auth.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(await response.text(), "1");
    const nextAuth = await resolveAuth(service, "fixture", "model", "openai-chat-completions");
    const next = await fetch(nextAuth.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + nextAuth.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: "model", messages: [] }),
    });
    assert.equal(await next.text(), "2");
    assert.deepEqual(calls, ["1", "2"]);
    await service.removeAccount(view.accounts[1]!.connectionId);
    const remaining = await service.getView();
    assert.equal(remaining.accounts.length, 1);
    assert.equal(saved.get("existing-api"), "unchanged");
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled authorization rejects late success without resurrecting an account", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-cancel-"));
  let complete!: (grant: AuthGrant) => void;
  const saved = new Map<string, string>();
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: {
      load: async (k) => saved.get(k) ?? null,
      save: async (k, v) => {
        saved.set(k, v);
      },
      delete: async (k) => {
        saved.delete(k);
      },
    },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async () => ({
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "auto",
        complete: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      }),
      models: async () => [],
      fetch: async () => new Response(),
    }),
  });
  try {
    const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
    await service.cancelAuthorization(attempt.attemptId);
    complete({ type: "oauth", access: "late" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await service.getView()).accounts.length, 0);
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
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
