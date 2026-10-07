import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("discard journals shared chat IDs and preserves directory/refs until chat cleanup succeeds", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
    setupCommands: [],
  });
  let collections = 0;
  let attempts = 0;
  const service = createWorktreeService({
    ...f.options,
    collectDiscardSessions: async () => {
      collections++;
      return ["owner", "fork", "hidden"];
    },
    discardSessions: async (_, ids) => {
      assert.deepEqual(ids, ["owner", "fork", "hidden"]);
      if (++attempts === 1) throw new Error("chat cleanup unavailable");
    },
  });
  const request = {
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  await assert.rejects(service.archive(request), /chat cleanup unavailable/);
  const interrupted = await service.getBinding({ workspacePath: f.repo, taskId: "owner" });
  assert.equal(interrupted?.status, "deleting");
  assert.match(interrupted?.error ?? "", /chat cleanup unavailable/);
  assert.deepEqual(interrupted?.deletion?.sessionIds, ["owner", "fork", "hidden"]);
  assert.notEqual(await f.command(f.repo, "branch", "--list", binding.branch), "");
  await access(binding.checkoutPath);
  assert.equal((await service.archive(request)).status, "deleted");
  assert.equal(await f.command(f.repo, "branch", "--list", binding.branch), "");
  assert.equal(collections, 1);
  assert.equal(attempts, 2);
  await service.archive(request);
  assert.equal(attempts, 2);
});

test("snapshot release preserves chats", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
    setupCommands: [],
  });
  const service = createWorktreeService({
    ...f.options,
    collectDiscardSessions: async () => {
      throw new Error("must not collect");
    },
    discardSessions: async () => {
      throw new Error("must not purge");
    },
  });
  assert.equal(
    (await service.archive({ bindingId: binding.id, requestId: "snapshot" })).status,
    "archived",
  );
});
