import assert from "node:assert/strict";
import test from "node:test";
import type { CheckoutLease, IWorktreeService } from "../worktree/contract.js";
import { createWorktreeClientLeases } from "./worktreeClientLeases.js";
import { createWorktreeService } from "../worktree/node.js";

function fixture() {
  const held = new Map<string, CheckoutLease>();
  let sequence = 0;
  let failRelease = false;
  const service = {
    acquireCheckout: async (params: { workspacePath: string; ownerId: string }) => {
      const lease = { ...params, token: String(++sequence) };
      held.set(lease.token, lease);
      return lease;
    },
    releaseCheckout: async (params: { token: string; ownerId: string }) => {
      if (failRelease) throw new Error("release failed");
      const current = held.get(params.token);
      if (current && current.ownerId !== params.ownerId) throw new Error("owner mismatch");
      held.delete(params.token);
    },
  } as IWorktreeService;
  return {
    held,
    service,
    setFailRelease: (value: boolean) => {
      failRelease = value;
    },
  };
}

test("confirmed process exit releases only that client generation and is idempotent", async () => {
  const f = fixture();
  const old = createWorktreeClientLeases(f.service, "old");
  const next = createWorktreeClientLeases(f.service, "next");
  const first = await old.service.acquireCheckout({ workspacePath: "/repo", ownerId: "session" });
  const second = await next.service.acquireCheckout({ workspacePath: "/repo", ownerId: "session" });
  await assert.rejects(next.service.releaseCheckout({ ...first, ownerId: "session" }), /owner/);
  await old.disposeAfterProcessExit();
  assert.deepEqual([...f.held.keys()], [second.token]);
  await old.disposeAfterProcessExit();
  await assert.rejects(
    old.service.acquireCheckout({ workspacePath: "/repo", ownerId: "session" }),
    /exited/,
  );
  await next.disposeAfterProcessExit();
  assert.equal(f.held.size, 0);
});

test("a grant arriving after confirmed exit is released without returning a permit", async () => {
  const f = fixture();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const baseAcquire = f.service.acquireCheckout;
  f.service.acquireCheckout = async (params) => {
    await gate;
    return baseAcquire(params);
  };
  const client = createWorktreeClientLeases(f.service, "client");
  const acquiring = client.service.acquireCheckout({ workspacePath: "/repo", ownerId: "session" });
  const rejected = assert.rejects(acquiring, /exited/);
  const cleanup = client.disposeAfterProcessExit();
  resume();
  await rejected;
  await cleanup;
  assert.equal(f.held.size, 0);
});

test("failed process cleanup preserves tokens for an explicit retry", async () => {
  const f = fixture();
  const client = createWorktreeClientLeases(f.service, "client");
  await client.service.acquireCheckout({ workspacePath: "/repo", ownerId: "session" });
  f.setFailRelease(true);
  await assert.rejects(client.disposeAfterProcessExit(), /release failed/);
  assert.equal(f.held.size, 1);
  f.setFailRelease(false);
  await client.disposeAfterProcessExit();
  assert.equal(f.held.size, 0);
});

test("confirmed exit and an in-flight grant release through the real strict service", async (t) => {
  for (const delayed of [false, true]) {
    await t.test(delayed ? "grant after exit" : "exit after grant", async () => {
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const releases: unknown[] = [];
      const service = createWorktreeService({
        dataDir: "/unused-fixture",
        git: {
          run: async () => {
            throw new Error("unexpected Git IO");
          },
        },
        coordinator: {
          acquire: async (params) => {
            if (delayed) await gate;
            return {
              token: "permit",
              workspacePath: params.workspacePath,
              ownerId: params.ownerId,
            };
          },
          release: async (params) => {
            releases.push(params);
          },
        },
      });
      const client = createWorktreeClientLeases(service, "client");
      const acquiring = client.service.acquireCheckout({
        workspacePath: "/repo",
        ownerId: "session",
      });
      if (delayed) {
        const rejected = assert.rejects(acquiring, /exited/);
        const cleanup = client.disposeAfterProcessExit();
        resume();
        await rejected;
        await cleanup;
      } else {
        await acquiring;
        await client.disposeAfterProcessExit();
      }
      await client.disposeAfterProcessExit();
      assert.deepEqual(releases, [{ token: "permit", ownerId: "client:session" }]);
    });
  }
});
