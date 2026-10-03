import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId } from "@lcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../../runtime-task/registry.js";
import { acquireCheckoutExecutionLease } from "./checkout-execution-lease.js";

test("checkout lease remains held for background writers and is reused by the next turn", async () => {
  let acquired = 0;
  let released = 0;
  const registry = new InMemoryRuntimeTaskRegistry();
  const runtime = {
    sessionId: "s" as SessionId,
    runtimeTaskRegistry: registry,
    checkoutExecutionPort: {
      acquire: async () => {
        acquired++;
        return {
          release: async () => {
            released++;
          },
        };
      },
    },
  };
  const lease = await acquireCheckoutExecutionLease(
    runtime,
    "turn-1",
    new AbortController().signal,
  );
  registry.register({
    taskId: "preview",
    type: "local_bash",
    status: "running",
    keepAliveAfterTask: true,
  } as never);
  await lease?.release();
  assert.equal(released, 0);
  const next = await acquireCheckoutExecutionLease(runtime, "turn-2", new AbortController().signal);
  assert.equal(acquired, 1);
  registry.update("preview", (task) => ({ ...task, status: "completed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 0);
  await next?.release();
  assert.equal(released, 1);
});

test("checkout lease releases when the last background writer settles without another turn", async () => {
  let released = 0;
  const registry = new InMemoryRuntimeTaskRegistry();
  const runtime = {
    sessionId: "s" as SessionId,
    runtimeTaskRegistry: registry,
    checkoutExecutionPort: {
      acquire: async () => ({
        release: async () => {
          released++;
        },
      }),
    },
  };
  const lease = await acquireCheckoutExecutionLease(runtime, "turn", new AbortController().signal);
  registry.register({ taskId: "child", type: "local_agent", status: "running" } as never);
  await lease?.release();
  assert.equal(released, 0);
  registry.update("child", (task) => ({ ...task, status: "failed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
});

test("cancelled waiters sharing an acquisition cannot execute or release another active writer", async () => {
  let grant!: () => void;
  const gate = new Promise<void>((resolve) => {
    grant = resolve;
  });
  let acquired = 0;
  let released = 0;
  const runtime = {
    sessionId: "s" as SessionId,
    runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
    checkoutExecutionPort: {
      acquire: async () => {
        acquired++;
        await gate;
        return {
          release: async () => {
            released++;
          },
        };
      },
    },
  };
  const first = acquireCheckoutExecutionLease(runtime, "first", new AbortController().signal);
  const abort = new AbortController();
  const second = acquireCheckoutExecutionLease(runtime, "second", abort.signal);
  const rejected = assert.rejects(second, /abort/i);
  abort.abort();
  grant();
  const lease = await first;
  await rejected;
  assert.equal(acquired, 1);
  assert.equal(released, 0);
  await lease?.release();
  assert.equal(released, 1);
});
