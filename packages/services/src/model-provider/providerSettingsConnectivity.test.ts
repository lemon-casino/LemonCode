import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFacade, ProviderSettingsProviderView } from "@lcode/provider";
import {
  lcodeProviderTestModelConnectivityParamsSchema,
  lcodeProviderTestModelConnectivityResultSchema,
  type ModelConnectivityResult,
} from "@lcode/shared";
import {
  createProviderSettingsService,
  type ProviderSettingsConnectivityTestInput,
} from "./providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./providerSettingsConnectivity.js";

const request = {
  workspacePath: "/workspace",
  workspaceIdentity: "remote-workspace",
  providerId: "custom",
  modelId: "unregistered",
};

function createHarness(overrides: Partial<ProviderSettingsProviderView> = {}) {
  const calls: ProviderSettingsConnectivityTestInput[] = [];
  const provider: ProviderSettingsProviderView = {
    providerId: "custom",
    enabled: true,
    executable: false,
    effectiveConfig: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fixture-key" },
      api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
    },
    issues: [],
    models: [],
    ...overrides,
  };
  let barriers = 0;
  const facade = {
    onDidChange: () => () => undefined,
    getView: () => ({ providers: [provider] }),
    waitForProviderOperations: async () => {
      barriers += 1;
    },
  } as unknown as ProviderSettingsFacade;
  const service = createProviderSettingsService(facade, undefined, async (input) => {
    calls.push(input);
    return { success: true };
  });
  return { service, calls, provider, barriers: () => barriers };
}

test("temporary connectivity forwards an unregistered model without requiring a published provider", async () => {
  const harness = createHarness();
  const before = JSON.stringify(harness.provider);
  assert.deepEqual(await harness.service.testModelConnectivity({ ...request, mode: "temporary" }), {
    success: true,
  });
  assert.deepEqual(harness.calls, [{ ...request, mode: "temporary" }]);
  assert.equal(harness.barriers(), 1);
  assert.equal(JSON.stringify(harness.provider), before);
});

test("temporary connectivity admits disabled models but default connectivity remains strict", async () => {
  const harness = createHarness({
    models: [
      {
        kind: "candidate",
        modelId: request.modelId,
        builtin: false,
        effectiveBuiltinConfig: {},
        effectiveConfig: { enabled: false },
        enabled: false,
        executable: false,
        selectable: false,
        issues: [],
      },
    ],
  });
  const normal = await harness.service.testModelConnectivity(request);
  assert.equal(normal.success, false);
  assert.equal(harness.calls.length, 0);
  assert.equal(
    (await harness.service.testModelConnectivity({ ...request, mode: "temporary" })).success,
    true,
  );
  assert.equal(harness.provider.models[0]?.enabled, false);
});

test("temporary connectivity still rejects disabled or incomplete providers", async () => {
  for (const overrides of [
    { enabled: false },
    {
      issues: [{ code: "required-field-missing" as const, path: ["api"], message: "missing api" }],
    },
  ]) {
    const harness = createHarness(overrides);
    assert.equal(
      (await harness.service.testModelConnectivity({ ...request, mode: "temporary" })).success,
      false,
    );
    assert.equal(harness.calls.length, 0);
  }
});

test("connectivity executor receives only identity and optional mode, and keeps failures local", async () => {
  const calls: unknown[] = [];
  const tester = createProviderSettingsConnectivityTester({
    testModelConnectivity: async (input) => {
      calls.push(input);
      if (input.selection.modelId === "broken") throw new Error("probe rejected");
      return { success: true };
    },
  });
  assert.deepEqual(await tester({ ...request, mode: "temporary" }), { success: true });
  assert.deepEqual(calls[0], {
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
    selection: { providerId: request.providerId, modelId: request.modelId },
    mode: "temporary",
  });
  assert.deepEqual(await tester({ ...request, modelId: "broken", mode: "temporary" }), {
    success: false,
    error: { message: "probe rejected" },
  });
  assert.deepEqual(await tester(request), { success: true });
  assert.equal(Object.hasOwn(calls[2] as object, "mode"), false);
});

test("connectivity service preserves typed failures from the target environment", async () => {
  const result = {
    success: false,
    error: { code: "model-not-found", message: "Model rejected by provider." },
  } as const satisfies ModelConnectivityResult;
  const tester = createProviderSettingsConnectivityTester({
    testModelConnectivity: async () => result,
  });
  assert.deepEqual(await tester({ ...request, mode: "temporary" }), result);
  const facade = {
    onDidChange: () => () => undefined,
    getView: () => ({
      providers: [
        { providerId: "custom", enabled: true, executable: false, issues: [], models: [] },
      ],
    }),
    waitForProviderOperations: async () => undefined,
  } as unknown as ProviderSettingsFacade;
  const service = createProviderSettingsService(facade, undefined, tester);
  assert.deepEqual(await service.testModelConnectivity({ ...request, mode: "temporary" }), result);
});

test("strict connectivity result schema accepts old success and typed failures but rejects raw error details", () => {
  const schema = lcodeProviderTestModelConnectivityResultSchema;
  for (const result of [
    { success: true },
    { success: false, error: { message: "unknown failure" } },
    { success: false, error: { code: "model-not-found", message: "Model rejected by provider." } },
    { success: false, error: { code: "provider-unavailable", message: "provider disabled" } },
    { success: false, error: { code: "model-unavailable", message: "model disabled" } },
  ])
    assert.equal(schema.safeParse(result).success, true);
  for (const result of [
    { success: false },
    { success: false, error: { message: "failure", code: "model_not_found" } },
    { success: false, error: { message: "failure", responseBody: "private fixture" } },
    { success: false, error: { message: "failure", cause: {} } },
    { success: true, error: { message: "failure" } },
    { success: false, error: { message: "failure" }, headers: {} },
  ])
    assert.equal(schema.safeParse(result).success, false);
});

test("connectivity protocol accepts only temporary mode and still rejects inline configuration", () => {
  const params = {
    workspace: { workspacePath: "/workspace", workspaceKey: "/workspace" },
    selection: { providerId: "custom", modelId: "unregistered" },
  };
  assert.equal(lcodeProviderTestModelConnectivityParamsSchema.safeParse(params).success, true);
  assert.equal(
    lcodeProviderTestModelConnectivityParamsSchema.safeParse({ ...params, mode: "temporary" })
      .success,
    true,
  );
  assert.equal(
    lcodeProviderTestModelConnectivityParamsSchema.safeParse({ ...params, mode: "anything" })
      .success,
    false,
  );
  assert.equal(
    lcodeProviderTestModelConnectivityParamsSchema.safeParse({
      ...params,
      mode: "temporary",
      providerConfig: {},
    }).success,
    false,
  );
});
