import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderConfigRuntime } from "./providerConfigRuntime.js";
import { ProviderRuntime } from "./providerRuntime.js";

test("proxy library and assignments survive real file writes, unrelated edits and a cold runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-proxy-persistence-"));
  const personalFilePath = join(directory, "personal.json"),
    lcodeBuiltinFilePath = join(directory, "builtin.json");
  await writeFile(
    lcodeBuiltinFilePath,
    await readFile(new URL("../../../../config/provider/lcode-builtin.json", import.meta.url)),
  );
  const runtimes: ProviderRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const open = () => {
    const runtime = new ProviderRuntime({
      configRuntime: createProviderConfigRuntime({
        personalFilePath,
        lcodeBuiltinFilePath,
        watch: false,
        personalPollingIntervalMs: false,
      }),
    });
    runtimes.push(runtime);
    return runtime;
  };
  const initial = open();
  await initial.start();
  await initial.providerSettings.importProxyProfiles(
    "http://fixture:password@proxy.example:7890\nsocks5://proxy.example:1080",
  );
  const profiles = (await initial.providerSettings.getView()).proxyProfiles!;
  assert.equal(profiles.length, 2);
  const created = await initial.providerSettings.createPersonalProvider({
    providerName: "Proxy fixture",
    initialConfig: {
      api: { type: "openai-chat-completions", baseUrl: "https://provider.fixture.invalid/v1" },
      access: { type: "api-key", apiKey: "fixture-key" },
    },
  });
  await initial.providerSettings.setProviderNetwork(created.providerId, {
    mode: "profile",
    profileId: profiles[0]!.id,
  });
  await initial.providerSettings.addPersonalModel(created.providerId, "fixture-model", {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"], map: "{}" },
      maxOutputTokens: { max: 8192, map: "{}" },
    },
  });
  await initial.providerSettings.importProxyProfiles(
    "https://proxy.example:8443\nhttp://fixture:password@proxy.example:7890",
  );
  assert.equal((await initial.providerSettings.getView()).proxyProfiles!.length, 3);
  const persisted = JSON.parse(await readFile(personalFilePath, "utf8"));
  assert.equal(persisted.config.proxyProfiles.length, 3);
  initial.dispose();
  const cold = open();
  await cold.start();
  const view = await cold.providerSettings.getView();
  assert.equal(view.proxyProfiles!.length, 3);
  assert.deepEqual(
    view.providers.find((provider) => provider.providerId === created.providerId)!.effectiveConfig
      .network,
    { mode: "profile", profileId: profiles[0]!.id },
  );
  const resolved = cold.registryService
    .getSnapshot()!
    .resolution.registryProviders.find((provider) => provider.providerId === created.providerId)!;
  assert.ok(resolved.config.network?.mode === "custom");
  assert.equal(resolved.config.network.httpProxy, profiles[0]!.httpProxy);
});
