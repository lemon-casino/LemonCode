import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, parsePersonalProviderConfigMap, isApiKeyAccess } from "@lcode/provider";
import { encodeProviderConfigFile } from "@lcode/provider-node";
import { createProviderConfigRuntime } from "./providerConfigRuntime.js";
import { ProviderRuntime } from "./providerRuntime.js";

test(
  "100k-key runtime starts, aborts active checks on shutdown, and reopens the unchanged configuration",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-large-runtime-"));
    let ready!: () => void;
    const requestsReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let requests = 0;
    const server = createServer(() => {
      if (++requests === 8) ready();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const personalFilePath = join(directory, "personal.json");
    const builtinFilePath = join(directory, "builtin.json");
    await writeFile(
      builtinFilePath,
      await readFile(new URL("../../../../config/provider/lcode-builtin.json", import.meta.url)),
    );
    const config = {
      group: "standard-personal",
      access: {
        type: "api-key",
        apiKeys: Array.from({ length: 100_000 }, (_, index) => ({
          id: String(index),
          apiKey: `synthetic-${"x".repeat(180)}-${index}`,
          label: `Fixture ${index}`,
          enabled: true,
        })),
      },
      api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${address.port}` },
    };
    const text = JSON.stringify(
      encodeProviderConfigFile({
        providers: parsePersonalProviderConfigMap({
          providerRules: [{ providerId: "large-test", config }],
        }),
        models: ModelConfigRules.empty(),
      }),
      null,
      2,
    );
    await writeFile(personalFilePath, text);
    const runtimes: ProviderRuntime[] = [];
    const create = () => {
      const runtime = new ProviderRuntime({
        configRuntime: createProviderConfigRuntime({
          personalFilePath,
          lcodeBuiltinFilePath: builtinFilePath,
          watch: false,
          personalPollingIntervalMs: false,
        }),
      });
      runtimes.push(runtime);
      return runtime;
    };
    t.after(async () => {
      for (const runtime of runtimes) runtime.dispose();
      server.closeAllConnections();
      server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const startedAt = performance.now();
    const first = create();
    assert.strictEqual(first.start(), first.start());
    await first.start();
    const startupMs = performance.now() - startedAt;
    const probe = first.providerSettings.probeApiKeys("large-test", [], {
      operationId: "shutdown-check",
      streamResults: true,
    });
    await requestsReady;
    const stoppedAt = performance.now();
    first.dispose();
    assert.deepEqual(await probe, []);
    const shutdownMs = performance.now() - stoppedAt;
    assert.equal(requests, 8);
    const second = create();
    await second.start();
    const provider = (await second.providerSettings.getView()).providers.find(
      (entry) => entry.providerId === "large-test",
    );
    assert.ok(isApiKeyAccess(provider?.effectiveConfig.access));
    assert.equal(provider.apiKeysOmitted, true);
    assert.equal(provider.apiKeySummary?.total, 100_000);
    assert.equal(provider.effectiveConfig.access.apiKeys, undefined);
    assert.equal(
      JSON.parse(await second.providerSettings.getApiKeysJson("large-test")).length,
      100_000,
    );
    assert.equal(await readFile(personalFilePath, "utf8"), text);
    t.diagnostic(
      `Synthetic Provider Runtime startup ${Math.round(startupMs)}ms; active probe shutdown ${Math.round(shutdownMs)}ms; reopen succeeded`,
    );
  },
);
