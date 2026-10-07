import assert from "node:assert/strict";
import test from "node:test";
import {
  helloMessageSchema,
  hostSupportsRuntimeEnvironment,
  type HelloMessage,
} from "@lcode/shared/lcode-protocol-v4";
import type { RuntimeEnvironmentProtocolCapability } from "@lcode/shared";
import type { ILCodeAgentService } from "./lcodeAgent.js";
import { createLCodeAgentConnectionScope } from "./lcodeAgentConnectionScope.js";

function base(runtimeEnvironment?: RuntimeEnvironmentProtocolCapability) {
  const hello: HelloMessage = {
    kind: "hello",
    protocolVersion: 3,
    connectionId: "upstream",
    clientMode: "desktop-continuous",
    deliveryProfile: "continuous",
    serverTime: 1,
    capabilities: {
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: false,
      compression: "none",
      ...(runtimeEnvironment ? { runtimeEnvironment } : {}),
    },
    auth: {},
  };
  return { helloConversationV4: async () => hello } as ILCodeAgentService;
}

test("desktop continuous and mobile replayable hello keep the actual target runtime capabilities", async () => {
  const capability: RuntimeEnvironmentProtocolCapability = {
    managedEnvironments: true,
    protocolVersion: 1,
    actions: ["prepare", "reconcile", "startService"],
    platform: "linux",
  };
  for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
    const scope = createLCodeAgentConnectionScope(base(capability), {
      connectionId: clientMode,
      clientMode,
    });
    const hello = helloMessageSchema.parse(await scope.service.helloConversationV4());
    assert.deepEqual(hello.capabilities.runtimeEnvironment, capability);
    assert.equal(hello.connectionId, clientMode);
    assert.equal(
      hello.deliveryProfile,
      clientMode === "desktop-continuous" ? "continuous" : "replayable",
    );
    assert.equal(hostSupportsRuntimeEnvironment(hello.capabilities, "reconcile"), true);
    assert.equal(hostSupportsRuntimeEnvironment(hello.capabilities, "stopService"), false);
    await scope.dispose();
  }
});

test("an old or explicitly unavailable Host cannot gain managed support at an attachment", async () => {
  for (const capability of [
    undefined,
    {
      managedEnvironments: false,
      missingReason: "backend missing",
      protocolVersion: 1,
      actions: ["prepare"],
    },
  ] as const) {
    const scope = createLCodeAgentConnectionScope(
      base(capability ? { ...capability, actions: [...capability.actions] } : undefined),
      { connectionId: "mobile", clientMode: "web-remote-replayable" },
    );
    const hello = await scope.service.helloConversationV4();
    assert.equal(hostSupportsRuntimeEnvironment(hello.capabilities, "prepare"), false);
    assert.deepEqual(hello.capabilities.runtimeEnvironment, capability);
    await scope.dispose();
  }
});

test("session environment rebind is denied to terminal clients and allowed only on a trusted Host relay", async () => {
  const calls: unknown[] = [];
  const upstream = base();
  upstream.rebindWorktreeSessions = async (params) => {
    calls.push(params);
    return { sessionIds: ["existing"] };
  };
  const params = {
    workspacePath: "/repo",
    rebind: {
      executionBindingId: "binding",
      originWorkspacePath: "/repo",
      workspacePath: "/checkout",
      oldEnvironmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" },
      newEnvironmentRef: { environmentId: "a".repeat(32), revision: 2, manifestDigest: "new" },
    },
  };
  const mobile = createLCodeAgentConnectionScope(upstream, {
    connectionId: "mobile",
    clientMode: "web-remote-replayable",
  });
  await assert.rejects(mobile.service.rebindWorktreeSessions(params), /maintenanceForbidden/);
  assert.deepEqual(calls, []);
  const relay = createLCodeAgentConnectionScope(upstream, {
    connectionId: "host",
    clientMode: "desktop-continuous",
    role: "trusted-host-relay",
  });
  assert.deepEqual(await relay.service.rebindWorktreeSessions(params), {
    sessionIds: ["existing"],
  });
  assert.deepEqual(calls, [params]);
  await mobile.dispose();
  await relay.dispose();
});

test("capability helpers require an explicitly supported protocol and action, not only an action list", () => {
  const capabilities = {
    nativeDialogs: false,
    localTerminal: false,
    binaryFrames: false,
    compression: "none" as const,
  };
  for (const runtimeEnvironment of [
    undefined,
    { managedEnvironments: true, actions: ["prepare" as const] },
    { managedEnvironments: true, protocolVersion: 2, actions: ["prepare" as const] },
    { managedEnvironments: true, protocolVersion: 1, actions: [] },
  ]) {
    assert.equal(
      hostSupportsRuntimeEnvironment({ ...capabilities, runtimeEnvironment }, "prepare"),
      false,
    );
  }
});
