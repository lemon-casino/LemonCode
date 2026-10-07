import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectId, SessionId } from "@lcode/contracts";
import {
  lcodeProtocolMethods as methods,
  lcodeProtocolSessionMethodContracts as contracts,
  lcodeRuntimeCapabilitiesSchema,
  lcodeSessionWorktreeRebindParamsSchema,
  lcodeSessionWorktreeRebindResultSchema,
  type LCodeSessionWorktreeRebindParams,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import { createSqliteSessionStore } from "@lcode/adapters";
import { LCodeProtocolAgentServer } from "./server.js";

const params: LCodeSessionWorktreeRebindParams = {
  executionBindingId: "binding",
  originWorkspacePath: "/origin",
  workspacePath: "/tree",
  oldEnvironmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" },
  newEnvironmentRef: { environmentId: "b".repeat(32), revision: 2, manifestDigest: "new" },
};

test("real maintenance dispatch and SQLite CAS require no session hydration or model", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const server = new LCodeProtocolAgentServer({
    createLCodeApp: () => {
      throw new Error("maintenance must not hydrate or call a model");
    },
    sessionStore: store,
  });
  try {
    await store.createSession({
      id: "session" as SessionId,
      projectID: "project" as ProjectId,
      directory: "/tree",
      path: "/tree",
      slug: "session",
      title: "session",
      version: "test",
      initialEntries: [
        {
          id: "binding-entry",
          sessionID: "session" as SessionId,
          type: "runtime/worktree_binding",
          time: { created: 1, updated: 1 },
          touchSession: false,
          data: {
            executionBindingId: params.executionBindingId,
            originWorkspacePath: params.originWorkspacePath,
            workspacePath: "/tree",
            workspaceKey: "/tree",
            environmentRef: params.oldEnvironmentRef,
          },
        },
      ],
    });
    const response = await server.handleMessage({
      id: "maintenance",
      method: methods.sessionWorktreeRebind,
      params,
    });
    assert.ok(response && "result" in response);
    assert.deepEqual(lcodeSessionWorktreeRebindResultSchema.parse(response.result), {
      sessionIds: ["session"],
    });
    const entries = await store.sessionEntries({
      sessionID: "session" as SessionId,
      type: "runtime/worktree_binding",
    });
    assert.deepEqual(
      (entries[0]!.data as LCodeWorkspaceRef).environmentRef,
      params.newEnvironmentRef,
    );
    const capsResponse = await server.handleMessage({
      id: "caps",
      method: methods.runtimeCapabilities,
      params: {},
    });
    assert.ok(capsResponse && "result" in capsResponse);
    const capabilities = lcodeRuntimeCapabilitiesSchema.parse(capsResponse.result);
    assert.equal(
      capabilities.runtimeEnvironment?.managedEnvironments,
      undefined,
      "CLI never impersonates the Host owner",
    );
    assert.equal(capabilities.independentPlanState, true);
  } finally {
    await server.shutdown();
    store.close();
  }
});

test("maintenance strictly rejects routing fields, subsets and malformed references", () => {
  for (const extra of [
    { remoteSessionId: "routing" },
    { commands: [] },
    { sessionIds: ["subset"] },
  ])
    assert.equal(
      lcodeSessionWorktreeRebindParamsSchema.safeParse({ ...params, ...extra }).success,
      false,
    );
  assert.equal(
    lcodeSessionWorktreeRebindParamsSchema.safeParse({
      ...params,
      newEnvironmentRef: { ...params.newEnvironmentRef, revision: 0 },
    }).success,
    false,
  );
  assert.equal(
    lcodeSessionWorktreeRebindParamsSchema.safeParse({
      ...params,
      oldEnvironmentRef: { ...params.oldEnvironmentRef, lease: "private" },
    }).success,
    false,
  );
  assert.equal(
    lcodeSessionWorktreeRebindResultSchema.safeParse({ sessionIds: [], changed: 0 }).success,
    false,
  );
});

const scope = { workspacePath: "/tree", workspaceIdentity: "remote-tree" };
const environmentId = params.newEnvironmentRef.environmentId;
for (const [method, request, result] of [
  [
    methods.runtimeEnvironmentCapabilities,
    scope,
    {
      capabilities: {
        managedEnvironments: false,
        missingReason: "missing",
        protocolVersion: 1,
        actions: [],
      },
    },
  ],
  [
    methods.runtimeEnvironmentSnapshot,
    { ...scope, environmentId },
    { protocolVersion: 1, scope, stateRevision: 1 },
  ],
  [
    methods.runtimeEnvironmentReconcile,
    { ...scope, requestId: "request" },
    { operation: null, environment: null },
  ],
  [
    methods.runtimeEnvironmentStartService,
    { ...scope, environmentId, requestId: "request", serviceId: "preview", expectedRevision: 1 },
    { status: "notRunning" },
  ],
  [
    methods.runtimeEnvironmentStopService,
    { ...scope, environmentId, requestId: "request", serviceId: "preview", expectedRevision: 1 },
    { status: "notRunning" },
  ],
  [
    methods.runtimeEnvironmentResourceSummary,
    { ...scope, requestId: "request", budget: { maxEntries: 10, maxDurationMs: 10 } },
    { environmentId, stateRevision: 1, summary: { status: "complete" } },
  ],
  [
    methods.runtimeEnvironmentGarbageCollect,
    { ...scope, requestId: "request", budget: { maxEntries: 10, maxDurationMs: 10 } },
    {
      operationId: "operation",
      status: "succeeded",
      deletedEntries: 0,
      protectedEntries: 1,
      summary: { status: "complete" },
    },
  ],
] as const) {
  test(`${method} has strict typed request/result schemas and rejects routing fields`, () => {
    const contract = contracts[method];
    assert.equal(contract.params.safeParse(request).success, true);
    assert.equal(contract.result.safeParse(result).success, true);
    for (const extra of [{ commands: [] }, { clock: true }, { remoteSessionId: "routing" }])
      assert.equal(contract.params.safeParse({ ...request, ...extra }).success, false);
    assert.equal(contract.result.safeParse({ ...result, lease: "private" }).success, false);
  });
}
