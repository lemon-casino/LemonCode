import assert from "node:assert/strict";
import test from "node:test";
import type { LCodeSessionWorktreeRebindParams, LCodeWorkspaceRef } from "@lcode/shared";
import { rebindWorktreeSessions } from "./worktree-session-rebind.js";
import { SessionResidentPool } from "./session-resident-pool.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const params: LCodeSessionWorktreeRebindParams = {
  executionBindingId: "binding",
  originWorkspacePath: "/origin",
  workspacePath: "/tree",
  oldEnvironmentRef: { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" },
  newEnvironmentRef: { environmentId: "b".repeat(32), revision: 1, manifestDigest: "new" },
};
const workspace: LCodeWorkspaceRef = {
  executionBindingId: params.executionBindingId,
  originWorkspacePath: params.originWorkspacePath,
  workspacePath: params.workspacePath,
  workspaceKey: params.workspacePath,
  environmentRef: params.oldEnvironmentRef,
};
function fixture(
  options: {
    busy?: string;
    interaction?: string;
    command?: string;
    scope?: Partial<LCodeWorkspaceRef>;
    close?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const sessions = new Map(
    ["root", "child"].map((id) => [
      id,
      {
        workspace: {
          ...workspace,
          ...(id === "child" ? { bindingOwnerTaskId: "root", ...options.scope } : {}),
        },
        app: {
          close: async () => {
            calls.push(`close:${id}`);
            await options.close?.();
          },
          runtime: { hasResidencyBlockingWork: () => options.busy === id },
        },
        eventStore: {
          deleteSession: async () => {
            calls.push(`events:${id}`);
          },
        },
        unsubscribe: () => calls.push(`unsubscribe:${id}`),
      },
    ]),
  );
  const context = {
    sessions,
    deps: {
      sessionStore: {
        worktreeRebind: async (input: { expectedSessionIds?: readonly string[] }) => {
          calls.push(input.expectedSessionIds ? "cas" : "query");
          if (input.expectedSessionIds) assert.equal(sessions.size, 0);
          return { sessionIds: ["child", "root"] };
        },
      },
    },
    v4Interactions: { hasPendingForSession: (id: string) => options.interaction === id },
    v4Gateway: {
      hasResidencyBlockingCommands: (id: string) => options.command === id,
      assertSessionRuntimeDeactivatable: () => {},
      deactivateSession: (id: string) => calls.push(`deactivate:${id}`),
    },
  } as unknown as LCodeProtocolAgentServerContext;
  context.sessionResidentPool = new SessionResidentPool({
    listSessionIds: () => [...sessions.keys()],
    readResidencyFacts: () => null,
    deactivate: async () => {
      throw new Error("unexpected pool eviction");
    },
  });
  return { context, calls, sessions };
}

test("maintenance closes all idle residents before CAS without hydrate or model calls", async () => {
  const f = fixture();
  assert.deepEqual(await rebindWorktreeSessions(f.context, params), {
    sessionIds: ["child", "root"],
  });
  assert.equal(f.calls[0], "query");
  assert.equal(f.calls.at(-1), "cas");
  assert.equal(f.calls.filter((call) => call.startsWith("close:")).length, 2);
  assert.equal(f.sessions.size, 0);
});

for (const options of [{ busy: "root" }, { interaction: "root" }, { command: "root" }]) {
  test(`maintenance rejects ${JSON.stringify(options)} before closing any resident`, async () => {
    const f = fixture(options);
    await assert.rejects(rebindWorktreeSessions(f.context, params), /running/);
    assert.deepEqual(f.calls, ["query"]);
    assert.equal(f.sessions.size, 2);
  });
}
for (const scope of [
  { workspaceIdentity: "other" },
  { originWorkspaceIdentity: "other" },
  { environmentRef: { ...params.oldEnvironmentRef, manifestDigest: "stale" } },
]) {
  test(`maintenance refuses resident scope/reference mismatch ${JSON.stringify(scope)}`, async () => {
    const f = fixture({ scope });
    await assert.rejects(rebindWorktreeSessions(f.context, params), /scope|reference/);
    assert.deepEqual(f.calls, ["query"]);
  });
}

test("maintenance gate blocks cold hydration until close and CAS finish", async () => {
  let finish!: () => void;
  const close = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    close: async () => {
      entered();
      await close;
    },
  });
  const maintenance = rebindWorktreeSessions(f.context, params);
  await started;
  assert.equal(f.sessions.size, 0, "all old residents leave registry before any await");
  let hydrated = false;
  const cold = f.context.sessionResidentPool!.waitForDeactivation("root").then(() => {
    hydrated = true;
  });
  await Promise.resolve();
  assert.equal(hydrated, false);
  finish();
  await maintenance;
  await cold;
  assert.equal(hydrated, true);
  assert.equal(f.calls.at(-1), "cas");
});

test("maintenance refuses active operation leases and strict unknown wire fields", async () => {
  const f = fixture();
  const release = await f.context.sessionResidentPool!.acquireOperation("root");
  await assert.rejects(rebindWorktreeSessions(f.context, params), /operation/);
  assert.deepEqual(f.calls, ["query"]);
  release();
  await assert.rejects(
    rebindWorktreeSessions(f.context, { ...params, remoteSessionId: "routing" }),
    /Invalid params/,
  );
});
