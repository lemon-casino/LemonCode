import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryEffectEntrySchema,
  SessionEventType,
  type MemoryEffectTurn,
  type SessionEvent,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  memoryEffectVerification,
  memoryEffectWorkspaceKey,
  freezeMemoryInjection,
} from "../../memory/effect-observation.js";
import {
  observeMemoryVerificationEvent,
  recordMemoryEffectTurn,
} from "./memory-effect-observation.js";
import type { MemoryRecallResult } from "../../memory/recall/types.js";

const hash = memoryEffectWorkspaceKey("fixture-identity", "/fixture");
function event(
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "fixture-turn",
): SessionEvent {
  return {
    type,
    payload,
    id: "fixture-event",
    sessionId: "fixture-session",
    turnId,
    timestamp: new Date(0),
    sequenceNumber: 1,
  } as SessionEvent;
}
function fixture() {
  const records: MemoryEffectTurn[] = [];
  const warnings: string[] = [];
  const runtime = {
    sessionId: "fixture-session",
    workspaceRoot: "/fixture",
    memoryRoot: "/memory",
    config: {
      memory: {
        enabled: true,
        use: true,
        workspaceIdentity: "fixture-identity",
        observationEnabled: true,
      },
    },
    logger: { warn: (message: string) => warnings.push(message) },
    model: {
      generateText: () => {
        throw new Error("Observation must not call model");
      },
    },
    fileSystemPort: {
      projectMemory: {
        effects: {
          recordTurn: async ({ turn }: { turn: MemoryEffectTurn }) => {
            records.push(turn);
            return "recorded";
          },
        },
      },
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    turnId: "fixture-turn",
    turnTraceContext: {},
    userMessageId: "fixture-user",
    turnRecallQuery: "fixture",
    memoryEffectScope: { rootDir: "/memory", workspaceKey: hash },
    memoryEffectInjection: [
      {
        fileName: "fact.md",
        sourceHash: hash,
        injectedCharacters: 7,
        matchedTermCount: 1,
        metadataMatchCount: 0,
      },
    ],
  } as unknown as RegularTurnLoopState;
  return { runtime, state, records, warnings, events: [event(SessionEventType.ModelRequest, {})] };
}

test("actual injected refs are frozen without body, query words or invented truncated revision", () => {
  const results = [
    {
      filename: "fact.md",
      content: "synthetic private body",
      matchedTerms: ["private"],
      sourceHash: hash,
    } as MemoryRecallResult,
    { filename: "prefix.md", content: "prefix", sourceHash: "prefix-only" } as MemoryRecallResult,
  ];
  const entries = freezeMemoryInjection(results);
  assert.equal(entries[0]!.injectedCharacters, results[0]!.content.length);
  assert.equal(entries[1]!.sourceHash, null);
  assert.equal(Object.isFrozen(entries[0]), true);
  assert.doesNotMatch(JSON.stringify(entries), /synthetic private body|private/u);
});

test("large lexical match counts saturate without dropping a valid injection observation", () => {
  const entry = freezeMemoryInjection([
    {
      filename: "large.md",
      content: "actual attachment",
      sourceHash: hash,
      matchedTerms: Array.from({ length: 4001 }, (_, i) => `term${i}`),
      metadataMatches: Array.from({ length: 4001 }, (_, i) => `metadata${i}`),
    } as MemoryRecallResult,
  ])[0]!;
  assert.equal(entry.matchedTermCount, 4000);
  assert.equal(entry.metadataMatchCount, 4000);
  assert.equal(MemoryEffectEntrySchema.safeParse(entry).success, true);
});

test("strict completed evidence is linked; legacy fail-open and different turns remain unknown", () => {
  const verification = (status: string, outcome: string, passed: boolean) =>
    event(SessionEventType.TargetCompletionVerification, {
      status,
      verification: { passed, evidenceSummary: { outcome } },
    });
  assert.equal(
    memoryEffectVerification(
      [verification("completed", "pass", true)],
      "fixture-session",
      "fixture-turn",
    ).verification,
    "passed",
  );
  assert.equal(
    memoryEffectVerification(
      [verification("completed", "notSatisfied", false)],
      "fixture-session",
      "fixture-turn",
    ).verification,
    "failed",
  );
  assert.equal(
    memoryEffectVerification(
      [verification("failed_closed", "pass", true)],
      "fixture-session",
      "fixture-turn",
    ).verification,
    "unknown",
  );
  assert.equal(
    memoryEffectVerification(
      [verification("completed", "incomplete", true)],
      "fixture-session",
      "fixture-turn",
    ).verification,
    "unknown",
  );
  assert.equal(
    memoryEffectVerification(
      [verification("completed", "pass", true)],
      "fixture-session",
      "other-turn",
    ).verification,
    "unknown",
  );
});

test("completed/error/cancelled observations preserve status without causal feedback or model calls", async () => {
  const h = fixture();
  for (const status of ["completed", "error", "cancelled"] as const)
    await recordMemoryEffectTurn(h.runtime, { state: h.state, events: h.events, status });
  assert.deepEqual(
    h.records.map((record) => record.status),
    ["completed", "error", "cancelled"],
  );
  assert.ok(h.records.every((record) => record.verification === "unknown"));
  assert.equal(h.warnings.length, 0);
  assert.equal(memoryEffectWorkspaceKey(" fixture-identity ", "/different"), hash);
});

test("disabled, before-request and rebound scope produce no observation; failure does not throw", async () => {
  const h = fixture();
  await recordMemoryEffectTurn(h.runtime, { state: h.state, events: [], status: "cancelled" });
  h.runtime.config.memory!.observationEnabled = false;
  await recordMemoryEffectTurn(h.runtime, {
    state: h.state,
    events: h.events,
    status: "completed",
  });
  h.runtime.config.memory!.observationEnabled = true;
  h.runtime.config.memory!.workspaceIdentity = "rebound";
  await recordMemoryEffectTurn(h.runtime, {
    state: h.state,
    events: h.events,
    status: "completed",
  });
  assert.equal(h.records.length, 0);
  h.runtime.config.memory!.workspaceIdentity = "fixture-identity";
  h.runtime.fileSystemPort!.projectMemory!.effects!.recordTurn = async () => {
    throw new Error("private fixture secret");
  };
  await recordMemoryEffectTurn(h.runtime, {
    state: h.state,
    events: h.events,
    status: "completed",
  });
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0]!, /private fixture secret/u);
});

test("late Goal verification binds anchorTurnId instead of the verifier request turn", async () => {
  const h = fixture();
  const seen: unknown[] = [];
  h.runtime.fileSystemPort!.projectMemory!.effects!.recordVerification = async (input) => {
    seen.push(input.verification);
    return "recorded";
  };
  const verification = event(
    SessionEventType.TargetCompletionVerification,
    { anchorTurnId: "fixture-turn", status: "completed", verification: { passed: true } },
    "verifier-turn",
  );
  await observeMemoryVerificationEvent(h.runtime, verification);
  assert.equal((seen[0] as { turnId: string }).turnId, "fixture-turn");
  assert.equal((seen[0] as { basis: string }).basis, "model");
  assert.equal((seen[0] as { verification: string }).verification, "passed");
  await observeMemoryVerificationEvent(
    h.runtime,
    event(SessionEventType.TargetCompletionVerification, { status: "started" }),
  );
  assert.equal(seen.length, 1);
});
