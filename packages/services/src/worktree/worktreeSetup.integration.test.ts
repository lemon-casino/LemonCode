import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test(
  "setup holds the canonical writer permit; concurrent archive waits without a lock cycle",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    let started!: (cwd: string) => void;
    let finish!: () => void;
    const entered = new Promise<string>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = createWorktreeService({
      ...f.options,
      validate: async (cwd) => {
        started(cwd);
        await gate;
        return { exitCode: 0, output: "prepared" };
      },
    });
    const preparing = service.prepare({
      workspacePath: f.repo,
      taskId: "A",
      requestId: "A",
      setupCommands: ["fixture-prepare"],
    });
    const path = await entered;
    const [binding] = await service.list({ workspacePath: f.repo });
    await assert.rejects(
      f.service.acquireCheckout({ workspacePath: path, ownerId: "another-writer", waitMs: 1 }),
      /busy/,
    );
    const archiving = service.archive({ bindingId: binding!.id, requestId: "archive" });
    finish();
    assert.equal((await preparing).status, "ready");
    assert.equal((await archiving).status, "archived");
  },
);

test("explicit setup copies only allowlisted ignored files and runs once before ready", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, ".gitignore"), "local.config\n.env\n");
  await f.command(f.repo, "add", ".gitignore");
  await f.command(f.repo, "commit", "-m", "ignore local configuration");
  await writeFile(join(f.repo, "local.config"), "explicit setup fixture\n");
  await writeFile(join(f.repo, ".env"), "must not copy\n");
  const calls: string[] = [];
  const service = createWorktreeService({
    ...f.options,
    validate: async (cwd, command) => {
      calls.push(command);
      assert.ok(cwd.includes("checkouts"));
      return { exitCode: 0, output: "prepared" };
    },
  });
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    copyIgnoredPaths: ["local.config"],
    setupCommands: ["install chosen dependencies"],
  };
  const binding = await service.prepare(request);
  assert.equal(binding.status, "ready");
  assert.equal(binding.setup?.status, "completed");
  assert.equal(
    await readFile(join(binding.checkoutPath, "local.config"), "utf8"),
    "explicit setup fixture\n",
  );
  await assert.rejects(access(join(binding.checkoutPath, ".env")));
  assert.equal((await service.prepare(request)).id, binding.id);
  assert.deepEqual(calls, ["install chosen dependencies"]);
});

test("failed setup persists completed steps and requires an explicit retry", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  let fail = true;
  const service = createWorktreeService({
    ...f.options,
    validate: async (_cwd, command) => {
      calls.push(command);
      return { exitCode: command === "second" && fail ? 1 : 0, output: "fixture" };
    },
  });
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    setupCommands: ["first", "second"],
  };
  await assert.rejects(service.prepare(request), /setup failed/);
  assert.equal(
    (await service.getBinding({ workspacePath: request.workspacePath, taskId: request.taskId }))
      ?.status,
    "failed",
  );
  await assert.rejects(service.prepare(request), /explicit retry/);
  fail = false;
  const binding = await service.prepare({ ...request, requestId: "retry", retrySetup: true });
  assert.equal(binding.status, "ready");
  assert.deepEqual(calls, ["first", "second", "second"]);
});

test("setup copy rejects traversal and tracked files without publishing a ready binding", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.prepare({
      workspacePath: f.repo,
      taskId: "traversal",
      requestId: "traversal",
      copyIgnoredPaths: ["../outside"],
    }),
    /inside|relative/,
  );
  await assert.rejects(
    f.service.prepare({
      workspacePath: f.repo,
      taskId: "tracked",
      requestId: "tracked",
      copyIgnoredPaths: ["file.txt"],
    }),
    /ignored files/,
  );
  assert.ok(
    (await f.service.list({ workspacePath: f.repo })).every(
      (binding) => binding.status === "failed",
    ),
  );
});

test("binding recovery accepts exact execution scope and preserves remote authority", async (t) => {
  const f = await fixture(t);
  const identity = "remote:ssh:host.example:22:fixture:/repo";
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    workspaceIdentity: identity,
    taskId: "A",
    requestId: "A",
  });
  assert.ok(binding.workspaceIdentity?.startsWith("remote:ssh:host.example:22:fixture:/"));
  assert.notEqual(binding.workspaceIdentity, identity);
  const restored = await createWorktreeService(f.options).getBinding({
    workspacePath: binding.workspacePath,
    workspaceIdentity: binding.workspaceIdentity,
    taskId: "A",
  });
  assert.equal(restored?.id, binding.id);
  assert.equal(
    await f.service.getBinding({
      workspacePath: binding.workspacePath,
      workspaceIdentity: "remote:ssh:other.example:22:fixture:/repo",
      taskId: "A",
    }),
    null,
  );
});

test("worktree methods reject extra RPC fields and unsafe record identifiers", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A", extra: true } as never),
  );
  await assert.rejects(f.service.getIntegration({ operationId: "../outside" }));
});

test("repeated creation cannot silently change the original base or project membership", async (t) => {
  const f = await fixture(t);
  const request = { workspacePath: f.repo, taskId: "A", requestId: "A", projectId: "project-A" };
  const binding = await f.service.prepare(request);
  await assert.rejects(
    f.service.prepare({ ...request, baseRef: "main" }),
    /creation scope or base changed/,
  );
  await assert.rejects(
    f.service.prepare({ ...request, projectId: "project-B" }),
    /creation scope or base changed/,
  );
  assert.equal(
    (await f.service.getBinding({ workspacePath: binding.workspacePath, taskId: "A" }))?.id,
    binding.id,
  );
});
