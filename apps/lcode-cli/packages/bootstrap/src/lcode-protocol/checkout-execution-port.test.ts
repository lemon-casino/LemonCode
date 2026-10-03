import assert from "node:assert/strict";
import test from "node:test";
import { createProtocolCheckoutExecutionPort } from "./checkout-execution-port.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("checkout permit uses actual path and releases once after owner acknowledgment", async () => {
  const calls: { method: string; params: unknown }[] = [];
  const context = {
    requestClient: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method.includes("acquire") ? { permitId: "permit" } : { released: true };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const lease = await createProtocolCheckoutExecutionPort(context, {
    workspacePath: "/tree",
    workspaceKey: "/tree",
    executionBindingId: "binding",
  }).acquire({ sessionId: "session", turnId: "turn", signal: new AbortController().signal });
  assert.equal((calls[0]?.params as { workspacePath: string }).workspacePath, "/tree");
  assert.equal(calls.length, 1);
  await lease.release();
  await lease.release();
  assert.equal(calls.length, 2);
});

test("cancellation while owner grants returns the lease before rejecting", async () => {
  const controller = new AbortController();
  let released = false;
  const context = {
    requestClient: async (method: string) => {
      if (method.includes("acquire")) {
        controller.abort();
        return { permitId: "permit" };
      }
      released = true;
      return { released: true };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(
    createProtocolCheckoutExecutionPort(context, {
      workspacePath: "/tree",
      workspaceKey: "/tree",
    }).acquire({ sessionId: "s", turnId: "t", signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(released, true);
});

test("old host may continue local sessions but never a bound worktree", async () => {
  const context = {
    requestClient: async () => {
      throw Object.assign(new Error("method unavailable"), { code: -32601 });
    },
  } as unknown as LCodeProtocolAgentServerContext;
  await (
    await createProtocolCheckoutExecutionPort(context, {
      workspacePath: "/local",
      workspaceKey: "/local",
    }).acquire({ sessionId: "s", turnId: "t", signal: new AbortController().signal })
  ).release();
  await assert.rejects(
    createProtocolCheckoutExecutionPort(context, {
      workspacePath: "/tree",
      workspaceKey: "/tree",
      executionBindingId: "b",
    }).acquire({ sessionId: "s", turnId: "t", signal: new AbortController().signal }),
    /unavailable/,
  );
});

test("busy checkout waits inside the admitted execution until granted", async () => {
  let attempts = 0;
  const context = {
    requestClient: async (method: string) =>
      method.includes("acquire")
        ? ++attempts === 1
          ? { busy: true }
          : { permitId: "permit" }
        : { released: true },
  } as unknown as LCodeProtocolAgentServerContext;
  const lease = await createProtocolCheckoutExecutionPort(context, {
    workspacePath: "/tree",
    workspaceKey: "/tree",
  }).acquire({ sessionId: "s", turnId: "t", signal: new AbortController().signal });
  assert.equal(attempts, 2);
  await lease.release();
});

test("cancelling a busy checkout wait does not invent a permit to release", async () => {
  const abort = new AbortController();
  let attempts = 0;
  const context = {
    requestClient: async (method: string) => {
      assert.match(method, /acquire/);
      attempts++;
      abort.abort();
      return { busy: true };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(
    createProtocolCheckoutExecutionPort(context, {
      workspacePath: "/tree",
      workspaceKey: "/tree",
    }).acquire({ sessionId: "s", turnId: "t", signal: abort.signal }),
    { name: "AbortError" },
  );
  assert.equal(attempts, 1);
});
