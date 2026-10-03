import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { ForkCommitBundle } from "@lcode/contracts";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createTurnId,
  RewindScope,
  SessionEventType,
} from "../deps.js";
import type {
  FileSystemPort,
  MessageWithParts,
  SessionInfo,
  SessionStorePort,
  ToolArtifactStorePort,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import type { StableConversationForkTarget } from "../types.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { forkStableConversationAtMessage } from "./session-fork.js";
import { applyWorkspaceFileRewind, previewWorkspaceFileRewind } from "./file-rewind.js";

function forkFixture() {
  const { runtime } = createMockRuntime();
  const userId = createMessageId();
  const assistantId = createMessageId();
  const turnId = createTurnId();
  const anchor = {
    turnId,
    productTurnId: String(userId),
    orderedMessageIds: [userId, assistantId],
    boundaryMessageId: assistantId,
  };
  const parent = {
    id: runtime.sessionId,
    projectID: createProjectId(),
    workspaceID: "opaque-remote-identity",
    slug: "mock-parent",
    title: "Mock parent",
    directory: "remote-workspace",
    path: "remote-workspace/",
    version: "test",
    time: { created: 1, updated: 1 },
  } as SessionInfo;
  const messages = [
    {
      info: {
        id: userId,
        sessionID: runtime.sessionId,
        role: "user",
        time: { created: 1 },
        anchor,
      },
      parts: [
        {
          id: createPartId(),
          messageID: userId,
          sessionID: runtime.sessionId,
          type: "text",
          text: "question",
        },
      ],
    },
    {
      info: {
        id: assistantId,
        sessionID: runtime.sessionId,
        parentID: userId,
        role: "assistant",
        mode: "build",
        planEnabled: true,
        time: { created: 2, completed: 3 },
        anchor,
      },
      parts: [
        {
          id: createPartId(),
          messageID: assistantId,
          sessionID: runtime.sessionId,
          type: "text",
          text: "answer",
        },
      ],
    },
  ] as MessageWithParts[];
  const target = {
    orderedMessageIds: [String(userId), String(assistantId)],
    boundaryMessageId: String(assistantId),
  } as StableConversationForkTarget;
  return { runtime, parent, messages, target };
}

test("stable fork atomically remaps child identities and publishes only after durable commit", async () => {
  const { runtime, parent, messages, target } = forkFixture();
  const order: string[] = [];
  let bundle: ForkCommitBundle | undefined;
  const original = JSON.stringify(messages);
  runtime.sessionStore = {
    getSession: async () => parent,
    messages: async () => messages,
    commitForkBundle: async (input: ForkCommitBundle) => {
      bundle = input;
      order.push("commit");
      return { ...parent, id: input.child.id };
    },
  } as unknown as SessionStorePort;
  runtime.appendEvent = async () => {
    order.push("event");
    throw false;
  };
  const result = await forkStableConversationAtMessage.call(runtime, {
    sourceCommandId: "fork-command",
    goalBoundary: { kind: "none" },
    target,
  });
  assert.deepEqual(order, ["commit", "event"]);
  assert.ok(bundle);
  assert.equal(result.forkedSessionId, bundle.child.id);
  assert.equal(bundle.child.workspaceID, parent.workspaceID);
  assert.equal(bundle.child.path, parent.path);
  assert.notEqual(bundle.messages[0]?.info.id, messages[0]?.info.id);
  assert.notEqual(bundle.messages[1]?.info.anchor?.turnId, messages[1]?.info.anchor?.turnId);
  const childAssistant = bundle.messages[1];
  assert.ok(childAssistant);
  assert.equal(childAssistant.info.role, "assistant");
  assert.equal((childAssistant.info as { parentID: string }).parentID, bundle.messages[0]?.info.id);
  assert.equal(JSON.stringify(messages), original);
});

test("invalid stable fork boundary fails before child commit", async () => {
  const { runtime, parent, messages, target } = forkFixture();
  let commits = 0;
  runtime.sessionStore = {
    getSession: async () => parent,
    messages: async () => messages,
    commitForkBundle: async () => {
      commits += 1;
      throw new Error("must not commit");
    },
  } as unknown as SessionStorePort;
  await assert.rejects(
    forkStableConversationAtMessage.call(runtime, {
      sourceCommandId: "fork-command",
      goalBoundary: { kind: "none" },
      target: {
        ...target,
        orderedMessageIds: [target.boundaryMessageId, target.boundaryMessageId],
      },
    }),
    /duplicate/,
  );
  assert.equal(commits, 0);
});

test("isolated fork commits the child path and new binding in the same atomic bundle", async () => {
  const { runtime, parent, messages, target } = forkFixture();
  let bundle: ForkCommitBundle | undefined;
  runtime.sessionStore = {
    getSession: async () => parent,
    messages: async () => messages,
    commitForkBundle: async (input: ForkCommitBundle) => {
      bundle = input;
      return { ...parent, ...input.child };
    },
  } as unknown as SessionStorePort;
  runtime.appendEvent = async () => {
    throw false;
  };
  const path = resolve("isolated-fork-workspace");
  await forkStableConversationAtMessage.call(runtime, {
    sourceCommandId: "isolated-command",
    target,
    goalBoundary: { kind: "none" },
    commandResultType: "forkSession",
    forkWorkspace: {
      directory: path,
      path,
      workspaceID: "fork-identity",
      binding: {
        workspaceKey: "fork-identity",
        workspacePath: path,
        workspaceIdentity: "fork-identity",
        executionBindingId: "binding-new",
        originWorkspacePath: parent.path ?? parent.directory,
      },
    },
  });
  assert.equal(bundle?.child.path, path);
  assert.equal(bundle?.child.workspaceID, "fork-identity");
  const entry = bundle?.entries.find((entry) => entry.type === "runtime/worktree_binding");
  assert.equal((entry?.data as { executionBindingId: string }).executionBindingId, "binding-new");
  assert.equal((entry?.data as { bindingOwnerTaskId?: string }).bindingOwnerTaskId, undefined);
  assert.equal(bundle?.commandFact?.ack.result?.type, "forkSession");
  assert.notEqual(parent.path, path);
});

async function rewindFixture() {
  const { runtime, storedEvents } = createMockRuntime();
  runtime.workspaceRoot = resolve("mock-workspace");
  const path = resolve(runtime.workspaceRoot, "one.txt");
  const files = new Map([[path, "after"]]);
  const writes: string[] = [];
  const artifact: WorkspaceCheckpointArtifact = {
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCallId: "tool-1",
    toolName: "Write",
    files: [
      {
        path: "one.txt",
        beforeContent: "before",
        afterContent: "after",
        existedBefore: true,
        structuredPatch: [],
      },
    ],
  };
  runtime.artifactStore = {
    readToolResultArtifact: async () => ({ content: JSON.stringify(artifact) }),
  } as unknown as ToolArtifactStorePort;
  runtime.fileSystemPort = {
    readTextFile: async (input: { path: string }) => ({ content: files.get(input.path) }),
    writeTextFile: async (input: { path: string; content: string }) => {
      files.set(input.path, input.content);
      writes.push(input.content);
      return {};
    },
  } as unknown as FileSystemPort;
  const targetMessageId = createMessageId();
  await runtime.appendEvent(
    runtime.createEvent(
      SessionEventType.CheckpointCreated,
      {
        checkpointId: "checkpoint-1",
        messageId: targetMessageId,
        scope: RewindScope.Workspace,
        snapshotRef: "artifact://checkpoint-1",
        fileCount: 1,
      },
      runtime.rootTraceContext,
    ),
    runtime.rootTraceContext,
  );
  return { runtime, storedEvents, targetMessageId, files, path, writes };
}

test("file rewind compensates a falsy commit failure before returning and emits no rewind event", async () => {
  const { runtime, storedEvents, targetMessageId, files, path, writes } = await rewindFixture();
  const result = await applyWorkspaceFileRewind.call(runtime, {
    targetMessageId,
    commitAfterApply: async () => {
      throw 0;
    },
  });
  assert.equal(result.applied, false);
  assert.equal(files.get(path), "after");
  assert.deepEqual(writes, ["before", "after"]);
  assert.ok(!storedEvents.some((event) => event.type === SessionEventType.RewindTriggered));
});

test("file rewind keeps external modification safety and never writes an unsafe path", async () => {
  const { runtime, targetMessageId, files, path, writes } = await rewindFixture();
  files.set(path, "external change");
  const preview = await previewWorkspaceFileRewind.call(runtime, { targetMessageId });
  assert.equal(preview.canApply, false);
  assert.equal(preview.unsafeFiles[0]?.reason, "external_modified");
  const result = await applyWorkspaceFileRewind.call(runtime, { targetMessageId });
  assert.equal(result.applied, false);
  assert.deepEqual(writes, []);
  assert.equal(files.get(path), "external change");
});
