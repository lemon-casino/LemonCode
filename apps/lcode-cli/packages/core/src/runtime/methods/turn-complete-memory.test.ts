import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_HISTORY_TOOL_NAME,
  MEMORY_REVIEW_APPLY_TOOL_NAME,
  MEMORY_REVIEW_TOOL_NAME,
  SessionEventType,
  createRootTraceContext,
  type SessionEvent,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { completeRegularTurn } from "./turn-complete.js";

function event(
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "turn-fixture",
): SessionEvent {
  return {
    id: "event-fixture",
    sessionId: "session-fixture",
    turnId,
    type,
    payload,
    timestamp: new Date(0),
    sequenceNumber: 0,
    traceId: "trace-fixture",
  } as SessionEvent;
}

function toolEvents(
  name: string,
  input: unknown,
  stage: "scheduled" | "started" | "result" = "started",
): SessionEvent[] {
  const scheduled = event(SessionEventType.ToolCallScheduled, {
    toolCallId: "call-fixture",
    toolName: name,
    input,
  });
  if (stage === "scheduled") return [scheduled];
  return [
    scheduled,
    stage === "started"
      ? event(SessionEventType.ToolCallStarted, {
          toolCallId: "call-fixture",
          toolName: name,
          startedAt: new Date(0),
        })
      : event(SessionEventType.ToolCallResult, {
          toolCallId: "call-fixture",
          result: { success: false },
        }),
  ];
}

async function complete(
  events: SessionEvent[],
  skip = false,
  statePatch: Partial<RegularTurnLoopState> = {},
) {
  let extractionChecks = 0;
  let completed = 0;
  const traceContext = createRootTraceContext();
  const runtime = {
    config: { memory: { enabled: true, cliStorageRoot: "fixture-storage" } },
    sessionId: "session-fixture",
    workspaceRoot: "fixture-workspace",
    accountTargetTurnCompletion: async () => {},
    runtimeTaskRegistry: { all: () => ({}) },
    messageHistory: { getCacheStats: () => ({}) },
    createEvent: event,
    appendEvent: async () => {
      completed += 1;
    },
    rebuildProjection: async () => ({}),
    turnNumber: 0,
    isRemoteWorkspace: () => {
      extractionChecks += 1;
      return false;
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    events,
    traceId: "trace-fixture",
    turnId: "turn-fixture",
    turnMachine: { state: { startedAt: new Date(0) } },
    modelResponse: "MemoryReview create is only text here",
    toolCallCount: 1,
    historyRoundCount: 1,
    tokenCount: 0,
    turnTraceContext: traceContext,
    ...statePatch,
  } as RegularTurnLoopState;
  await completeRegularTurn.call(runtime, state, {
    displayInput: "review memory is only user text",
    options: skip ? { modelExecution: { memoryExtraction: "skip" } } : undefined,
    shouldRetryTitleGenerationAfterTurn: false,
    startedTarget: null,
    targetRunInputID: "fixture-input",
    turnStartedAtMs: 0,
    turnTraceContext: traceContext,
  });
  assert.equal(completed, 1, "turn completion remains unchanged");
  assert.equal(runtime.turnNumber, 1);
  return extractionChecks;
}

for (const { name, input } of [
  { name: MEMORY_REVIEW_TOOL_NAME, input: { action: "create" } },
  { name: MEMORY_REVIEW_TOOL_NAME, input: { action: "read" } },
  { name: MEMORY_REVIEW_TOOL_NAME, input: { action: "list" } },
  { name: MEMORY_REVIEW_APPLY_TOOL_NAME, input: {} },
  { name: MEMORY_HISTORY_TOOL_NAME, input: { action: "undo" } },
]) {
  for (const stage of ["started", "result"] as const) {
    test(`successful turn skips extraction after authoritative ${name} ${stage}`, async () => {
      assert.equal(await complete(toolEvents(name, input, stage)), 0);
    });
  }
}

test("merely scheduled review tools do not suppress extraction", async () => {
  assert.equal(
    await complete(toolEvents(MEMORY_REVIEW_TOOL_NAME, { action: "create" }, "scheduled")),
    1,
  );
});

test("ordinary turns, history lists and review text retain automatic extraction", async () => {
  for (const events of [
    [],
    toolEvents(MEMORY_HISTORY_TOOL_NAME, { action: "list" }),
    toolEvents("Read", { file_path: "MemoryReview-create.md" }),
  ]) {
    assert.equal(await complete(events), 1);
  }
});

test("tool completion must match the scheduled call and this turn/session", async () => {
  const scheduled = toolEvents(MEMORY_REVIEW_TOOL_NAME, { action: "create" }, "scheduled")[0]!;
  assert.equal(
    await complete([
      scheduled,
      event(SessionEventType.ToolCallResult, {
        toolCallId: "unrelated",
        result: { success: true },
      }),
    ]),
    1,
  );
  assert.equal(
    await complete([
      scheduled,
      event(
        SessionEventType.ToolCallStarted,
        { toolCallId: "call-fixture", toolName: MEMORY_REVIEW_TOOL_NAME },
        "other-turn",
      ),
    ]),
    1,
  );
  const foreign = event(SessionEventType.ToolCallStarted, {
    toolCallId: "call-fixture",
    toolName: MEMORY_REVIEW_TOOL_NAME,
  });
  foreign.sessionId = "foreign-session" as SessionEvent["sessionId"];
  assert.equal(await complete([scheduled, foreign]), 1);
});

test("automation and off-peak attribution suppresses background review without a new session flag", async () => {
  const traceContext = createRootTraceContext();
  for (const patch of [
    { automationId: "automation-fixture" },
    { offPeakTaskId: "offpeak-fixture" },
    { toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"] },
    { toolDisallowlist: ["OffPeakCreate"] },
    { turnTraceContext: { ...traceContext, queryId: "automation-resume" } },
    { turnTraceContext: { ...traceContext, queryId: "offpeak-resume" } },
  ]) {
    assert.equal(await complete([], false, patch as Partial<RegularTurnLoopState>), 0);
  }
});

test("explicit per-turn skip remains effective without changing the session memory setting", async () => {
  assert.equal(await complete([], true), 0);
});
