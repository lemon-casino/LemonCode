import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteSessionStore } from "@lcode/adapters";
import { goalAcceptanceSchema, type SessionId, type ProjectId } from "@lcode/contracts";
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";
import { createConversationV4Gateway } from "./v4-bridge.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const sessionId = "binder-admission" as SessionId;
const selection = { providerId: "fixture", modelId: "fixture" };
const acceptance = goalAcceptanceSchema.parse({
  policy: "strict",
  requirements: [
    {
      id: "gate",
      description: "check",
      source: "Bash",
      command: "node check.mjs",
      inputPaths: ["check.mjs"],
    },
  ],
});

async function fixture(taskType = "root") {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  await store.createSession({
    id: sessionId,
    projectID: "project" as ProjectId,
    directory: "fixture",
    slug: "fixture",
    title: "fixture",
    version: "1",
  });
  const admitted: unknown[] = [];
  const save = store.saveSessionInput.bind(store);
  store.saveSessionInput = async (input) => {
    admitted.push(structuredClone(input));
    return save(input);
  };
  const record = {
    taskType,
    persistence: "immediate",
    stateRevision: 0,
    workspace: { workspacePath: "fixture", workspaceKey: "fixture" },
    traceContext: {},
    activeAbortController: new AbortController(),
    restoreWarning: { type: "fixture", message: "fixture model is unavailable" },
    app: {
      sessionId,
      getMode: () => "build",
      getModel: () => "fixture/fixture",
      listModels: () => [],
      runtime: {
        getSessionModelSelection: () => undefined,
        getPlanEnabled: () => false,
        validateContextCapsuleReferences: async () => true,
      },
    },
  };
  const context = {
    deps: { sessionStore: store },
    sessions: new Map([[sessionId, record]]),
    notify: () => {},
  } as unknown as LCodeProtocolAgentServerContext;
  const gateway = createConversationV4Gateway(context);
  context.v4Gateway = gateway;
  return {
    gateway,
    admitted,
    close: () => {
      gateway.dispose();
      store.close();
    },
  };
}

test("real gateway/binder strict input persists its accepted contract before explicit busy rejection", async () => {
  const f = await fixture();
  try {
    const ack = await f.gateway.handleCommand({
      type: "sendStrictGoalCommand",
      commandId: "strict",
      clientId: "client",
      sessionId,
      payload: { text: "task", acceptance, modelSelection: selection },
      issuedAt: 1,
    });
    assert.equal(ack.reasonCode, "activeTurn");
    assert.equal(f.admitted.length, 1);
    const entry = f.admitted[0] as {
      payload: { conversationInputIntent: { goalAcceptance: unknown; kind: string } };
    };
    assert.equal(entry.payload.conversationInputIntent.kind, "sendGoalCommand");
    assert.deepEqual(entry.payload.conversationInputIntent.goalAcceptance, acceptance);
  } finally {
    f.close();
  }
});

test("real binder rejects strict commands from read-only subagent sessions before any admission write", async () => {
  const f = await fixture("subagent_child");
  try {
    const ack = await f.gateway.handleCommand({
      type: "sendStrictGoalCommand",
      commandId: "readonly",
      clientId: "client",
      sessionId,
      payload: { text: "task", acceptance, modelSelection: selection },
      issuedAt: 1,
    });
    assert.equal(ack.reasonCode, "guard.subagentReadOnly");
    assert.equal(f.admitted.length, 0);
  } finally {
    f.close();
  }
});

test("real binder independently persists capsule refs and execution selection without mistaking them for shares", async () => {
  const f = await fixture();
  const refs = [{ kind: "context_capsule", capsule_id: `capsule_${"a".repeat(32)}` }];
  try {
    const ack = await f.gateway.handleCommand({
      type: "sendText",
      commandId: "capsule",
      clientId: "client",
      sessionId,
      payload: {
        text: "use background",
        context_refs: refs,
        modelSelection: selection,
        mode: "yolo",
        planEnabled: false,
      },
      issuedAt: 1,
    });
    assert.equal(
      ack.reasonCode,
      "restoreWarning",
      "reaches the existing model-readiness boundary after typed admission",
    );
    assert.equal(f.admitted.length, 1);
    const entry = f.admitted[0] as {
      payload: {
        intent: { contextCapsuleRefs: unknown };
        conversationInputIntent: {
          contextCapsuleRefs: unknown;
          sharedContextRefs: unknown;
          modelSelection: unknown;
          mode: string;
          planEnabled: boolean;
        };
      };
    };
    assert.deepEqual(entry.payload.intent.contextCapsuleRefs, refs);
    assert.deepEqual(entry.payload.conversationInputIntent.contextCapsuleRefs, refs);
    assert.deepEqual(entry.payload.conversationInputIntent.sharedContextRefs, []);
    assert.deepEqual(entry.payload.conversationInputIntent.modelSelection, selection);
    assert.equal(entry.payload.conversationInputIntent.mode, "yolo");
    assert.equal(entry.payload.conversationInputIntent.planEnabled, false);
  } finally {
    f.close();
  }
});

test("real gateway rejects an oversized strict Goal before binder admission writes", async () => {
  const f = await fixture();
  try {
    const ack = await f.gateway.handleCommand({
      type: "sendStrictGoalCommand",
      commandId: "oversize",
      clientId: "client",
      sessionId,
      payload: {
        text: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes),
        acceptance,
        modelSelection: selection,
      },
      issuedAt: 1,
    });
    assert.equal(ack.reasonCode, "proto.payloadTooLarge");
    assert.equal(f.admitted.length, 0);
  } finally {
    f.close();
  }
});

test("real gateway measures createSession's complete firstInput selection before starting a new session", async () => {
  const f = await fixture();
  try {
    const ack = await f.gateway.handleCommand({
      type: "createSession",
      commandId: "large-first-selection",
      clientId: "client",
      sessionId: null,
      payload: {
        workspaceId: "fixture",
        firstInput: {
          text: "task",
          mode: "yolo",
          planEnabled: false,
          modelSelection: {
            providerId: "fixture",
            modelId: "x".repeat(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes),
          },
        },
      },
      issuedAt: 1,
    });
    assert.equal(ack.reasonCode, "proto.payloadTooLarge");
    assert.equal(f.admitted.length, 0);
  } finally {
    f.close();
  }
});
