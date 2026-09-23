import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import type { ZCodePluginsSetEnabledResult } from "@zcode/shared";
import { createPluginManagementService } from "./pluginManagementService.js";

const CUA_RESULT = {
  enabled: true,
  plugin: { id: ZCODE_CUA_OFFICIAL_PLUGIN_ID },
} as unknown as ZCodePluginsSetEnabledResult;

const TARGET = {
  workspacePath: "C:\\workspace",
  workspaceIdentity: "desktop-local:test",
  pluginId: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  enabled: true,
} as const;

function createService(input: {
  setPluginEnabled?: () => Promise<ZCodePluginsSetEnabledResult>;
  disposeWorkspace?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}) {
  return createPluginManagementService({
    zcodeAgentService: {
      setPluginEnabled: input.setPluginEnabled ?? (async () => CUA_RESULT),
      disposeWorkspace: input.disposeWorkspace ?? (async () => undefined),
    } as never,
  });
}

test("successful Computer Use toggle invalidates only the target workspace runtime", async () => {
  const disposed: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  const service = createService({
    disposeWorkspace: async (params) => void disposed.push(params),
  });

  const result = await service.setPluginEnabled(TARGET);

  assert.equal(result, CUA_RESULT);
  assert.deepEqual(disposed, [
    {
      workspacePath: TARGET.workspacePath,
      workspaceIdentity: TARGET.workspaceIdentity,
    },
  ]);
});

test("other plugin toggles do not use the Computer Use runtime invalidation path", async () => {
  let disposeCount = 0;
  const service = createService({
    disposeWorkspace: async () => void (disposeCount += 1),
  });

  await service.setPluginEnabled({
    ...TARGET,
    pluginId: "example@marketplace",
  });

  assert.equal(disposeCount, 0);
});

test("failed Computer Use config write does not invalidate the workspace runtime", async () => {
  let disposeCount = 0;
  const service = createService({
    setPluginEnabled: async () => {
      throw new Error("config write failed");
    },
    disposeWorkspace: async () => void (disposeCount += 1),
  });

  await assert.rejects(service.setPluginEnabled(TARGET), /config write failed/u);
  assert.equal(disposeCount, 0);
});

test("runtime cleanup failure does not roll back a persisted Computer Use toggle", async () => {
  const service = createService({
    disposeWorkspace: async () => {
      throw new Error("cleanup failed");
    },
  });

  assert.equal(await service.setPluginEnabled(TARGET), CUA_RESULT);
});
