import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Event } from "@lcode/rpc";
import { lcodeProtocolMethods } from "@lcode/shared";
import { setDataBaseDir } from "../paths.js";
import { createLCodeAgentService } from "./lcodeAgentService.js";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";
import type { LCodeProtocolClient } from "./lcodeProtocolClient.js";

test("PC-01 API-only first temporary model reaches the original runtime without granting ordinary execution", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "first-api-model-"));
  setDataBaseDir(dir);
  const calls: { method: string; params: unknown }[] = [];
  const targets: unknown[] = [];
  const client = {
    isDisposed: false,
    onNotification: Event.None,
    onRequest: Event.None,
    onClose: Event.None,
    request: async (
      method: string,
      params: unknown,
      schema: { parse(value: unknown): unknown },
    ) => {
      calls.push({ method, params });
      return schema.parse({ success: true });
    },
  } as unknown as LCodeProtocolClient;
  t.mock.method(LCodeAgentProcessManager.prototype, "getClient", async (target: unknown) => {
    targets.push(target);
    return client;
  });
  const ready = t.mock.method(LCodeAgentProcessManager.prototype, "markReady", () => {});
  const service = createLCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => ({ revision: 30, providers: [] }) },
  });
  t.after(async () => {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });
  const target = {
    workspacePath: dir,
    workspaceIdentity: "isolated-api",
    remoteSessionId: "attachment",
  };
  const selection = { providerId: "fixture-api", modelId: "first-model" };
  assert.deepEqual(
    await service.testModelConnectivity({ ...target, selection, mode: "temporary" }),
    { success: true },
  );
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0], { ...target, selection, mode: "temporary" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, lcodeProtocolMethods.providerTestModelConnectivity);
  assert.equal((calls[0]!.params as { mode: string }).mode, "temporary");
  assert.equal(ready.mock.callCount(), 0);
  await assert.rejects(
    service.testModelConnectivity({ ...target, selection }),
    (error) => (error as { code?: string }).code === "LCODE_AGENT_PROVIDER_NOT_READY",
  );
  assert.equal(calls.length, 1, "the temporary runtime cannot bypass ordinary readiness");
  await service.testModelConnectivity({ ...target, selection, mode: "temporary" });
  assert.equal(targets.length, 1, "the original workspace runtime is reused");
});
