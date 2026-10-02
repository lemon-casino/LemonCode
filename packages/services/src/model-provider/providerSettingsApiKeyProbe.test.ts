import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ProviderSettingsFacade } from "@lcode/provider";
import { createProviderSettingsService } from "./providerFacadeServices.js";

test("service progress carries its operation ID; cancel and dispose abort real fetch without dispatching the full queue", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests <= 3) {
      response.statusCode = [401, 200, 500][requests - 1]!;
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    group: "standard-personal",
    access: {
      type: "api-key",
      apiKeys: Array.from({ length: 100_000 }, (_, index) => ({
        id: String(index),
        apiKey: `fixture-${index}`,
        enabled: true,
      })),
    },
    api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${address.port}` },
  } as const;
  const facade = {
    onDidChange: () => () => {},
    getView: () => ({ providers: [{ providerId: "test", effectiveConfig: config }] }),
    waitForProviderOperations: async () => {},
  } as unknown as ProviderSettingsFacade;
  const service = createProviderSettingsService(facade);
  t.after(() => {
    service.dispose();
    server.closeAllConnections();
    server.close();
  });
  const events: string[] = [];
  const subscription = service.onDidProbeApiKeys((event) => {
    assert.equal(event.operationId, "operation-a");
    assert.equal(event.providerId, "test");
    assert.ok(event.results.length <= 64);
    events.push(...event.results.map((result) => result.status));
    if (event.completed === 3) void service.cancelApiKeyProbe("test", "operation-a");
  });
  assert.deepEqual(
    await service.probeApiKeys("test", [], { operationId: "operation-a", streamResults: true }),
    [],
  );
  assert.deepEqual(events.sort(), ["error", "invalid", "valid"]);
  assert.ok(requests <= 11);
  subscription.dispose();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  service.onDidProbeApiKeys(() => started());
  const second = service.probeApiKeys("test", [], {
    operationId: "operation-b",
    streamResults: true,
  });
  await ready;
  service.dispose();
  assert.deepEqual(await second, []);
});
