import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("fork registration persists one root owner and resolves both scopes after restart", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  const request = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  assert.equal((await f.service.prepare(request)).id, owner.id);
  assert.equal((await f.service.prepare(request)).taskId, "owner");
  const reopened = createWorktreeService(f.options);
  assert.equal(
    (await reopened.getBinding({ workspacePath: f.repo, taskId: "child" }))?.id,
    owner.id,
  );
  assert.equal(
    (await reopened.getBinding({ workspacePath: owner.workspacePath, taskId: "child" }))?.id,
    owner.id,
  );
  assert.equal((await reopened.list({ workspacePath: f.repo })).length, 1);
});

test("fork descendants require a registered parent and cannot change checkout", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  const second = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "second",
    requestId: "second",
  });
  const child = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  await f.service.prepare(child);
  await assert.rejects(
    f.service.prepare({
      ...child,
      parentBinding: { bindingId: second.id, bindingOwnerTaskId: "second", parentTaskId: "second" },
    }),
    /cannot change/,
  );
  await assert.rejects(
    f.service.prepare({
      ...child,
      taskId: "grandchild",
      parentBinding: { ...child.parentBinding, parentTaskId: "unknown" },
    }),
    /not registered/,
  );
  assert.equal(
    (
      await f.service.prepare({
        ...child,
        taskId: "grandchild",
        parentBinding: { ...child.parentBinding, parentTaskId: "child" },
      })
    ).id,
    owner.id,
  );
  await assert.rejects(
    f.service.prepare({ workspacePath: f.repo, taskId: "child", requestId: "new-tree" }),
    /already uses/,
  );
});

test("managed forks share one reference in-place and prepare from the new checkout snapshot", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, ".node-version"), "24.14.0\n");
  await f.command(f.repo, "add", ".node-version");
  await f.command(f.repo, "commit", "-m", "declare runtime");
  const prepared: { bindingId: string; checkoutPath: string; declaration: string }[] = [];
  const options = {
    ...f.options,
    prepareRuntimeEnvironment: async (params: { bindingId: string; checkoutPath: string }) => {
      prepared.push({ ...params, declaration: await readFile(join(params.checkoutPath, ".node-version"), "utf8") });
      return { environmentId: createHash("sha256").update(params.bindingId).digest("hex").slice(0, 32), revision: 1, manifestDigest: `manifest-${params.bindingId}` };
    },
    resolveRuntimeEnvironment: async (params: { bindingId: string; environmentRef: { environmentId: string; revision: number } }) => ({ ...params.environmentRef, manifestDigest: `manifest-${params.bindingId}` }),
  };
  const service = createWorktreeService(options);
  const owner = await service.prepare({ workspacePath: f.repo, taskId: "owner", requestId: "owner", environmentPolicy: "managed" });
  const same = await service.prepare({
    workspacePath: f.repo, taskId: "child", requestId: "same",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  });
  assert.deepEqual(same.environmentRef, owner.environmentRef);
  assert.equal(prepared.length, 1);
  await writeFile(join(owner.checkoutPath, ".node-version"), "22.20.0\n");
  const separate = await service.prepare({
    workspacePath: f.repo, taskId: "new-tree", requestId: "new-tree", environmentPolicy: "managed",
    forkSource: { workspacePath: owner.workspacePath },
  });
  assert.equal(prepared.length, 2);
  assert.equal(prepared[1]?.declaration, "22.20.0\n");
  assert.notEqual(separate.environmentRef?.environmentId, owner.environmentRef?.environmentId);
  assert.notEqual(separate.checkoutPath, owner.checkoutPath);
  const reopened = createWorktreeService(options);
  assert.deepEqual((await reopened.getBinding({ workspacePath: f.repo, taskId: "child" }))?.environmentRef, owner.environmentRef);
  assert.deepEqual((await reopened.getBinding({ workspacePath: f.repo, taskId: "new-tree" }))?.environmentRef, separate.environmentRef);
});

test("fork registration rejects foreign origins and independent child owners", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  await f.service.prepare({ workspacePath: f.repo, taskId: "child", requestId: "child" });
  const request = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  await assert.rejects(f.service.prepare(request), /already owns/);
  await assert.rejects(
    f.service.prepare({ ...request, taskId: "foreign", workspacePath: join(f.root, "other") }),
    /original workspace/,
  );
  await assert.rejects(f.service.prepare({ ...request, taskId: "owner" }), /own task ID/);
});
