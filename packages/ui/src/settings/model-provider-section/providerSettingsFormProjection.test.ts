import assert from "node:assert/strict";
import test from "node:test";
import { isApiKeyAccess } from "@lcode/provider";
import type { ProviderSettingsView } from "@lcode/services";
import { projectProviderSettingsViewToFormProviders } from "../../lib/providerSettingsFormProjection.js";
import {
  applyProviderApiKeysToDraft,
  resolvePendingProviderDraftSave,
} from "./ProviderDraftSave.js";

test("large settings projections share immutable configuration; editing a key draft preserves the accepted snapshot", () => {
  const keys = Object.freeze(
    Array.from({ length: 100_000 }, (_, index) =>
      Object.freeze({ id: String(index), apiKey: `fixture-${index}`, enabled: true }),
    ),
  );
  const config = Object.freeze({
    group: "standard-personal" as const,
    access: Object.freeze({ type: "api-key" as const, apiKeys: keys }),
  });
  const view = {
    revision: 1,
    providerTemplates: [],
    providerOrder: ["test"],
    providers: [
      {
        providerId: "test",
        enabled: true,
        executable: false,
        issues: [],
        models: [],
        effectiveConfig: config,
        personalConfig: config,
      },
    ],
  } satisfies ProviderSettingsView;
  const [provider] = projectProviderSettingsViewToFormProviders(view);
  assert.strictEqual(provider!.config, config);
  assert.strictEqual(provider!.personalConfig, config);
  const edited = applyProviderApiKeysToDraft(provider!, [{ ...keys[0]!, enabled: false }]);
  assert.equal(keys.length, 100_000);
  assert.equal(keys[0]!.enabled, true);
  assert.notStrictEqual(edited.config, config);
});

test("editing an endpoint does not traverse the provider's large key list", () => {
  let accesses = 0;
  const keys = new Proxy([{ id: "first", apiKey: "fixture", enabled: true }], {
    get(target, property, receiver) {
      accesses++;
      return Reflect.get(target, property, receiver);
    },
  });
  const config = {
    group: "standard-personal" as const,
    access: { type: "api-key" as const, apiKey: "fixture", apiKeys: keys },
    api: { type: "openai-chat-completions" as const, baseUrl: "http://localhost/old" },
  };
  const [provider] = projectProviderSettingsViewToFormProviders({
    revision: 1,
    providerTemplates: [],
    providerOrder: [],
    providers: [
      {
        providerId: "test",
        enabled: true,
        executable: false,
        issues: [],
        models: [],
        effectiveConfig: config,
        personalConfig: config,
      },
    ],
  });
  const edited = resolvePendingProviderDraftSave({
    provider: provider!,
    draft: {
      nameValue: "test",
      apiFormat: "openai-chat-completions",
      baseUrlValue: "http://localhost/new",
      apiKeyValue: "fixture",
    },
    now: Date.now,
  });
  assert.equal(edited?.config.api?.baseUrl, "http://localhost/new");
  assert.ok(edited && isApiKeyAccess(edited.config.access));
  assert.strictEqual(edited.config.access.apiKeys, keys);
  assert.equal(accesses, 0);
});
