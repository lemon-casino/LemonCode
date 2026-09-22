import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  applyProviderApiKeysToDraft,
  resolvePendingProviderDraftSave,
} from "./ProviderDraftSave.js";

const apiKeys = [
  { id: "primary", label: "Primary", apiKey: "key-a", enabled: true },
  { id: "backup", label: "Backup", apiKey: "key-b", enabled: true },
] as const;

function createProvider(): ProviderSettingsFormProvider {
  return {
    providerId: "provider-a",
    providerName: "Provider A",
    templateId: "openai",
    enabled: true,
    executable: true,
    hasPersonalConfig: true,
    personalConfig: {
      access: { type: "api-key", apiKey: "key-a" },
    },
    config: {
      access: {
        type: "api-key",
        apiKey: "key-a",
        apiKeys,
        apiKeyManagementUrl: "https://example.com/keys",
      },
      api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
    },
    models: [],
  };
}

test("legacy API key draft save preserves the effective multi-key list", () => {
  const result = resolvePendingProviderDraftSave({
    provider: createProvider(),
    draft: {
      nameValue: "Provider A",
      apiFormat: "openai-chat-completions",
      baseUrlValue: "https://example.com/v1",
      apiKeyValue: "key-b",
    },
    now: Date.now,
  });

  assert.deepEqual(result?.personalConfig.access, {
    type: "api-key",
    apiKey: "key-b",
    apiKeys,
  });
});

test("key list save updates the draft without materializing inherited access fields", () => {
  const result = applyProviderApiKeysToDraft(createProvider(), apiKeys);

  assert.deepEqual(result.personalConfig.access, {
    type: "api-key",
    apiKey: "key-a",
    apiKeys,
  });
  assert.deepEqual(result.config.access, {
    type: "api-key",
    apiKey: "key-a",
    apiKeys,
    apiKeyManagementUrl: "https://example.com/keys",
  });
});
