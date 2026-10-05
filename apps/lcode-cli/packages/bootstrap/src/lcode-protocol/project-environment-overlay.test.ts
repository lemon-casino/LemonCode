import assert from "node:assert/strict";
import { test } from "node:test";
import { lcodeProtocolMethods as methods, type LCodeWorkspaceRef } from "@lcode/shared";
import { createProjectEnvironmentOverlayResolver } from "./project-environment-overlay.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const workspace: LCodeWorkspaceRef = {
  workspacePath: "/checkout", workspaceKey: "remote-identity", workspaceIdentity: "remote-identity",
  remoteSessionId: "attachment-1", executionBindingId: "binding",
  environmentRef: { environmentId: "a".repeat(32), revision: 7 },
};
function context(fail = false) {
  const calls: { method: unknown; params: Record<string, unknown> }[] = [];
  const value = {
    requestClient: async (method: unknown, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (fail) throw new Error("Host unavailable");
      if (method === methods.runtimeEnvironmentReleaseConsumer) return { removed: 1, remaining: 1 };
      return { context: {
        ...workspace.environmentRef, manifestDigest: "digest", cwd: params.cwd,
        toolPaths: {}, envOverlay: { base: "inherit", set: { PATH: "/frozen" } },
      } };
    },
  } as unknown as Pick<LCodeProtocolAgentServerContext, "requestClient">;
  return { value, calls };
}

test("bound resolver forwards identity and revision per command without TTL", async () => {
  const f = context();
  const resolve = createProjectEnvironmentOverlayResolver(f.value, workspace, "child");
  await resolve(undefined);
  await resolve("/checkout/src");
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.params.sessionId, "child");
    assert.equal(call.params.executionBindingId, "binding");
    assert.equal(call.params.workspaceIdentity, workspace.workspaceIdentity);
    assert.equal(call.params.remoteSessionId, "attachment-1");
    assert.deepEqual(call.params.environmentRef, workspace.environmentRef);
    assert.equal(call.params.lease, undefined);
  }
  assert.equal(f.calls[0]?.params.cwd, "/checkout");
  assert.equal(f.calls[1]?.params.consumer, f.calls[0]?.params.consumer);
  const another = createProjectEnvironmentOverlayResolver(f.value, workspace, "child");
  await another("/checkout");
  assert.notEqual(f.calls[2]?.params.consumer, f.calls[0]?.params.consumer);
  await resolve.close!();
  assert.equal(f.calls[3]?.method, methods.runtimeEnvironmentReleaseConsumer);
  assert.equal(f.calls[3]?.params.consumer, f.calls[0]?.params.consumer);
  await resolve.close!();
  assert.equal(f.calls.length, 4);
  await assert.rejects(resolve("/checkout"), /closed/);
});

test("Host failure remains an error for a managed reference", async () => {
  const f = context(true);
  const resolve = createProjectEnvironmentOverlayResolver(f.value, workspace, "child");
  await assert.rejects(resolve("/checkout"), /Host unavailable/);
  await assert.rejects(resolve.close!(), /Host unavailable/);
  assert.equal(f.calls.length, 2);
});

test("legacy workspace never sends runtime environment RPC", async () => {
  const f = context(true);
  const resolve = createProjectEnvironmentOverlayResolver(f.value, { workspacePath: "/legacy", workspaceKey: "/legacy" }, "legacy");
  assert.equal(await resolve("/legacy"), undefined);
  assert.equal(f.calls.length, 0);
});

test("mismatched returned revision rejects execution", async () => {
  const f = context();
  const resolve = createProjectEnvironmentOverlayResolver(f.value, { ...workspace, environmentRef: { environmentId: "a".repeat(32), revision: 8 } }, "child");
  await assert.rejects(resolve("/checkout"), /stale-reference/);
});
