import { randomUUID as routingUuid } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelConfig,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  createAccountProviderConfigSnapshot,
  parseAccountModelConfigRules,
  parseAccountProviderConfigMap,
  serializeAccountProviderConfigSnapshot,
} from "@lcode/provider";
import { lcodeProviderUpdateAccountConfigParamsSchema } from "@lcode/shared";
import type { AuthWireProtocol } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";
import { createProviderAccountsSource } from "./providerAccountsSource.js";
import { PROVIDER_AUTH_CHANNELS } from "./providerAccountStoreSchema.js";

const protocols: readonly AuthWireProtocol[] = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
];
const paths = {
  "openai-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
};

test("every registered channel survives Host sync, process Registry and authenticated model routing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-sync-"));
  const saved = new Map<string, string>();
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
    factory: async (channelId) => {
      const index = PROVIDER_AUTH_CHANNELS.findIndex((channel) => channel.id === channelId);
      const protocol = protocols[index % protocols.length]!;
      return {
        routingSingleAttempt: true,
        methods: async () => [
          { id: "local", label: "Fixture local sign-in", type: "oauth", kind: "local" },
        ],
        authorize: async () => ({
          method: "code",
          complete: async () => ({
            type: "oauth",
            access: `fixture-secret-${channelId}`,
            accountId: `fixture-${channelId}`,
          }),
        }),
        models: async () => [
          {
            id: "fixture-model",
            name: "Fixture model",
            protocol,
            baseURL: "https://fixture.invalid/v1",
            contextWindow: 200000,
            maxOutputTokens: 32000,
            reasoningEfforts: ["high", "low"],
            inputModalities: ["text", "image"],
          },
        ],
        fetch: async (request, context) => {
          assert.equal((await context.read())?.access, `fixture-secret-${channelId}`);
          assert.equal(new URL(request.url).pathname, `/v1${paths[protocol]}`);
          calls.push(channelId);
          return new Response(JSON.stringify({ channelId }), {
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  });
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  for (const channel of PROVIDER_AUTH_CHANNELS) {
    const attempt = await service.startAuthorization({ channelId: channel.id, methodId: "local" });
    const completed = await service.completeAuthorization(attempt.attemptId, "fixture");
    assert.equal(completed.status, "completed", channel.id);
  }
  const empty = createAccountProviderConfigSnapshot("builtin", ProviderConfigMap.empty());
  const source = createProviderAccountsSource(
    { read: async () => empty, refresh: async () => empty, onDidChange: () => () => {} },
    service,
  );
  const projected = await source.read();
  const envelope = lcodeProviderUpdateAccountConfigParamsSchema.parse(
    serializeAccountProviderConfigSnapshot(projected),
  );
  assert.equal(JSON.stringify(envelope).includes("fixture-secret"), false);
  const providers = parseAccountProviderConfigMap(envelope.providers);
  const modelRules = parseAccountModelConfigRules(envelope.modelRules, providers);
  const accountSource = new MutableAccountProviderConfigSource();
  accountSource.replace({ ...envelope, providers, modelRules });
  const config = {
    revision: "config",
    lcodeBuiltinRevision: "builtin",
    personalRevision: "personal",
    lcodeBuiltinProviders: ProviderConfigMap.empty(),
    lcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    lcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "oauth:zai",
        modelId: "fixture-model",
        config: ModelConfig.fromData({ properties: { contextWindow: 160000 } }),
      },
    ]),
  };
  const registry = new ProviderRegistryService({
    configSource: { read: async () => config, onDidChange: () => () => {} },
    accountSource,
  });
  t.after(() => registry.dispose());
  await registry.start();
  assert.equal(registry.listProviders().length, PROVIDER_AUTH_CHANNELS.length);
  assert.equal(
    registry.getSnapshot()?.account.modelRules?.rules().length,
    PROVIDER_AUTH_CHANNELS.length,
  );
  for (const [index, channel] of PROVIDER_AUTH_CHANNELS.entries()) {
    const providerId = `oauth:${channel.id}`;
    const model = registry.getModel(providerId, "fixture-model")!;
    assert.ok(model, channel.id);
    assert.equal(model.config.properties.contextWindow, channel.id === "zai" ? 160000 : 200000);
    assert.equal(model.config.properties.inputFormat.supportsImage, true);
    assert.deepEqual(model.config.optionSpecs.reasoningLevel.values, ["default", "low", "high"]);
    assert.equal(model.config.optionSpecs.maxOutputTokens.max, 32000);
    const recommended = registry
      .getSnapshot()
      ?.resolution.resolvedProviders.find((provider) => provider.providerId === providerId)
      ?.models[0]?.effectiveBuiltinConfig;
    assert.equal(recommended?.properties?.contextWindow, 200000, `smart defaults: ${channel.id}`);
    const protocol = protocols[index % protocols.length]!;
    const auth = await resolveAuth(service, channel.id, model.modelId, protocol);
    const response = await fetch(`${auth.baseURL}${paths[protocol]}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: model.modelId, stream: false }),
    });
    assert.equal(response.status, 200, channel.id);
    assert.deepEqual(await response.json(), { channelId: channel.id });
  }
  assert.deepEqual(
    calls,
    PROVIDER_AUTH_CHANNELS.map((channel) => channel.id),
  );
  assert.throws(() =>
    parseAccountModelConfigRules(
      [{ providerId: "oauth:missing", modelId: "fixture-model", config: {} }],
      providers,
    ),
  );
  assert.throws(() =>
    parseAccountModelConfigRules(
      [{ providerId: "oauth:zai", modelId: "outside-directory", config: {} }],
      providers,
    ),
  );
  assert.throws(() => parseAccountModelConfigRules([{ modelMatch: ".*", config: {} }], providers));
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
