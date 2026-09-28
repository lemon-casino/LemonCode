import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ReadSessionContextOutputSchema,
  type MessageId,
  type MessageWithParts,
  type PartId,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import { canReadSessionContextFromWorkspace } from "../../session-context/read-session-context.js";
import type { ToolExecutionContext } from "../types.js";
import { readSessionContextToolEntry } from "./read-session-context.js";

const WORKSPACE_A = resolve("workspace-a");
const WORKSPACE_B = resolve("workspace-b");

test("workspace guard implements the identity-first isolation matrix", () => {
  const cases = [
    {
      name: "local sessions with the same normalized directory are allowed",
      currentIdentity: undefined,
      currentRoot: WORKSPACE_A,
      targetIdentity: undefined,
      targetDirectory: join(WORKSPACE_A, "."),
      expected: true,
    },
    {
      name: "local sessions in another directory are rejected",
      currentIdentity: undefined,
      currentRoot: WORKSPACE_A,
      targetIdentity: undefined,
      targetDirectory: WORKSPACE_B,
      expected: false,
    },
    {
      name: "matching remote identities are allowed",
      currentIdentity: "remote:workspace-a",
      currentRoot: WORKSPACE_A,
      targetIdentity: "remote:workspace-a",
      targetDirectory: WORKSPACE_B,
      expected: true,
    },
    {
      name: "remote identities cannot fall back to the same directory",
      currentIdentity: "remote:workspace-a",
      currentRoot: WORKSPACE_A,
      targetIdentity: "remote:workspace-b",
      targetDirectory: WORKSPACE_A,
      expected: false,
    },
    {
      name: "identified runtimes reject legacy targets without identity",
      currentIdentity: "remote:workspace-a",
      currentRoot: WORKSPACE_A,
      targetIdentity: undefined,
      targetDirectory: WORKSPACE_A,
      expected: false,
    },
    {
      name: "local runtimes reject identified targets",
      currentIdentity: undefined,
      currentRoot: WORKSPACE_A,
      targetIdentity: "remote:workspace-a",
      targetDirectory: WORKSPACE_A,
      expected: false,
    },
  ] as const;

  for (const fixture of cases) {
    assert.equal(
      canReadSessionContextFromWorkspace(
        createSession({
          directory: fixture.targetDirectory,
          workspaceID: fixture.targetIdentity,
        }),
        {
          workspaceIdentity: fixture.currentIdentity,
          workspaceRoot: fixture.currentRoot,
        },
      ),
      fixture.expected,
      fixture.name,
    );
  }
});

test("out-of-scope sessions reuse not_found and never read messages", async () => {
  const cases = [
    {
      name: "different local directory",
      currentIdentity: undefined,
      targetIdentity: undefined,
      targetDirectory: WORKSPACE_B,
    },
    {
      name: "different remote identity with the same directory",
      currentIdentity: "remote:workspace-a",
      targetIdentity: "remote:workspace-b",
      targetDirectory: WORKSPACE_A,
    },
    {
      name: "legacy target without identity in an identified runtime",
      currentIdentity: "remote:workspace-a",
      targetIdentity: undefined,
      targetDirectory: WORKSPACE_A,
    },
    {
      name: "identified target in a local runtime",
      currentIdentity: undefined,
      targetIdentity: "remote:workspace-a",
      targetDirectory: WORKSPACE_A,
    },
  ] as const;

  for (const fixture of cases) {
    let messageReads = 0;
    const sessionStore = createSessionStore(
      createSession({
        directory: fixture.targetDirectory,
        workspaceID: fixture.targetIdentity,
      }),
      async () => {
        messageReads++;
        throw new Error("cross-workspace transcript must not be read");
      },
    );

    const output = ReadSessionContextOutputSchema.parse(
      await readSessionContextToolEntry.handler(
        {
          sessionId: "sess_target",
          query: "current implementation state",
          strategy: "relevant",
        },
        createExecutionContext({
          sessionStore,
          workspaceIdentity: fixture.currentIdentity,
          workspaceRoot: WORKSPACE_A,
        }),
      ),
    );

    assert.equal(output.status, "not_found", fixture.name);
    assert.equal(output.source, "none", fixture.name);
    assert.equal(output.content, "No persisted session was found for sess_target.", fixture.name);
    assert.equal(messageReads, 0, fixture.name);
  }
});

test("missing and out-of-scope sessions have the same public result", async () => {
  const outsideStore = createSessionStore(
    createSession({ directory: WORKSPACE_B }),
    async () => [],
  );
  const missingStore = createSessionStore(null, async () => []);
  const input = {
    sessionId: "sess_target",
    query: "current implementation state",
    strategy: "relevant" as const,
  };

  const [outside, missing] = await Promise.all([
    readSessionContextToolEntry.handler(
      input,
      createExecutionContext({ sessionStore: outsideStore, workspaceRoot: WORKSPACE_A }),
    ),
    readSessionContextToolEntry.handler(
      input,
      createExecutionContext({ sessionStore: missingStore, workspaceRoot: WORKSPACE_A }),
    ),
  ]);

  assert.deepEqual(outside, missing);
});

test("in-scope sessions still read messages", async () => {
  const cases = [
    {
      currentIdentity: undefined,
      targetIdentity: undefined,
      targetDirectory: join(WORKSPACE_A, "."),
      workingDirectory: WORKSPACE_B,
    },
    {
      currentIdentity: "remote:workspace-a",
      targetIdentity: "remote:workspace-a",
      targetDirectory: WORKSPACE_B,
      workingDirectory: WORKSPACE_A,
    },
  ] as const;

  for (const fixture of cases) {
    let messageReads = 0;
    const sessionStore = createSessionStore(
      createSession({
        directory: fixture.targetDirectory,
        workspaceID: fixture.targetIdentity,
      }),
      async () => {
        messageReads++;
        return [];
      },
    );

    const output = ReadSessionContextOutputSchema.parse(
      await readSessionContextToolEntry.handler(
        {
          sessionId: "sess_target",
          query: "current implementation state",
          strategy: "relevant",
        },
        createExecutionContext({
          sessionStore,
          workingDirectory: fixture.workingDirectory,
          workspaceIdentity: fixture.currentIdentity,
          workspaceRoot: WORKSPACE_A,
        }),
      ),
    );

    assert.equal(output.status, "success");
    assert.equal(messageReads, 1);
  }
});

test("rewound sessions exclude discarded branch messages from explicit context reads", async () => {
  const keptMessageId = "msg_kept" as MessageId;
  const rewindTargetMessageId = "msg_rewind_target" as MessageId;
  const branchCutMessageId = "msg_discarded_tail" as MessageId;
  const activeReplacementMessageId = "msg_active_replacement" as MessageId;
  const session = createSession({
    directory: WORKSPACE_A,
    revert: {
      branchCutAfterMessageID: branchCutMessageId,
      branchGeneration: 1,
      keptMessageIDs: [keptMessageId],
      kind: "conversation_rewind",
      messageID: rewindTargetMessageId,
      scope: "conversation",
      targetMessageID: rewindTargetMessageId,
    },
  });
  const messages = [
    createUserMessage(keptMessageId, "kept requirement"),
    createUserMessage(rewindTargetMessageId, "discarded target secret"),
    createUserMessage(branchCutMessageId, "discarded tail secret"),
    createUserMessage(activeReplacementMessageId, "active replacement decision"),
  ];
  const output = ReadSessionContextOutputSchema.parse(
    await readSessionContextToolEntry.handler(
      {
        sessionId: "sess_target",
        query: "zzz-no-match",
        strategy: "relevant",
      },
      createExecutionContext({
        sessionStore: createSessionStore(session, async () => messages),
        workspaceRoot: WORKSPACE_A,
      }),
    ),
  );

  assert.equal(output.status, "success");
  assert.equal(output.messageCount, 2);
  assert.match(output.content, /kept requirement/u);
  assert.match(output.content, /active replacement decision/u);
  assert.doesNotMatch(output.content, /discarded target secret/u);
  assert.doesNotMatch(output.content, /discarded tail secret/u);
  assert.deepEqual(
    output.references?.map((reference) => reference.messageId),
    [keptMessageId, activeReplacementMessageId],
  );
});

test("refreshes rewind metadata after reading messages before projecting text", async () => {
  const keptMessageId = "msg_concurrent_kept" as MessageId;
  const rewindTargetMessageId = "msg_concurrent_target" as MessageId;
  const branchCutMessageId = "msg_concurrent_cut" as MessageId;
  const replacementMessageId = "msg_concurrent_replacement" as MessageId;
  const staleSession = createSession({ directory: WORKSPACE_A });
  const refreshedSession = createSession({
    directory: WORKSPACE_A,
    revert: {
      branchCutAfterMessageID: branchCutMessageId,
      branchGeneration: 1,
      keptMessageIDs: [keptMessageId],
      kind: "conversation_rewind",
      messageID: rewindTargetMessageId,
      scope: "conversation",
      targetMessageID: rewindTargetMessageId,
    },
  });
  const messages = [
    createUserMessage(keptMessageId, "kept concurrent requirement"),
    createUserMessage(rewindTargetMessageId, "discarded concurrent secret"),
    createUserMessage(branchCutMessageId, "discarded concurrent tail"),
    createUserMessage(replacementMessageId, "active concurrent replacement"),
  ];
  let metadataReads = 0;
  const sessionStore = {
    getSession: async () => {
      metadataReads += 1;
      return metadataReads === 1 ? staleSession : refreshedSession;
    },
    messages: async () => messages,
  } as SessionStorePort;

  const output = ReadSessionContextOutputSchema.parse(
    await readSessionContextToolEntry.handler(
      {
        sessionId: "sess_target",
        query: "zzz-no-match",
        strategy: "relevant",
      },
      createExecutionContext({ sessionStore, workspaceRoot: WORKSPACE_A }),
    ),
  );

  assert.equal(metadataReads, 2);
  assert.equal(output.status, "success");
  assert.match(output.content, /kept concurrent requirement/u);
  assert.match(output.content, /active concurrent replacement/u);
  assert.doesNotMatch(output.content, /discarded concurrent secret/u);
  assert.doesNotMatch(output.content, /discarded concurrent tail/u);
});

function createSession(input: {
  directory: string;
  revert?: SessionInfo["revert"];
  workspaceID?: string;
}): SessionInfo {
  return {
    id: "sess_target",
    projectID: "project-a",
    workspaceID: input.workspaceID,
    taskType: "interactive",
    slug: "target",
    directory: input.directory,
    title: "Target session",
    version: "1",
    ...(input.revert ? { revert: input.revert } : {}),
    time: { created: 1, updated: 1 },
  } as SessionInfo;
}

function createUserMessage(messageId: MessageId, text: string): MessageWithParts {
  return {
    info: {
      agent: "build",
      id: messageId,
      role: "user",
      sessionID: "sess_target" as SessionId,
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${messageId}` as PartId,
        messageID: messageId,
        sessionID: "sess_target" as SessionId,
        text,
        type: "text",
      },
    ],
  };
}

function createSessionStore(
  session: SessionInfo | null,
  messages: SessionStorePort["messages"],
): SessionStorePort {
  return {
    getSession: async () => session,
    messages,
  } as SessionStorePort;
}

function createExecutionContext(input: {
  sessionStore: SessionStorePort;
  workingDirectory?: string;
  workspaceIdentity?: string;
  workspaceRoot: string;
}): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_current" as SessionId,
    sessionStore: input.sessionStore,
    toolCallId: "tool-read-session-context",
    traceId: "trace-read-session-context",
    workingDirectory: input.workingDirectory ?? input.workspaceRoot,
    workspaceIdentity: input.workspaceIdentity,
    workspaceRoot: input.workspaceRoot,
  } as ToolExecutionContext;
}
