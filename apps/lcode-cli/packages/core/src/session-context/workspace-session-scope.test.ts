import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { canReadSessionContextFromWorkspace } from "./workspace-session-scope.js";

test("persisted workspace path is authoritative while old records retain directory fallback", () => {
  const root = resolve("scope-workspace-fixture");
  const workspace = { workspaceRoot: root };
  assert.equal(
    canReadSessionContextFromWorkspace(
      { path: root, directory: resolve(root, "child") },
      workspace,
    ),
    true,
  );
  assert.equal(
    canReadSessionContextFromWorkspace(
      { path: resolve("foreign-workspace"), directory: root },
      workspace,
    ),
    false,
  );
  assert.equal(canReadSessionContextFromWorkspace({ directory: root }, workspace), true);
  assert.equal(canReadSessionContextFromWorkspace({ path: "", directory: root }, workspace), true);
});

test("opaque identity remains stronger than a shared persisted path", () => {
  const root = resolve("identity-workspace-fixture");
  assert.equal(
    canReadSessionContextFromWorkspace(
      { path: root, directory: root, workspaceID: "other" },
      { workspaceRoot: root, workspaceIdentity: "current" },
    ),
    false,
  );
  assert.equal(
    canReadSessionContextFromWorkspace(
      { path: root, directory: root, workspaceID: "current" },
      { workspaceRoot: resolve("other-root"), workspaceIdentity: "current" },
    ),
    true,
  );
});
