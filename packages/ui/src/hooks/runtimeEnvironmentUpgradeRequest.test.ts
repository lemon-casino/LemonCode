import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeBinding } from "@lcode/services";
import { restoreEnvironmentUpgradeRequest } from "./runtimeEnvironmentModel.js";

const scope = { workspacePath: "C:/tree", workspaceIdentity: "remote-a" };
const oldRef = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" };
const binding = {
  id: "binding",
  checkoutPath: scope.workspacePath,
  workspacePath: scope.workspacePath,
  workspaceIdentity: scope.workspaceIdentity,
  status: "updating",
  environmentUpgrade: { requestId: "original" },
  environmentRef: { ...oldRef, revision: 2, manifestDigest: "new" },
  environmentRebuild: {
    oldEnvironmentRef: oldRef,
    newEnvironmentRef: { ...oldRef, revision: 2, manifestDigest: "new" },
    status: "failed",
  },
} as WorktreeBinding;

test("restores a failed upgrade from the Host journal with its original reference after remount", () => {
  assert.deepEqual(restoreEnvironmentUpgradeRequest(scope, binding), {
    ...scope,
    bindingId: "binding",
    requestId: "original",
    purpose: "worktree",
    operation: "upgrade",
    environmentId: oldRef.environmentId,
    expectedRevision: 1,
    expectedManifestDigest: "old",
  });
});

test("subdirectory upgrades restore only their public execution scope for local and remote bindings", () => {
  for (const workspaceIdentity of [undefined, "remote-a"]) {
    const executionScope = { workspacePath: "C:/tree/packages/app", workspaceIdentity };
    const scopedBinding = { ...binding, ...executionScope };
    const request = restoreEnvironmentUpgradeRequest(executionScope, scopedBinding);
    assert.equal(request?.requestId, "original");
    assert.equal(request?.workspacePath, executionScope.workspacePath);
    assert.equal(request?.workspaceIdentity, workspaceIdentity);
    assert.equal(
      restoreEnvironmentUpgradeRequest(
        { ...executionScope, workspacePath: scopedBinding.checkoutPath },
        scopedBinding,
      ),
      undefined,
    );
    assert.equal(
      restoreEnvironmentUpgradeRequest(
        { ...executionScope, workspacePath: "C:/project/packages/app" },
        scopedBinding,
      ),
      undefined,
    );
    assert.equal(
      restoreEnvironmentUpgradeRequest(
        { ...executionScope, workspaceIdentity: "another-owner" },
        scopedBinding,
      ),
      undefined,
    );
  }
});

test("never restores another identity/path, a cancelled request, or an incomplete/settled journal", () => {
  assert.equal(
    restoreEnvironmentUpgradeRequest({ ...scope, workspaceIdentity: "remote-b" }, binding),
    undefined,
  );
  assert.equal(
    restoreEnvironmentUpgradeRequest({ ...scope, workspacePath: "C:/other" }, binding),
    undefined,
  );
  assert.equal(restoreEnvironmentUpgradeRequest(scope, { ...binding, status: "ready" }), undefined);
  assert.equal(
    restoreEnvironmentUpgradeRequest(scope, {
      ...binding,
      environmentUpgrade: { requestId: "original", cancelled: true },
    }),
    undefined,
  );
  assert.equal(
    restoreEnvironmentUpgradeRequest(scope, { ...binding, environmentRebuild: undefined }),
    undefined,
  );
});
