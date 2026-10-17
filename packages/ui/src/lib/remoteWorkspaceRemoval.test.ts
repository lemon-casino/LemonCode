import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, buildRemoteWorkspaceIdentity } from "@lcode/shared";
import {
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "./remoteWorkspaceHistory.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

test("legacy history uses the same remote identity for display, persistence and removal", () => {
  const first = { kind: "ssh" as const, host: "first.invalid", username: "fixture" };
  const second = { ...first, host: "second.invalid" };
  const settings = appSettingsSchema.parse({
    lastWorkspaceSession: [
      { kind: "local", workspacePath: "/" },
      ...[first, second].map((target) => ({
        kind: "remote",
        workspacePath: "/",
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      })),
    ],
  });
  const entries = getRemoteWorkspaceSessionEntries(settings);
  const firstIdentity = buildRemoteWorkspaceIdentity("/", first);
  const secondIdentity = buildRemoteWorkspaceIdentity("/", second);
  assert.deepEqual(
    entries.map((entry) => entry.workspaceIdentity),
    [firstIdentity, secondIdentity],
  );
  const removal = removeRemoteWorkspaceSessionEntries(entries, [firstIdentity]);
  assert.deepEqual(
    removal.nextRemoteSessions.map((entry) => entry.workspaceIdentity),
    [secondIdentity],
  );
  assert.equal(settings.lastWorkspaceSession?.[1]?.kind, "remote");
  assert.equal("workspaceIdentity" in settings.lastWorkspaceSession![1]!, false);
  assert.deepEqual(
    removeRemoteWorkspaceSessionEntries(removal.nextRemoteSessions, [firstIdentity]),
    {
      nextRemoteSessions: removal.nextRemoteSessions,
      credentialKeysToDelete: [],
    },
  );
});

test("late reconnect failures cannot recreate a removed history entry, while RPC still rejects", async () => {
  for (const throwOnFailure of [false, true]) {
    let writes = 0;
    let toasts = 0;
    const error = new Error("Fixture late reconnect failure");
    const attempt = reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry: {
        kind: "remote",
        workspacePath: "/",
        target: { kind: "ssh", host: "fixture.invalid", username: "fixture" },
        lastOpenedAt: 1,
        lastConnectionStatus: "failed",
      },
      activateTabByPath: () => false,
      setReconnectingRemoteWorkspaceKeys: () => {},
      loadCredential: async () => null,
      connectRemoteWorkspaceTarget: async () => {
        throw error;
      },
      resolveRemoteWorkspaceCanonicalPath: async (_id, path) => path,
      disposeRemoteWorkspaceSession: async () => {},
      bindRemoteWorkspaceSessionContext: async () => {},
      bindRemoteWorkspacePath: () => {},
      bindRemoteWorkspaceIdentity: () => {},
      upsertWorkspaceTab: () => {
        throw new Error("Removed tab must not reopen");
      },
      commitRemoteWorkspaceSessionMutation: async (mutation) => {
        writes++;
        return mutation.entry;
      },
      getRemoteSessions: () => [],
      shouldKeepReconnectedWorkspace: () => false,
      logger: { warn: () => {} },
      toast: () => {
        return ++toasts;
      },
      options: { throwOnFailure },
    });
    if (throwOnFailure) await assert.rejects(attempt, error);
    else await attempt;
    assert.equal(writes, 0);
    assert.equal(toasts, 0);
  }
});
