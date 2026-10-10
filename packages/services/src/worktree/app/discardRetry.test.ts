import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { retryConfirmedWorktreeDiscard } from "./discardRetry.js";

function fixture() {
  const binding = {
    id: "binding",
    branch: "lcode/task-a",
    checkoutPath: "/managed/a",
    status: "deleting",
    deletion: { requestId: "original", branchHead: "head", sessionIds: ["owner", "hidden"] },
  } as unknown as WorktreeBinding;
  const waits: Array<{ delayMs: number; requestId: string; attempt: number; errorCode: string }> =
    [];
  const context = {
    store: { readBinding: async () => binding },
    discardRetryWait: async (event: (typeof waits)[number]) => {
      waits.push(event);
    },
  } as unknown as WorktreeContext;
  const request = {
    bindingId: binding.id,
    requestId: "new-retry-request",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  return { context, binding, waits, request };
}

test("one confirmed operation automatically spans a minute-long EBUSY and keeps the original journal", async () => {
  const f = fixture();
  let attempts = 0;
  const result = await retryConfirmedWorktreeDiscard(f.context, f.request, async () => {
    attempts += 1;
    if (f.waits.reduce((total, wait) => total + wait.delayMs, 0) < 70_000)
      throw Object.assign(new Error("fixture locked"), { code: "EBUSY" });
    return { ...f.binding, status: "deleted" };
  });
  assert.equal(result.status, "deleted");
  assert.equal(attempts, f.waits.length + 1);
  assert.equal(f.waits[0]!.delayMs, 1_000);
  assert.ok(f.waits.every((wait) => wait.delayMs <= 8_000 && wait.requestId === "original"));
  assert.deepEqual(result.deletion?.sessionIds, ["owner", "hidden"]);
});

test("persistent locks exhaust a bounded wait budget and preserve the last actual error", async () => {
  const f = fixture();
  const error = Object.assign(new Error("persistent lock"), { code: "EBUSY" });
  await assert.rejects(
    retryConfirmedWorktreeDiscard(f.context, f.request, async () => {
      throw error;
    }),
    (e) => e === error,
  );
  assert.equal(
    f.waits.reduce((total, wait) => total + wait.delayMs, 0),
    120_000,
  );
  assert.equal(f.binding.status, "deleting");
  assert.equal(f.binding.deletion?.requestId, "original");
});

test("non-file errors and error text mentioning EBUSY do not enter retry", async () => {
  for (const error of [
    new Error("EBUSY: unknown owner"),
    Object.assign(new Error("read failed"), { code: "EIO" }),
  ]) {
    const f = fixture();
    await assert.rejects(
      retryConfirmedWorktreeDiscard(f.context, f.request, async () => {
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(f.waits.length, 0);
  }
});

test("ENOTEMPTY and EPERM are retried, but missing journal or changed confirmation is not", async () => {
  for (const code of ["ENOTEMPTY", "EPERM"]) {
    const f = fixture();
    let attempts = 0;
    await retryConfirmedWorktreeDiscard(f.context, f.request, async () => {
      if (++attempts === 1) throw Object.assign(new Error(code), { code });
      return f.binding;
    });
    assert.equal(f.waits.length, 1);
  }
  for (const change of ["journal", "branch", "checkout", "status"]) {
    const f = fixture();
    if (change === "journal") f.binding.deletion = undefined;
    if (change === "branch") f.binding.branch = "lcode/task-other";
    if (change === "checkout") f.binding.checkoutPath = "/other/a";
    if (change === "status") f.binding.status = "ready";
    await assert.rejects(
      retryConfirmedWorktreeDiscard(f.context, f.request, async () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }),
    );
    assert.equal(f.waits.length, 0);
  }
});
