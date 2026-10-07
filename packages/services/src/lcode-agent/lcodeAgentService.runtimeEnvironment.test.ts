import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Event } from "@lcode/rpc";
import { lcodeProtocolMethods, type LCodeSessionWorktreeRebindParams } from "@lcode/shared";
import { helloMessageSchema } from "@lcode/shared/lcode-protocol-v4";
import type { IRuntimeEnvironmentHostService } from "../runtime-environment/contract.js";
import { setDataBaseDir } from "../paths.js";
import { createLCodeAgentService } from "./lcodeAgentService.js";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";
import type { LCodeProtocolClient } from "./lcodeProtocolClient.js";

const rebind: LCodeSessionWorktreeRebindParams = {
  executionBindingId: "binding-a",
  originWorkspacePath: "/repo",
  originWorkspaceIdentity: "project-a",
  workspacePath: "/checkout",
  workspaceIdentity: "execution-a",
  oldEnvironmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" },
  newEnvironmentRef: { environmentId: "a".repeat(32), revision: 2, manifestDigest: "new" },
};

test("production rebind uses the existing read-only maintenance lane and preserves exact refs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-rebind-service-"));
  setDataBaseDir(dir);
  const calls: { method: string; params: unknown }[] = [];
  const routed: unknown[] = [];
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
      return schema.parse({ sessionIds: ["root", "child"] });
    },
  } as unknown as LCodeProtocolClient;
  t.mock.method(LCodeAgentProcessManager.prototype, "getClient", async (target: unknown) => {
    routed.push(target);
    return client;
  });
  const service = createLCodeAgentService();
  t.after(async () => {
    await service.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });
  const target = {
    workspacePath: "/repo",
    workspaceIdentity: "project-a",
    remoteSessionId: "attachment-a",
    rebind,
  };
  assert.deepEqual(await service.rebindWorktreeSessions(target), { sessionIds: ["root", "child"] });
  assert.deepEqual(routed, [target]);
  assert.deepEqual(calls, [{ method: lcodeProtocolMethods.sessionWorktreeRebind, params: rebind }]);
  await assert.rejects(
    service.rebindWorktreeSessions({ ...target, workspaceIdentity: "project-b" }),
    /scope-mismatch/,
  );
  await assert.rejects(
    service.rebindWorktreeSessions({ ...target, workspacePath: "/foreign" }),
    /scope-mismatch/,
  );
  assert.equal(calls.length, 1);
  assert.equal(routed.length, 1);
});

test("production base hello reads actual runtime capability without starting an Agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-hello-service-"));
  setDataBaseDir(dir);
  t.mock.method(LCodeAgentProcessManager.prototype, "getClient", async () => {
    assert.fail("hello must not start an Agent");
  });
  const runtime = {
    getCapabilities: async () => ({
      managedEnvironments: true,
      protocolVersion: 1,
      actions: ["resolveContext", "reconcile"],
      platform: "linux",
      backend: { kind: "mise", version: "fixture", available: true },
    }),
  } as unknown as IRuntimeEnvironmentHostService;
  const service = createLCodeAgentService({ runtimeEnvironmentService: runtime });
  const legacy = createLCodeAgentService();
  t.after(async () => {
    await service.disposeAllAndWait();
    await legacy.disposeAllAndWait();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  });
  const hello = helloMessageSchema.parse(await service.helloConversationV4());
  assert.deepEqual(hello.capabilities.runtimeEnvironment, {
    managedEnvironments: true,
    protocolVersion: 1,
    actions: ["resolveContext", "reconcile"],
    platform: "linux",
  });
  assert.equal((await legacy.helloConversationV4()).capabilities.runtimeEnvironment, undefined);
  runtime.getCapabilities = async () => ({
    managedEnvironments: false,
    protocolVersion: 1,
    actions: [],
    missingReason: "bundled backend unavailable",
  });
  assert.equal(
    (await service.helloConversationV4()).capabilities.runtimeEnvironment?.managedEnvironments,
    false,
  );
});
