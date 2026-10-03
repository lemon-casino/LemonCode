import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRemoteWorkspaceIdentity,
  replaceRemoteWorkspaceIdentityPath,
} from "./remote-workspace-identity.js";

test("worktrees preserve SSH, Docker and WSL authorities while changing execution paths", () => {
  for (const authority of [
    "remote:ssh:example:22:user:",
    "remote:docker:container:",
    "remote:wsl:Ubuntu:",
    "remote:wsl:Ubuntu:lemon:",
  ]) {
    const next = replaceRemoteWorkspaceIdentityPath(
      `${authority}/project:original`,
      "/worktrees/task a/",
    );
    assert.equal(next, `${authority}/worktrees/task a`);
    assert.equal(parseRemoteWorkspaceIdentity(next!)?.workspacePath, "/worktrees/task a");
  }
  assert.equal(replaceRemoteWorkspaceIdentityPath("/local", "/worktree"), null);
  assert.equal(replaceRemoteWorkspaceIdentityPath("remote:ssh:broken", "/worktree"), null);
});
