import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type {
  ContextCapsule,
  MessageWithParts,
  SessionInfo,
  SessionStorePort,
  Model,
  TurnId,
  MessageId,
  TurnInputIntentMetadata,
} from "@lcode/contracts";
import { MessageHistoryImpl } from "../agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../agent/session-history-hydrator.js";
import type { AgentRuntimeInternal } from "../runtime/internal.js";
import { prepareTurnContextCapsules } from "../runtime/methods/turn-context-capsule.js";
import { readSessionContextToolEntry } from "../tool/handlers/read-session-context.js";
import type { ToolExecutionContext } from "../tool/types.js";

const directory = resolve("capsule-scope");
function harness() {
  const sessions = new Map(
    ["sess_source", "sess_target"].map((id) => [
      id,
      { id, directory, title: id, time: { created: 1, updated: 1 } } as SessionInfo,
    ]),
  );
  let source: MessageWithParts[] = [
    {
      info: {
        id: "msg_source",
        sessionID: "sess_source",
        role: "assistant",
        time: { created: 1, completed: 2 },
        finish: "stop",
      },
      parts: [
        {
          id: "part_source",
          messageID: "msg_source",
          sessionID: "sess_source",
          type: "text",
          text: "stable source decision",
        },
      ],
    } as MessageWithParts,
  ];
  const user = {
    info: {
      id: "msg_target",
      sessionID: "sess_target",
      role: "user",
      time: { created: 3 },
      anchor: { origin: "realUser", turnId: "turn_target" },
    },
    parts: [],
  } as MessageWithParts;
  const capsules = new Map<string, ContextCapsule>();
  let commits = 0,
    attaches = 0;
  const store = {
    getSession: async (id) => sessions.get(id) ?? null,
    messages: async ({ sessionID }) => (sessionID === "sess_source" ? source : [user]),
    commitContextCapsule: async (capsule) => {
      commits++;
      capsules.set(capsule.id, capsule);
      return { status: "committed", capsule };
    },
    readContextCapsule: async ({ sessionId, capsuleId }) =>
      sessionId === "sess_target" ? capsules.get(capsuleId) : undefined,
    attachContextCapsulesToInput: async (input) => {
      attaches++;
      return (
        input.targetMessageId === "msg_target" &&
        input.targetTurnId === "turn_target" &&
        input.inputId === "accepted-input"
      );
    },
  } as SessionStorePort;
  const context = {
    sessionId: "sess_target",
    turnId: "turn_target",
    traceId: "trace",
    toolCallId: "call_one",
    sessionStore: store,
    workspaceRoot: directory,
    workingDirectory: directory,
    abortSignal: new AbortController().signal,
  } as ToolExecutionContext;
  return {
    store,
    context,
    capsules,
    sessions,
    commits: () => commits,
    attaches: () => attaches,
    changeSource: () => {
      source = source.map((message) => ({
        ...message,
        parts: [
          {
            ...message.parts[0]!,
            text: "revoked source content",
          } as MessageWithParts["parts"][number],
        ],
      }));
    },
  };
}

test("handoff rechecks after the Lite model and omits source changed during generation", async () => {
  const h = harness();
  h.context.model = {
    optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 5000 } },
    generateText: async () => {
      h.changeSource();
      return { text: "stale private summary" };
    },
  } as Model;
  const output = (await readSessionContextToolEntry.handler(
    { sessionId: "sess_source", query: "handoff", strategy: "handoff", persistCapsule: true },
    h.context,
  )) as { status: string; content: string };
  assert.equal(output.status, "failed");
  assert.doesNotMatch(output.content, /stale private|revoked source/u);
  assert.equal(h.commits(), 0);
});

test("capsule generation is explicit and reusable refs enter background without share uniqueness", async () => {
  const h = harness();
  await readSessionContextToolEntry.handler(
    { sessionId: "sess_source", query: "handoff", strategy: "handoff" },
    h.context,
  );
  assert.equal(h.commits(), 0);
  const first = (await readSessionContextToolEntry.handler(
    { sessionId: "sess_source", query: "handoff", strategy: "handoff", persistCapsule: true },
    h.context,
  )) as { status: string; capsuleId: string };
  h.context.toolCallId = "call_two";
  const second = (await readSessionContextToolEntry.handler(
    { sessionId: "sess_source", query: "handoff", strategy: "handoff", persistCapsule: true },
    h.context,
  )) as { status: string; capsuleId: string };
  assert.equal(first.status, "success");
  assert.notEqual(first.capsuleId, second.capsuleId);
  assert.match(
    JSON.stringify(readSessionContextToolEntry.formatModelContent!(first)),
    /#capsule_/u,
  );
  const refs = [first.capsuleId, second.capsuleId].map((id) => ({
    kind: "context_capsule" as const,
    capsule_id: id,
  }));
  const history = new MessageHistoryImpl();
  history.init();
  history.addUser("existing share", { source: "shared_context" });
  const runtime = {
    sessionId: "sess_target",
    sessionStore: h.store,
    config: {},
    workspaceRoot: directory,
    messageHistory: history,
  } as unknown as AgentRuntimeInternal;
  const input = {
    options: {
      intent: {
        queueItemId: "accepted-input",
        contextCapsuleRefs: refs,
      } as TurnInputIntentMetadata,
    },
    signal: new AbortController().signal,
    targetMessageId: "msg_target" as MessageId,
    targetTurnId: "turn_target" as TurnId,
  };
  await prepareTurnContextCapsules(runtime, input);
  await prepareTurnContextCapsules(runtime, input);
  assert.equal(
    history
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.metadata?.source === "context_capsule").length,
    2,
  );
  assert.equal(
    history
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.metadata?.source === "shared_context").length,
    1,
  );
  assert.equal(h.attaches(), 2);
  h.changeSource();
  await assert.rejects(prepareTurnContextCapsules(runtime, input), /stale/u);
  assert.equal(
    history
      .borrowReadOnlyRuntimeEntries()
      .filter((entry) => entry.metadata?.source === "context_capsule").length,
    0,
  );
});

test("cancelled generation does not persist or leak a successful capsule", async () => {
  const h = harness(),
    controller = new AbortController();
  controller.abort();
  h.context.abortSignal = controller.signal;
  await assert.rejects(
    readSessionContextToolEntry.handler(
      { sessionId: "sess_source", query: "handoff", strategy: "handoff", persistCapsule: true },
      h.context,
    ),
    /cancelled/iu,
  );
  assert.equal(h.commits(), 0);
});

test("cold history restores canonical text while saved capsule reuse revalidates source without recreating old temporary background", async () => {
  const h = harness();
  const output = (await readSessionContextToolEntry.handler(
    { sessionId: "sess_source", query: "handoff", strategy: "handoff", persistCapsule: true },
    h.context,
  )) as { capsuleId: string };
  const messages = await h.store.messages({ sessionID: h.context.sessionId });
  messages[0]!.parts = [
    {
      id: "target-text",
      messageID: messages[0]!.info.id,
      sessionID: h.context.sessionId,
      type: "text",
      text: `reuse saved background\n#${output.capsuleId}`,
    },
  ] as MessageWithParts["parts"];
  messages[0]!.info.metadata = {
    conversationInputIntent: {
      contextCapsuleRefs: [{ kind: "context_capsule", capsule_id: output.capsuleId }],
    },
  };
  const history = new MessageHistoryImpl();
  history.init();
  await hydrateMessageHistoryFromSession({ history, messages });
  assert.equal(
    history
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.metadata?.source === "context_capsule"),
    false,
  );
  assert.match(JSON.stringify(history.borrowReadOnlyRuntimeEntries()), /reuse saved background/u);
  const read = (await readSessionContextToolEntry.handler(
    {
      sessionId: "sess_source",
      query: "handoff",
      strategy: "handoff",
      capsuleId: output.capsuleId,
    },
    h.context,
  )) as { status: string; source: string; content: string };
  assert.equal(read.status, "success");
  assert.equal(read.source, "capsule");
  h.changeSource();
  const stale = (await readSessionContextToolEntry.handler(
    {
      sessionId: "sess_source",
      query: "handoff",
      strategy: "handoff",
      capsuleId: output.capsuleId,
    },
    h.context,
  )) as { status: string; content: string };
  assert.equal(stale.status, "failed");
  assert.doesNotMatch(stale.content, /stable source decision/u);
});
