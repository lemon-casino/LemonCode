import assert from "node:assert/strict";
import test from "node:test";
import type { IGitBackupService } from "@lcode/services";
import {
  collectGitBackupWorkspaces,
  selectGitBackupWorkspaceCandidates,
} from "./gitBackupWorkspaceSelection.js";

const local = { workspacePath: "/same/path" };
const remote = {
  workspacePath: "/same/path",
  workspaceIdentity: "remote:one",
  remoteSessionId: "one",
};
const service = {} as IGitBackupService;
const state = {
  sessionsById: {
    one: { services: { gitBackupService: service } },
    two: { services: { gitBackupService: {} as IGitBackupService } },
  },
  sessionIdByWorkspaceIdentity: { "remote:one": "one" },
  sessionIdByWorkspacePath: { "/same/path": "one" },
};
const candidates = [
  local,
  remote,
  { workspacePath: "/other", workspaceIdentity: "remote:two", remoteSessionId: "two" },
  { workspacePath: "/waiting", workspaceIdentity: "remote:waiting" },
  { workspacePath: "/same/path", remoteTarget: {} },
  { workspacePath: "/unbound", remoteSessionId: "missing" },
];

test("local candidates exclude every remote metadata shape, including disconnected tabs", () => {
  assert.deepEqual(
    selectGitBackupWorkspaceCandidates(candidates, "local-ready", service, null, state),
    [local],
  );
});

test("remote candidates require the same attachment or proven backup service, never a shared path", () => {
  assert.deepEqual(
    selectGitBackupWorkspaceCandidates(candidates, "remote-ready", service, "one", state),
    [{ workspacePath: remote.workspacePath, workspaceIdentity: remote.workspaceIdentity }],
  );
  assert.deepEqual(
    selectGitBackupWorkspaceCandidates(candidates, "remote-waiting", null, null, state),
    [],
  );
});

test("selection rows keep closed registered targets and separate identities on the same path", () => {
  const closed = { workspacePath: "/closed" };
  assert.deepEqual(collectGitBackupWorkspaces([local], remote, [closed, local, remote]), [
    local,
    { workspacePath: remote.workspacePath, workspaceIdentity: remote.workspaceIdentity },
    closed,
  ]);
  assert.deepEqual(collectGitBackupWorkspaces([local], null, []), [local]);
});

test("different attachments are included only when the registry proves the same backup owner", () => {
  const sharedOwner = {
    ...state,
    sessionsById: { ...state.sessionsById, two: { services: { gitBackupService: service } } },
  };
  const selected = selectGitBackupWorkspaceCandidates(
    candidates,
    "remote-ready",
    service,
    "one",
    sharedOwner,
  );
  assert.deepEqual(
    selected.map((item) => item.workspaceIdentity),
    ["remote:one", "remote:two"],
  );
});
