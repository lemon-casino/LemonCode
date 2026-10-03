import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeBinding } from "@lcode/services";
import { resolveWorktreeFileTarget } from "./worktreeFileTarget.js";

const binding: WorktreeBinding = {
  id: "binding",
  taskId: "task",
  requestId: "request",
  workspacePath: "C:/trees/task/packages/ui",
  originalWorkspacePath: "C:/项目/repo/packages/ui",
  repositoryRoot: "C:/项目/repo",
  commonDirectory: "C:/项目/repo/.git",
  checkoutPath: "C:/trees/task",
  branch: "lcode/task",
  baseCommit: "a".repeat(40),
  targetBranch: "L-GO",
  sourceFolderPaths: ["C:/项目/repo/packages/ui"],
  status: "ready",
  createdAt: "2026-10-02",
  updatedAt: "2026-10-02",
};

test("file tree maps repository subfolders and reveal paths to the session checkout", () => {
  const target = {
    workspacePath: "c:\\项目\\repo\\packages\\ui",
    workspaceName: "UI",
    revealPath: "C:/项目/repo/packages/ui/空 格.ts",
    temporaryExternalDirectory: true,
  };
  const result = resolveWorktreeFileTarget(target, binding);
  assert.equal(result.workspacePath, "C:/trees/task/packages/ui");
  assert.equal(result.revealPath, "C:/trees/task/packages/ui/空 格.ts");
  assert.equal(result.temporaryExternalDirectory, true);
  assert.equal(result.workspaceName, "UI");
  assert.equal(target.workspacePath, "c:\\项目\\repo\\packages\\ui");
});

test("outside paths and explicit traversal cannot be redirected into a worktree", () => {
  for (const workspacePath of ["C:/项目/repo-other", "C:/项目/repo/../private", "D:/项目/repo"]) {
    const target = { workspacePath };
    assert.equal(resolveWorktreeFileTarget(target, binding), target);
  }
});

test("remote file roots preserve authority while replacing the identity path", () => {
  const remote = {
    ...binding,
    originalWorkspacePath: "/srv/repo/ui",
    repositoryRoot: "/srv/repo",
    checkoutPath: "/srv/trees/task",
    workspacePath: "/srv/trees/task/ui",
    originalWorkspaceIdentity: "remote:docker:dev:/srv/repo/ui",
    workspaceIdentity: "remote:docker:dev:/srv/trees/task/ui",
  };
  const target = {
    workspacePath: "/srv/repo/core",
    workspaceIdentity: remote.originalWorkspaceIdentity,
    workspaceRemoteSessionId: "connection",
  };
  const result = resolveWorktreeFileTarget(target, remote);
  assert.equal(result.workspacePath, "/srv/trees/task/core");
  assert.equal(result.workspaceIdentity, "remote:docker:dev:/srv/trees/task/core");
  assert.equal(result.workspaceRemoteSessionId, "connection");
  const otherHost = { ...target, workspaceIdentity: "remote:docker:other:/srv/repo/ui" };
  assert.equal(resolveWorktreeFileTarget(otherHost, remote), otherHost);
});
