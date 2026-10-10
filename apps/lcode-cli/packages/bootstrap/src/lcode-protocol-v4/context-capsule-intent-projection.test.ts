import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionEvent,
  RewindStrategy,
  type MessageWithParts,
  type SessionEvent,
  type SessionId,
  type TurnInputIntentMetadata,
} from "@lcode/contracts";
import type { CommandEnvelope, ContextCapsuleRef } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";
import { V4CommandExecutor } from "./commands/executor.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./commands/types.js";

const sessionId = "capsule-projection" as SessionId;
const refs: ContextCapsuleRef[] = ["a", "b"].map((letter) => ({
  kind: "context_capsule",
  capsule_id: `capsule_${letter.repeat(32)}`,
}));
const intent: TurnInputIntentMetadata = {
  sourceCommandId: "original",
  queueItemId: "original",
  clientId: "client",
  kind: "sendText",
  text: "Continue from the saved background",
  contextCapsuleRefs: refs,
  admissionSeq: 1,
  admittedAt: 1,
  requestedDelivery: "startNow",
  admittedDelivery: "startNow",
};

function fact(type: SessionEvent["type"], payload: unknown, sequenceNumber: number): SessionEvent {
  return {
    ...createSessionEvent(type, sessionId, payload),
    sequenceNumber,
    timestamp: new Date(sequenceNumber),
    turnId: "runtime-turn" as SessionEvent["turnId"],
  };
}

function projection(delivery: "live" | "cold") {
  const result = new ProductProjection(sessionId, "epoch");
  if (delivery === "live") {
    for (const event of [
      fact(
        "turn_started",
        { input: intent.text, messageId: "user-1", inputId: "original", turnNumber: 1, intent },
        1,
      ),
      fact(
        "model_streaming",
        {
          kind: "text_start",
          assistantMessageId: "assistant-1",
          partId: "reply-1",
          delta: "",
          done: false,
        },
        2,
      ),
      fact(
        "model_streaming",
        {
          kind: "text_delta",
          assistantMessageId: "assistant-1",
          partId: "reply-1",
          delta: "reply",
          done: false,
        },
        3,
      ),
      fact(
        "model_streaming",
        {
          kind: "text_end",
          assistantMessageId: "assistant-1",
          partId: "reply-1",
          delta: "",
          done: true,
        },
        4,
      ),
      fact("model_complete", { finishReason: "stop", usage: {} }, 5),
      fact("turn_complete", { turnNumber: 1, duration: 4 }, 6),
    ])
      result.applyEvent(event);
  } else {
    const transcript = [
      {
        info: {
          id: "user-1",
          role: "user",
          time: { created: 1 },
          anchor: { turnId: "runtime-turn", sourceCommandId: "original" },
          metadata: {
            conversationInputIntent: {
              sourceCommandId: "original",
              queueItemId: "original",
              clientId: "client",
              kind: "sendText",
              text: intent.text,
              contextCapsuleRefs: refs,
              admittedAt: 1,
              attachments: [],
              delivery: { requested: "startNow", admitted: "startNow" },
              order: { admissionSeq: 1 },
              steer: { state: "notRequested" },
              dispatch: { state: "drained" },
            },
          },
        },
        parts: [{ type: "text", id: "input-1", text: intent.text }],
      },
      {
        info: {
          id: "assistant-1",
          role: "assistant",
          parentID: "user-1",
          time: { created: 2, completed: 6 },
          anchor: { turnId: "runtime-turn" },
        },
        parts: [{ type: "text", id: "reply-1", text: "reply" }],
      },
    ] as unknown as MessageWithParts[];
    result.beginHydrationReplay();
    for (const event of synthesizeEventsFromMessages(transcript, {
      sessionId,
      contextWindow: 1000,
    }))
      result.applyHydrationEvent(event);
    result.completeHydrationReplay();
  }
  return result;
}

function fixture(
  delivery: "live" | "cold",
  type: "retryTurn" | "editUserQuery",
  newText?: string,
  valid = true,
) {
  const view = projection(delivery);
  const row = view
    .getSnapshot()
    .rows.window.find(
      (item) => item.kind === (type === "retryTurn" ? "assistantText" : "userInput"),
    );
  assert.ok(row);
  assert.ok(row.entityId);
  const target = { rowId: row.rowId, entityId: row.entityId };
  const resolved = view.resolveRowActionTarget(target, type);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  let stopped = 0;
  let rewound = 0;
  const validations: ContextCapsuleRef[][] = [];
  let sent: { text: string; intent?: TurnInputIntentMetadata } | undefined;
  const record = {
    persistence: "immediate",
    traceContext: {},
    app: {
      sessionId,
      readTarget: async () => null,
      runtime: {
        validateContextCapsuleReferences: async (references: ContextCapsuleRef[]) => {
          validations.push(references);
          return valid;
        },
        stopActiveForegroundExecution: () => {
          stopped++;
        },
        rewindConversationToMessage: async () => {
          rewound++;
          return { strategy: RewindStrategy.ActiveChain };
        },
      },
      sendInput: async (input: { text: string }, options: { intent?: TurnInputIntentMetadata }) => {
        sent = { text: input.text, intent: options.intent };
        return { kind: "started_turn", turnId: "retry-turn", completion: Promise.resolve() };
      },
    },
  } as unknown as V4SessionRecordView;
  const host = {
    getRecord: () => record,
    resolveRowActionTarget: (_session: string, anchor: typeof target, action: typeof type) =>
      view.resolveRowActionTarget(anchor, action),
  } as V4CommandCoreHost;
  const envelope = {
    type,
    commandId: "resubmitted",
    clientId: "client",
    sessionId,
    issuedAt: 10,
    payload: { target, ...(type === "editUserQuery" ? { newText } : {}) },
  } as CommandEnvelope;
  return {
    run: () => new V4CommandExecutor(host).execute(envelope),
    record,
    state: () => ({ stopped, rewound, validations, sent }),
    resolved,
  };
}

for (const delivery of ["live", "cold"] as const) {
  test(`${delivery} projection resolves frozen capsules and the real retry handler propagates them`, async () => {
    const f = fixture(delivery, "retryTurn");
    assert.ok(f.resolved.ok);
    assert.deepEqual(f.resolved.editTarget?.intent.contextCapsuleRefs, refs);
    await f.run();
    assert.deepEqual(f.state().validations, [refs]);
    assert.deepEqual(f.state().sent?.intent?.contextCapsuleRefs, refs);
    assert.equal(f.state().sent?.intent?.provenance?.sourceCommandId, "original");
    assert.equal(f.state().sent?.text, intent.text);
    assert.equal(f.state().rewound, 1);
  });
  test(`${delivery} edit retains only explicit admitted capsules and leaves input text unchanged`, async () => {
    const text = `Edited\n#${refs[0]!.capsule_id}\n~~~md\n#${refs[1]!.capsule_id}\n~~~`;
    const f = fixture(delivery, "editUserQuery", text);
    await f.run();
    assert.deepEqual(f.state().validations, [[refs[0]]]);
    assert.deepEqual(f.state().sent?.intent?.contextCapsuleRefs, [refs[0]]);
    assert.equal(f.state().sent?.text, text);
    assert.equal(f.state().sent?.intent?.text, text);
    const removed = fixture(
      delivery,
      "editUserQuery",
      `Edited with inline #${refs[0]!.capsule_id}\n\`\`\`md\n#${refs[1]!.capsule_id}\n\`\`\``,
    );
    await removed.run();
    assert.equal(removed.state().sent?.intent?.contextCapsuleRefs, undefined);
    assert.deepEqual(removed.state().validations, []);
  });
  test(`${delivery} added or stale capsule references reject before preemption and rewind`, async () => {
    const added = fixture(delivery, "editUserQuery", `Edited\n#capsule_${"c".repeat(32)}`);
    const addedController = new AbortController();
    added.record.activeAbortController = addedController;
    addedController.signal.addEventListener("abort", () => {
      added.record.activeAbortController = undefined;
    });
    await assert.rejects(added.run(), /send a new input/i);
    assert.deepEqual(added.state(), { stopped: 0, rewound: 0, validations: [], sent: undefined });
    const tooMany = fixture(
      delivery,
      "editUserQuery",
      ["a", "b", "c", "d", "e"].map((id) => `#capsule_${id.repeat(32)}`).join("\n"),
    );
    await assert.rejects(tooMany.run(), /at most 4/i);
    assert.equal(tooMany.state().rewound, 0);
    assert.equal(tooMany.state().sent, undefined);
    const stale = fixture(delivery, "editUserQuery", `Edited\n#${refs[0]!.capsule_id}`, false);
    const staleController = new AbortController();
    stale.record.activeAbortController = staleController;
    staleController.signal.addEventListener("abort", () => {
      stale.record.activeAbortController = undefined;
    });
    await assert.rejects(stale.run(), /unavailable|stale/i);
    assert.equal(stale.state().stopped, 0);
    assert.equal(stale.state().rewound, 0);
    assert.equal(stale.state().sent, undefined);
    const retry = fixture(delivery, "retryTurn", undefined, false);
    await assert.rejects(retry.run(), /unavailable|stale/i);
    assert.equal(retry.state().rewound, 0);
  });
  test(`${delivery} editing code examples does not re-admit a saved summary`, async () => {
    for (const text of [
      `    #${refs[0]!.capsule_id}`,
      ["~~~md", "~~~not-a-close", `#${refs[0]!.capsule_id}`, "~~~"].join("\n"),
    ]) {
      const f = fixture(delivery, "editUserQuery", text);
      await f.run();
      assert.equal(f.state().sent?.intent?.contextCapsuleRefs, undefined);
      assert.deepEqual(f.state().validations, []);
      assert.equal(f.state().sent?.text, text);
    }
  });
}
