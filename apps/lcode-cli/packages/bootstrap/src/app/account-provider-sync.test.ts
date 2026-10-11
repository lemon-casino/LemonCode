import assert from "node:assert/strict";
import test from "node:test";
import { updateAccountProviderConfig } from "../lcode-protocol/account-provider-config.js";
import type { LCodeProtocolAgentServerContext } from "../lcode-protocol/server-types.js";
import type { AccountProviderConfigSnapshot } from "@lcode/provider";

const providers = Object.fromEntries(
  ["zai", "codex"].map((channelId) => [
    `oauth:${channelId}`,
    {
      group: "standard-personal",
      access: { type: "oauth-account", channelId },
      api: { type: "openai-responses", baseUrl: "https://oauth.invalid/v1" },
      builtinModelIds: ["fixture-model"],
    },
  ]),
);

test("real Agent account-sync handler preserves OAuth model metadata and accepts old envelopes", async () => {
  let received: AccountProviderConfigSnapshot | undefined;
  const context = {
    deps: {
      syncAccountProviderConfig: async (snapshot: AccountProviderConfigSnapshot) => {
        received = snapshot;
        return true;
      },
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const modelRules = [
    {
      providerId: "oauth:codex",
      modelId: "fixture-model",
      config: {
        properties: { contextWindow: 200000 },
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: '{"reasoning": {"effort": reasoningLevel}}',
          },
        },
      },
    },
  ];
  const result = await updateAccountProviderConfig(context, {
    revision: "oauth-1",
    basedOnLCodeBuiltinRevision: "builtin",
    providers,
    states: {},
    modelRules,
  });
  assert.equal(result.providerCount, 2);
  assert.equal(
    received?.modelRules?.getExact("oauth:codex", "fixture-model")?.properties?.contextWindow,
    200000,
  );
  assert.deepEqual(
    received?.modelRules?.getExact("oauth:codex", "fixture-model")?.optionSpecs?.reasoningLevel
      ?.values,
    ["low", "high"],
  );
  await updateAccountProviderConfig(context, {
    revision: "legacy",
    basedOnLCodeBuiltinRevision: "builtin",
    providers: { legacy: { access: { type: "zhipu-account", entitled: false } } },
    states: {},
  });
  assert.equal(received?.modelRules, undefined);
  assert.equal(received?.providers.get("legacy")?.access?.type, "zhipu-account");
  await assert.rejects(
    updateAccountProviderConfig(context, {
      revision: "invalid",
      basedOnLCodeBuiltinRevision: "builtin",
      providers,
      states: {},
      modelRules: [{ ...modelRules[0], providerId: "other" }],
    }),
  );
  assert.equal(received?.revision, "legacy");
});
