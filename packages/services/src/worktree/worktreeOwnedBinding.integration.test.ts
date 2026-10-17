import assert from "node:assert/strict";
import test from "node:test";
import { createPublicWorktreeService, createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("execution-set bindings have explicit owners and durable consumers without synthetic sessions", async (t) => {
  const { service, repo, options } = await fixture(t);
  const ownerRef = { kind: "executionSet" as const, executionSetId: "set", repositoryId: "frontend" };
  const request = { workspacePath: repo, requestId: "prepare", ownerRef, setupCommands: [] };
  const binding = await service.prepareOwnedBinding(request);
  assert.equal(binding.taskId, undefined);
  assert.deepEqual(binding.ownerRef, ownerRef);
  const restarted = createWorktreeService(options);
  assert.equal((await restarted.prepareOwnedBinding(request)).id, binding.id);
  assert.equal((await restarted.getOwnedBinding({ workspacePath: repo, ownerRef }))?.id, binding.id);
  assert.equal(await restarted.getBinding({ workspacePath: repo, taskId: "set" }), null);
  assert.equal((await restarted.getBinding({ workspacePath: repo, bindingId: binding.id }))?.id, binding.id);
  await assert.rejects(restarted.getBinding({ workspacePath: repo, workspaceIdentity: "foreign", bindingId: binding.id }), /scope/);
  await assert.rejects(restarted.archive({ bindingId: binding.id, requestId: "archive" }), /consumer/i);
  assert.equal("prepareOwnedBinding" in createPublicWorktreeService(restarted), false);
  await restarted.detachBindingConsumer({ bindingId: binding.id, owner: ownerRef, operationId: "stop", stopReceipt: { stopped: true, operationId: "stop" } });
  assert.equal((await restarted.archive({ bindingId: binding.id, requestId: "archive" })).status, "archived");
});
