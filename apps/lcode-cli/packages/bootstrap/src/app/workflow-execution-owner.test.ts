import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStorePort } from "@lcode/contracts";
import { acquireAppWorkflowExecutionOwner } from "./workflow-execution-owner.js";

for (const ownsSessionStore of [true, false])
  test(`failed owner admission closes only owned store: ${ownsSessionStore}`, async () => {
    const failure = new Error("owner_active");
    let closed = 0;
    const sessionStore = {
      acquireWorkflowExecutionOwner: async () => {
        throw failure;
      },
      close: () => {
        closed += 1;
      },
    } as unknown as SessionStorePort;
    await assert.rejects(
      acquireAppWorkflowExecutionOwner({
        sessionStore,
        ownsSessionStore,
        parentSessionId: "parent",
        workspacePath: "C:/fixture",
      }),
      (error) => error === failure,
    );
    assert.equal(closed, ownsSessionStore ? 1 : 0);
  });

test("owner admission keeps primary failure if owned store cleanup also fails", async () => {
  const failure = new Error("owner_unknown");
  const cleanup = new Error("close failed");
  const sessionStore = {
    acquireWorkflowExecutionOwner: async () => {
      throw failure;
    },
    close: () => {
      throw cleanup;
    },
  } as unknown as SessionStorePort;
  await assert.rejects(
    acquireAppWorkflowExecutionOwner({
      sessionStore,
      ownsSessionStore: true,
      parentSessionId: "parent",
      workspacePath: "C:/fixture",
    }),
    (error) =>
      error instanceof AggregateError && error.cause === failure && error.errors[1] === cleanup,
  );
});
