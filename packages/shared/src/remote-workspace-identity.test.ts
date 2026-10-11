import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  replaceRemoteWorkspaceIdentityPath,
} from "./remote-workspace-identity.js";
import type { RemoteTarget } from "./remoteTarget.js";

test("remote job identities round-trip IPv6 without migrating persisted authority or path", () => {
  const targets: RemoteTarget[] = [
    ...["example.invalid", "192.0.2.1", "2001:db8::1", "[2001:db8::1]", "::1"].map((host) => ({
      kind: "ssh" as const,
      host,
      port: 2222,
      username: "tester",
    })),
    { kind: "wsl", distro: "TestDistro" },
    { kind: "wsl", distro: "TestDistro", user: "tester" },
    { kind: "docker", container: "test-container" },
  ];
  for (const target of targets) {
    const path = "/project:one/with:/nested path";
    const identity = buildRemoteWorkspaceIdentity(path, target);
    assert.deepEqual(parseRemoteWorkspaceIdentity(identity), {
      kind: target.kind,
      workspacePath: path,
    });
    assert.equal(isRemoteWorkspaceIdentity(identity), true);
    const next = replaceRemoteWorkspaceIdentityPath(identity, "/worktrees/task");
    assert.equal(next, identity.slice(0, -path.length) + "/worktrees/task");
  }
});

test("invalid identities are not interpreted as remote workspaces", () => {
  for (const identity of [
    "/local",
    "remote:unknown:host:/repo",
    "remote:ssh::22:user:/repo",
    "remote:ssh:host::user:/repo",
    "remote:ssh:host:22::/repo",
    "remote:ssh:host:22:user:relative",
    "remote:wsl::/repo",
    "remote:docker::/repo",
  ])
    assert.equal(parseRemoteWorkspaceIdentity(identity), null, identity);
});
