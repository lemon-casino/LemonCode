import assert from "node:assert/strict";
import test from "node:test";
import { resolveRootWorkspaceShellTarget } from "./rootWorkspaceShellTarget.js";

const remoteTarget = { kind: "ssh", host: "fixture-host" };

test("active workspace forwards remote target before identity and attachment are ready", () => {
  const result = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab: { workspacePath: "/repo", remoteTarget },
    activeWorkspacePath: "/repo",
    activeWorkspaceIdentity: null,
    workspaceTabs: [],
  });
  assert.equal(result.workspaceShellPath, "/repo");
  assert.equal(result.remoteTarget, remoteTarget);
});

test("settings-covered workspace keeps its full remote routing metadata", () => {
  const result = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab: null,
    activeWorkspacePath: "/same/path",
    activeWorkspaceIdentity: "remote:fixture",
    workspaceTabs: [
      { workspacePath: "/same/path" },
      {
        workspacePath: "/same/path",
        workspaceIdentity: "remote:fixture",
        remoteSessionId: "attachment",
        remoteTarget,
      },
    ],
  });
  assert.equal(result.workspaceIdentity, "remote:fixture");
  assert.equal(result.workspaceRemoteSessionId, "attachment");
  assert.equal(result.remoteTarget, remoteTarget);
});

test("a local target does not inherit remote metadata from another identity", () => {
  const result = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab: null,
    activeWorkspacePath: "/same/path",
    activeWorkspaceIdentity: null,
    workspaceTabs: [
      { workspacePath: "/same/path", workspaceIdentity: "remote:fixture", remoteTarget },
    ],
  });
  assert.equal(result.workspaceRemoteSessionId, undefined);
  assert.equal(result.remoteTarget, undefined);
});
