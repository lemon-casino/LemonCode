import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import type { LCodeApp } from "./types.js";
import { ProtocolRuntimeResources } from "../lcode-protocol/runtime-resources.js";
import { failAppStartup, AppStartupCleanupError } from "./failed-app-startup.js";

test("unpublished owner cleanup is retried before the same parent can allocate its next App", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const lease = await store.acquireWorkflowExecutionOwner({
    parentSessionId: "parent",
    workspaceKey: "fixture",
  });
  const original = new Error("fixture constructor failure");
  let created = 0,
    retired = 0,
    modelsClosed = 0;
  const owner = new ProtocolRuntimeResources(async () => {
    if (++created === 1)
      return failAppStartup({
        sessionId: "parent",
        error: original,
        resources: [
          async () => {
            modelsClosed++;
          },
        ],
        retire: () => {
          if (++retired === 1) throw new Error("fixture retirement failure");
          lease.release();
        },
      });
    const next = await store.acquireWorkflowExecutionOwner({
      parentSessionId: "parent",
      workspaceKey: "fixture",
    });
    assert.equal(next.generation, 2);
    return {
      sessionId: "parent",
      runtime: { beginShutdown() {}, stopActiveForegroundExecution() {} },
      close: async () => next.release(),
    } as unknown as LCodeApp;
  });
  try {
    await assert.rejects(
      Promise.resolve(owner.create({ sessionId: "parent" as never })),
      (error) => error instanceof AppStartupCleanupError && error.cause === original,
    );
    await assert.rejects(
      store.acquireWorkflowExecutionOwner({ parentSessionId: "parent", workspaceKey: "fixture" }),
      { code: "owner_active" },
    );
    await owner.create({ sessionId: "parent" as never });
    assert.equal(created, 2);
    assert.equal(retired, 2);
    assert.equal(modelsClosed, 1);
    await owner.close();
  } finally {
    lease.release();
    store.close();
  }
});

test("shutdown retains a failed unpublished constructor until its exact cleanup succeeds", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const lease = await store.acquireWorkflowExecutionOwner({
    parentSessionId: "parent",
    workspaceKey: "fixture",
  });
  let attempts = 0;
  const owner = new ProtocolRuntimeResources(async () =>
    failAppStartup({
      sessionId: "parent",
      error: new Error("fixture construct"),
      resources: [],
      retire: () => {
        if (++attempts < 3) throw new Error("fixture retire pending");
        lease.release();
      },
    }),
  );
  try {
    await assert.rejects(Promise.resolve(owner.create()), AppStartupCleanupError);
    await assert.rejects(owner.close());
    lease.assertOwned();
    await owner.close();
    const next = await store.acquireWorkflowExecutionOwner({
      parentSessionId: "parent",
      workspaceKey: "fixture",
    });
    next.release();
  } finally {
    lease.release();
    store.close();
  }
});

test("startup failure preserves every cause and retries only unfinished resources before retiring and closing its store", async () => {
  const original = new Error("fixture original");
  const cleanup = new Error("fixture cleanup");
  const order: string[] = [];
  let failed = false;
  let caught!: AppStartupCleanupError;
  try {
    await failAppStartup({
      sessionId: "parent",
      error: original,
      resources: [
        async () => {
          order.push("independent");
        },
        async () => {
          order.push("retryable");
          if (!failed) {
            failed = true;
            throw cleanup;
          }
        },
      ],
      retire: () => {
        order.push("retire");
      },
      closeStore: () => {
        order.push("store");
      },
    });
  } catch (error) {
    assert.ok(error instanceof AppStartupCleanupError);
    caught = error;
  }
  assert.equal(caught.cause, original);
  assert.ok(caught.errors.includes(original));
  assert.ok(caught.errors.includes(cleanup));
  assert.deepEqual(order, ["independent", "retryable"]);
  await caught.retryCleanup();
  assert.deepEqual(order, ["independent", "retryable", "retryable", "retire", "store"]);
});
