import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, buildRemoteWorkspaceIdentity, type RemoteTarget } from "@lcode/shared";
import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { resolveSessionConfigurationProjects } from "./useSessionConfigurationProjects.js";

const path = "/fixture/repo";
const targets: [RemoteTarget, RemoteTarget, RemoteTarget] = [
  { kind: "ssh", host: "fixture.invalid", username: "fixture" },
  { kind: "wsl", distro: "Fixture" },
  { kind: "docker", container: "fixture" },
];
const settings = appSettingsSchema.parse({
  recentProjects: [path],
  localProjects: [
    { id: "local", name: "Local", primaryFolderPath: path, sourceFolderPaths: [path] },
  ],
  lastWorkspaceSession: targets.map((target) => ({
    kind: "remote",
    workspacePath: path,
    target,
    lastOpenedAt: 1,
    lastConnectionStatus: "connected",
  })),
});

test("saved remote projects derive identities without merging equal local/remote paths", () => {
  const result = resolveSessionConfigurationProjects({
    settings,
    workspaceTabs: [],
    worktreeEntries: [],
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
  });
  assert.equal(result.length, 4);
  assert.equal(result[0]!.label, "Local");
  assert.deepEqual(
    result.slice(1).map((item) => item.workspaceIdentity),
    targets.map((target) => buildRemoteWorkspaceIdentity(path, target)),
  );
  assert.deepEqual(
    result.slice(1).map((item) => item.remoteTarget?.kind),
    ["ssh", "wsl", "docker"],
  );
  const saved = settings.lastWorkspaceSession?.[0];
  assert.equal(saved?.kind, "remote");
  if (saved?.kind === "remote") assert.equal(saved.workspaceIdentity, undefined);
});

test("live registry metadata works without tabs and replaces stale tab routing by exact identity", () => {
  const identity = buildRemoteWorkspaceIdentity(path, targets[1]);
  const live = {
    sessionId: "current",
    workspacePath: path,
    workspaceIdentity: identity,
    target: targets[1],
    services: {} as IServiceAccessor,
  };
  const result = resolveSessionConfigurationProjects({
    settings,
    workspaceTabs: [
      {
        id: "old",
        kind: "workspace",
        label: "Opened WSL",
        workspacePath: path,
        workspaceIdentity: identity,
        remoteSessionId: "old",
      },
    ],
    worktreeEntries: [],
    sessionsById: { current: live },
    sessionIdByWorkspaceIdentity: { [identity]: "current" },
  });
  const project = result.find((item) => item.workspaceIdentity === identity)!;
  assert.equal(result.length, 4);
  assert.equal(project.label, "Opened WSL");
  assert.equal(project.remoteTarget?.kind, "wsl");
  assert.equal(project.remoteSessionId, "current");
});

test("execution worktrees stay attached to the original project scope", () => {
  const target = targets[0];
  const originalIdentity = buildRemoteWorkspaceIdentity(path, target);
  const treePath = "/fixture/tree";
  const treeIdentity = buildRemoteWorkspaceIdentity(treePath, target);
  const origin: WorkspaceTabState = {
    id: "origin",
    kind: "workspace",
    label: "SSH origin",
    workspacePath: path,
    workspaceIdentity: originalIdentity,
    remoteTarget: target,
  };
  const tree: WorkspaceTabState = {
    ...origin,
    id: "tree",
    label: "Execution",
    workspacePath: treePath,
    workspaceIdentity: treeIdentity,
  };
  const binding = {
    id: "binding",
    workspacePath: treePath,
    checkoutPath: treePath,
    workspaceIdentity: treeIdentity,
    originalWorkspacePath: path,
    originalWorkspaceIdentity: originalIdentity,
  } as WorktreeBinding;
  const result = resolveSessionConfigurationProjects({
    settings,
    workspaceTabs: [tree],
    worktreeEntries: [{ origin, binding }],
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
  });
  assert.equal(result.length, 4);
  assert.equal(
    result.some((item) => item.workspaceIdentity === treeIdentity),
    false,
  );
  assert.equal(
    result.find((item) => item.workspaceIdentity === originalIdentity)?.label,
    "SSH origin",
  );
});
