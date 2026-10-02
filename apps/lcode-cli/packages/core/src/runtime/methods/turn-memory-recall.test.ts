import assert from "node:assert/strict";
import test from "node:test";
import { CompactPhase, TurnMachineImpl } from "../deps.js";
import type {
  FileSystemPort,
  MessageId,
  Model,
  SessionEvent,
  SessionId,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";

import {
  createRuntimeUserEntry,
  MessageHistoryImpl,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createEvent } from "./events.js";
import {
  appendProjectMemoryRecallForTurn,
  beginTurnModelRequest,
  compactTurnRequestBeforeModelStep,
} from "./turn-loop.js";
import { persistTurnModelRequestEvent, runReactiveCompactAttempt } from "./turn-model-step.js";
import {
  filterTurnRecallOverlayEntries,
  resolveTurnRecallQuery,
  type RegularTurnLoopState,
  withTurnRecallOverlaysDetached,
} from "./turn-loop-state.js";

test("recall query is only derived for a newly recorded real user message", () => {
  assert.equal(resolveTurnRecallQuery("  remember this  "), "remember this");
  assert.equal(resolveTurnRecallQuery("internal", { inputVisibility: "model-only" }), undefined);
  assert.equal(resolveTurnRecallQuery("already persisted", { skipInputRecord: true }), undefined);
  assert.equal(resolveTurnRecallQuery("scheduled", { automationId: "automation-1" }), undefined);
  assert.equal(resolveTurnRecallQuery("synthetic", { inputSource: "background_task" }), undefined);
  assert.equal(resolveTurnRecallQuery("   "), undefined);
});

test("overlay primitive reattaches both recall sources after compact success and failure", async () => {
  const canonical = createRuntimeUserEntry("canonical");
  const outputStyle = systemReminderAttachmentEntry("output_style", "style");
  const recall = systemReminderAttachmentEntry("memory_recall", "remembered fact");
  const sessionRecall = systemReminderAttachmentEntry("session_recall", "prior session fact");
  const state = {
    entries: [canonical, outputStyle, recall, sessionRecall],
    outputTokenContinuationCount: 0,
  };

  const recordedEntries = filterTurnRecallOverlayEntries(state.entries);
  assert.deepEqual(recordedEntries, [canonical, outputStyle]);
  assert.deepEqual(
    state.entries,
    [canonical, outputStyle, recall, sessionRecall],
    "live request remains unchanged",
  );

  await withTurnRecallOverlaysDetached(state, async () => {
    assert.deepEqual(state.entries, [canonical, outputStyle]);
    state.entries = [createRuntimeUserEntry("compact summary")];
  });

  assert.equal(state.entries.length, 3);
  assert.equal(state.entries[0]?.kind, undefined);
  assert.equal(state.entries[1], recall);
  assert.equal(state.entries[2], sessionRecall);

  const failingState = { entries: [canonical, sessionRecall], outputTokenContinuationCount: 0 };
  await assert.rejects(
    withTurnRecallOverlaysDetached(failingState, async () => {
      assert.deepEqual(failingState.entries, [canonical]);
      throw new Error("compact failed");
    }),
    /compact failed/u,
  );
  assert.deepEqual(failingState.entries, [canonical, sessionRecall]);
});

test("turn-loop micro and auto compact detach recall and restore it after canonical replacement", async () => {
  const canonical = createRuntimeUserEntry("canonical");
  const outputStyle = systemReminderAttachmentEntry("output_style", "style");
  const recall = systemReminderAttachmentEntry("memory_recall", "remembered fact");
  const microSummary = createRuntimeUserEntry("micro summary");
  const autoSummary = createRuntimeUserEntry("auto summary");
  const state = createLoopState([canonical, outputStyle, recall]);
  state.modelStepCount = 1;
  const calls: string[] = [];
  const runtime = {
    async microcompactIfNeeded(
      _trace: TraceContext,
      _events: SessionEvent[],
      _signal: AbortSignal,
      context: { phase: string; turnRequestState: RegularTurnLoopState["turnRequestState"] },
    ) {
      calls.push("micro");
      assert.equal(context.phase, CompactPhase.MidTurn);
      assert.deepEqual(context.turnRequestState.entries, [canonical, outputStyle]);
      context.turnRequestState.entries = [microSummary];
    },
    async autoCompactIfNeeded(
      _trace: TraceContext,
      _events: SessionEvent[],
      _signal: AbortSignal,
      context: { phase: string; turnRequestState: RegularTurnLoopState["turnRequestState"] },
    ) {
      calls.push("auto");
      assert.equal(context.phase, CompactPhase.MidTurn);
      assert.deepEqual(context.turnRequestState.entries, [microSummary]);
      context.turnRequestState.entries = [autoSummary];
      return "compacted" as const;
    },
  } as unknown as AgentRuntimeInternal;

  await compactTurnRequestBeforeModelStep(runtime, state);

  assert.deepEqual(calls, ["micro", "auto"]);
  assert.deepEqual(state.turnRequestState.entries, [autoSummary, recall]);
  assert.equal(state.turnRequestState.entries[1], recall);
  assert.equal(state.historyRoundCount, 1);
  assert.deepEqual(state.compactTracking, {
    consecutiveRapidRefills: 0,
    toolTurnsSinceCompact: 0,
  });
});

test("turn-loop records and persists the filtered projection without mutating canonical history", async () => {
  const canonicalHistory = new MessageHistoryImpl();
  const canonical = createRuntimeUserEntry("canonical real user");
  const outputStyle = systemReminderAttachmentEntry("output_style", "style remains recorded");
  canonicalHistory.init([canonical, outputStyle]);
  const canonicalBefore = JSON.stringify(canonicalHistory.borrowReadOnlyRuntimeEntries());
  const recall = systemReminderAttachmentEntry("memory_recall", "private recalled fact");
  const sessionRecall = systemReminderAttachmentEntry(
    "session_recall",
    "private prior-session fact",
  );
  const state = createLoopState([
    ...canonicalHistory.borrowReadOnlyRuntimeEntries(),
    recall,
    sessionRecall,
  ]);
  const persisted: SessionEvent[] = [];
  const runtime = {
    appendEvent: async (event: SessionEvent) => {
      persisted.push(event);
    },
    config: {},
    createEvent,
    messageHistory: canonicalHistory,
    sessionId: "session-memory-recall" as SessionId,
  } as unknown as AgentRuntimeInternal;

  const request = beginTurnModelRequest(runtime, state);
  assert.match(JSON.stringify(request.messages), /private recalled fact/u);
  assert.match(JSON.stringify(request.messages), /private prior-session fact/u);
  assert.doesNotMatch(JSON.stringify(request.recordedMessages), /private recalled fact/u);
  assert.doesNotMatch(JSON.stringify(request.recordedMessages), /private prior-session fact/u);
  assert.match(JSON.stringify(request.recordedMessages), /style remains recorded/u);
  assert.doesNotMatch(
    JSON.stringify(state.turnMachine.state.modelRequest?.messages),
    /private recalled fact|private prior-session fact/u,
  );
  assert.equal(request.requestEntries.at(-1), sessionRecall);
  assert.equal(JSON.stringify(canonicalHistory.borrowReadOnlyRuntimeEntries()), canonicalBefore);
  assert.doesNotMatch(canonicalBefore, /memory_recall|session_recall|private recalled fact/u);

  await persistTurnModelRequestEvent(runtime, state, {
    model: state.model,
    modelTraceContext: state.turnTraceContext,
    querySource: "main_turn",
    recordedMessages: request.recordedMessages,
    toolCount: 0,
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.type, "model_request");
  assert.equal(state.events[0], persisted[0]);
  assert.doesNotMatch(JSON.stringify(persisted[0]?.payload), /private recalled fact/u);
  assert.doesNotMatch(JSON.stringify(persisted[0]?.payload), /private prior-session fact/u);
  assert.match(JSON.stringify(persisted[0]?.payload), /style remains recorded/u);
});

test("reactive compact filters captured and current recall entries before restoring the overlay", async () => {
  const canonical = createRuntimeUserEntry("canonical");
  const runtimeMode = systemReminderAttachmentEntry("runtime_mode", "runtime mode");
  const recall = systemReminderAttachmentEntry("memory_recall", "remembered fact");
  const compactSummary = createRuntimeUserEntry("reactive summary");
  const state = createLoopState([canonical, runtimeMode, recall]);
  const activeEntries = [canonical, runtimeMode, recall];
  let calls = 0;
  const runtime = {
    async reactiveCompactAfterContextExceeded(
      _error: unknown,
      _trace: TraceContext,
      _events: SessionEvent[],
      _signal: AbortSignal,
      context: {
        activeEntries?: readonly { metadata?: { source?: string } }[];
        turnRequestState: RegularTurnLoopState["turnRequestState"];
      },
    ) {
      calls += 1;
      assert.deepEqual(context.activeEntries, [canonical, runtimeMode]);
      assert.deepEqual(context.turnRequestState.entries, [canonical, runtimeMode]);
      context.turnRequestState.entries = [compactSummary];
      return "compacted" as const;
    },
  } as unknown as AgentRuntimeInternal;

  const outcome = await runReactiveCompactAttempt(runtime, state, {
    activeEntries,
    contextError: new Error("context exceeded"),
    modelStepIndex: 1,
    rapidRefillCount: 0,
  });

  assert.equal(outcome, "compacted");
  assert.equal(calls, 1);
  assert.deepEqual(state.turnRequestState.entries, [compactSummary, recall]);
  assert.equal(state.turnRequestState.entries[1], recall);
});

test("memory recall appends one turn-local overlay and never commits it to canonical history", async () => {
  let reads = 0;
  const fileSystem = createSingleMemoryFileSystem(() => {
    reads += 1;
  });
  const canonicalEntries = [createRuntimeUserEntry("canonical user query")];
  const runtime = {
    fileSystemPort: fileSystem,
    memoryRoot: "/memory",
  } as unknown as AgentRuntimeInternal;
  const firstTurn = createRecallState(canonicalEntries, "dark theme");

  await appendProjectMemoryRecallForTurn(runtime, firstTurn);
  await appendProjectMemoryRecallForTurn(runtime, firstTurn);

  assert.equal(firstTurn.memoryRecallAttempted, true);
  assert.equal(firstTurn.turnRequestState.entries.length, 2);
  assert.equal(firstTurn.turnRequestState.entries[1]?.metadata?.source, "memory_recall");
  assert.equal(reads, 1);
  assert.equal(canonicalEntries.length, 1);

  const secondTurn = createRecallState(canonicalEntries, "dark theme");
  await appendProjectMemoryRecallForTurn(runtime, secondTurn);
  assert.equal(secondTurn.turnRequestState.entries.length, 2);
  assert.equal(canonicalEntries.length, 1);
  assert.equal(reads, 2, "each turn revalidates content even when mtime is unchanged");
});

test("failed recall marks the attempt before I/O and is not retried in the same turn", async () => {
  let listAttempts = 0;
  let warningMetadata: Record<string, unknown> | undefined;
  const runtime = {
    fileSystemPort: {
      async listDirectory() {
        listAttempts += 1;
        throw new Error("scan failed");
      },
    } as unknown as FileSystemPort,
    logger: {
      debug() {},
      warn(_message: string, metadata: Record<string, unknown>) {
        warningMetadata = metadata;
      },
    },
    memoryRoot: "/memory",
  } as unknown as AgentRuntimeInternal;
  const state = createRecallState([createRuntimeUserEntry("canonical")], "memory query");

  await appendProjectMemoryRecallForTurn(runtime, state);
  await appendProjectMemoryRecallForTurn(runtime, state);

  assert.equal(state.memoryRecallAttempted, true);
  assert.equal(listAttempts, 1);
  assert.equal(state.turnRequestState.entries.length, 1);
  assert.equal(warningMetadata?.event, "memory.recall.incomplete");
  assert.equal(warningMetadata?.failedDirectories, 1);
  assert.equal("errorMessage" in (warningMetadata ?? {}), false);
  assert.doesNotMatch(JSON.stringify(warningMetadata), /scan failed/u);
});

const TEST_MODEL = {
  modelId: "memory-recall-model",
  options: {},
  properties: { supportsMidConversationSystem: true },
  providerId: "memory-recall-provider",
} as Model;

function createLoopState(
  entries: RegularTurnLoopState["turnRequestState"]["entries"],
): RegularTurnLoopState {
  let turnMachine = TurnMachineImpl.create(
    "session-memory-recall" as SessionId,
    1,
    "canonical real user",
    "trace-memory-recall" as TraceId,
    "turn-memory-recall" as TurnId,
  );
  turnMachine = new TurnMachineImpl(turnMachine.start());
  return {
    events: [],
    historyRoundCount: 0,
    input: "canonical real user",
    memoryRecallAttempted: true,
    model: TEST_MODEL,
    modelStepCount: 0,
    toolCallCount: 0,
    turnAbortSignal: new AbortController().signal,
    turnMachine,
    turnRequestState: { entries, outputTokenContinuationCount: 0 },
    turnTraceContext: {} as TraceContext,
  } as RegularTurnLoopState;
}

function createRecallState(
  entries: RegularTurnLoopState["turnRequestState"]["entries"],
  query: string,
): RegularTurnLoopState {
  return {
    memoryRecallAttempted: false,
    turnRecallQuery: query,
    modelStepCount: 0,
    turnAbortSignal: new AbortController().signal,
    turnRequestState: { entries: [...entries], outputTokenContinuationCount: 0 },
    turnTraceContext: {} as TraceContext,
    userMessageId: "msg_user" as MessageId,
  } as RegularTurnLoopState;
}

function createSingleMemoryFileSystem(onRead: () => void): FileSystemPort {
  return {
    async listDirectory(request: { path: string }) {
      return {
        durationMs: 0,
        entries: [{ kind: "file" as const, name: "preference.md", path: "/memory/preference.md" }],
        numEntries: 1,
        path: request.path,
      };
    },
    async readTextFile(request: { path: string }) {
      onRead();
      const content = "The user prefers a dark theme.";
      return {
        bytesRead: content.length,
        content,
        encoding: "utf8" as const,
        path: request.path,
        sizeBytes: content.length,
        truncated: false,
      };
    },
    async stat(request: { path: string }) {
      return { kind: "file" as const, mtimeMs: 1, path: request.path, sizeBytes: 32 };
    },
  } as unknown as FileSystemPort;
}
