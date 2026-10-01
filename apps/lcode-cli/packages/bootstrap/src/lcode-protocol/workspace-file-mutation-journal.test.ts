import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStorePort } from "@lcode/contracts";
import { readWorkspaceFileMutationJournal } from "./workspace-file-mutation-journal.js";

test("只读证据按 workspace identity 隔离，旧记录不被当作作者证明", async () => {
  const sessions = [
    { id: "A", workspaceID: "one", directory: "/repo", title: "增强 A" },
    { id: "B", workspaceID: "two", directory: "/repo", title: "增强 B" },
  ];
  const store = {
    listSessions: async () => sessions,
    sessionEntries: async ({ sessionID, type }: { sessionID: string; type?: string }) =>
      type === "runtime/workspace_file_rewind"
        ? []
        : [
            {
              id: sessionID,
              type: "runtime/workspace_checkpoint",
              data: { payload: { snapshotRef: sessionID } },
            },
          ],
  } as unknown as SessionStorePort;
  const readArtifact = async (uri: string) =>
    JSON.stringify({
      version: 1,
      kind: "workspace_file_before_change",
      provenance: "builtin_file_tool",
      createdAt: "2026-09-30T00:00:00Z",
      toolCallId: uri,
      toolName: "Edit",
      files: [
        {
          path: "/repo/x.ts",
          existedBefore: true,
          beforeContent: "a",
          afterContent: "b",
          structuredPatch: [],
        },
      ],
    });
  const result = await readWorkspaceFileMutationJournal({
    store,
    readArtifact,
    workspace: { workspacePath: "/repo", workspaceIdentity: "one", workspaceKey: "one" },
    paths: ["/repo/x.ts"],
  });
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.mutations.map((entry) => entry.sessionId),
    ["A"],
  );
  const old = await readWorkspaceFileMutationJournal({
    store,
    readArtifact: async (uri) =>
      (await readArtifact(uri)).replace(',"provenance":"builtin_file_tool"', ""),
    workspace: { workspacePath: "/repo", workspaceIdentity: "one", workspaceKey: "one" },
    paths: ["/repo/x.ts"],
  });
  assert.equal(old.mutations.length, 0);
});

test("缺失 artifact 不能被当作完整归属证据", async () => {
  const store = {
    listSessions: async () => [{ id: "A", directory: "/repo" }],
    sessionEntries: async () => [
      {
        id: "A",
        type: "runtime/workspace_checkpoint",
        data: { payload: { snapshotRef: "missing" } },
      },
    ],
  } as unknown as SessionStorePort;
  const result = await readWorkspaceFileMutationJournal({
    store,
    readArtifact: async () => {
      throw new Error("missing");
    },
    workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
    paths: ["/repo/x.ts"],
  });
  assert.equal(result.complete, false);
});

for (const kind of ["rewind", "limit", "revert"] as const) {
  test(`${kind} 不能生成可靠的会话归属`, async () => {
    const sessions = [
      { id: "A", directory: "/repo", ...(kind === "revert" ? { revert: {} } : {}) },
    ];
    const store = {
      listSessions: async () =>
        kind === "limit" ? Array.from({ length: 101 }, () => sessions[0]) : sessions,
      sessionEntries: async ({ type }: { type: string }) =>
        type === "runtime/workspace_file_rewind" ? [{}] : [],
    } as unknown as SessionStorePort;
    const result = await readWorkspaceFileMutationJournal({
      store,
      readArtifact: async () => {
        throw new Error("unexpected");
      },
      workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
      paths: ["/repo/x.ts"],
    });
    assert.equal(result.complete, false);
  });
}
