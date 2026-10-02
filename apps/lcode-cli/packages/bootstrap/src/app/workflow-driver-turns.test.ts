import assert from "node:assert/strict";
import test from "node:test";
import {
  createRootTraceContext,
  createSessionId,
  type MessageWithParts,
  type WorkflowSubmitPort,
} from "@lcode/contracts";
import type { AgentRuntime, ExecuteTurnOptions, TurnResult } from "@lcode/core";
import {
  InMemoryJournalStore,
  type InstanceRef,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import { defer } from "./workflow-driver-helpers.js";
import type {
  AgentRuntimeWorkflowDriverDeps,
  ActorRuntimeFactory,
} from "./workflow-driver-types.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const instance: InstanceRef = { siteId: "ask#1", ordinal: 1 };

function resolvedTurn(response = "done"): TurnResult {
  return {
    response,
    events: [],
    usage: { totalTokens: 7, modelRequestCount: 1 },
  } as unknown as TurnResult;
}

async function fixture(input: {
  runtimeFactory: ActorRuntimeFactory;
  transcript?: AgentRuntimeWorkflowDriverDeps["actorTranscriptStore"];
  onTurnEnded?: WorkflowReportSink["askTurnEnded"];
}) {
  const order: string[] = [];
  const residency: Promise<unknown>[] = [];
  const journal = new InMemoryJournalStore();
  const runId = "turn-cleanup-order";
  journal.createRun({ runId, status: "running", caps: { maxConcurrency: 1 }, spentTokens: 0 });
  journal.putNode({
    runId,
    ...instance,
    kind: "ask",
    inputHash: "fixture",
    status: "running",
  });
  const putNode = journal.putNode.bind(journal);
  journal.putNode = (record) => {
    if (record.messageBoundary !== undefined) order.push("marker");
    putNode(record);
  };
  const sink: WorkflowReportSink = {
    askProgress: () => {
      order.push("progress");
    },
    askStats: () => {
      order.push("stats");
    },
    askSubmitAttempted: (current, result) => {
      order.push("submit");
      const recorded = journal.getNode(runId, current.siteId, current.ordinal);
      assert.ok(recorded);
      journal.putNode({ ...recorded, status: "completed", result });
      driver.respondToSubmit(current, { kind: "accept" });
    },
    askTurnEnded: (current, text) => {
      order.push("ended");
      input.onTurnEnded?.(current, text);
    },
    askFailed: (_current, error) => assert.fail(error.message),
    askActivity: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  };
  const driver = createAgentRuntimeWorkflowDriver({
    runId,
    journal,
    emit: () => {},
    runtimeFactory: input.runtimeFactory,
    ...(input.transcript === undefined ? {} : { actorTranscriptStore: input.transcript }),
    registerResidencyBlockingWork: (work: Promise<unknown>) => {
      residency.push(work);
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps)(sink);
  const session = await driver.createActorSession({ siteId: "actor#1", ordinal: 1 }, {});
  return { driver, journal, order, residency, runId, session };
}

test("accepted turn cleanup waits for transcript handlers and runtime lease release", async () => {
  const turn = defer<TurnResult>();
  const transcript = defer<MessageWithParts[]>();
  const release = defer<void>();
  let submit!: WorkflowSubmitPort;
  let closed = 0;
  const h = await fixture({
    runtimeFactory: ({ submitPort }) => {
      submit = submitPort;
      return {
        executeTurn: () => turn.promise,
        closeBrowserSession: async () => {
          closed++;
          h.order.push("close");
          await release.promise;
          h.order.push("lease-released");
        },
      } as unknown as AgentRuntime;
    },
    transcript: {
      messages: () => {
        h.order.push("count");
        return transcript.promise;
      },
      saveMessage: async () => {},
      savePart: async () => {},
    },
  });
  try {
    h.driver.startAsk(h.session, instance, { instructions: "submit the result", typed: true });
    await tick();
    assert.deepEqual(
      await submit.respond({
        result: { done: true },
        toolCallId: "submit",
        trace: createRootTraceContext({ sessionId: createSessionId(h.session.id) }),
      }),
      { accept: true },
    );
    h.driver.dispose?.();
    assert.equal(h.residency.length, 1);
    let disposed = false;
    void h.residency[0]!.then(() => {
      disposed = true;
    });
    await tick();
    assert.equal(closed, 0, "accept is not the end of the submit handler's turn");

    turn.resolve(resolvedTurn());
    await tick();
    assert.deepEqual(h.order, ["submit", "progress", "stats", "count"]);
    assert.equal(closed, 0, "the transcript handler is part of the same turn tail");
    assert.equal(disposed, false);

    transcript.resolve([]);
    await tick();
    assert.deepEqual(h.order, ["submit", "progress", "stats", "count", "marker", "close"]);
    assert.equal(disposed, false, "runtime close still owns the release work");
    assert.deepEqual(h.journal.getNode(h.runId, instance.siteId, instance.ordinal)?.result, {
      done: true,
    });
    assert.equal(h.journal.getNode(h.runId, instance.siteId, instance.ordinal)?.messageBoundary, 0);

    release.resolve();
    await h.residency[0];
    assert.equal(disposed, true);
    assert.equal(h.order.at(-1), "lease-released");
    h.driver.dispose?.();
    await tick();
    assert.equal(closed, 1);
  } finally {
    turn.resolve(resolvedTurn());
    transcript.resolve([]);
    release.resolve();
    h.driver.dispose?.();
    await Promise.all(h.residency);
  }
});

test("a successor waits for the previous turn handler and rejects its stale transcript marker", async () => {
  const turns = [defer<TurnResult>(), defer<TurnResult>()];
  const transcript = defer<MessageWithParts[]>();
  let started = 0;
  let reads = 0;
  const h = await fixture({
    runtimeFactory: () =>
      ({
        executeTurn: () => turns[started++]!.promise,
        closeBrowserSession: async () => {},
      }) as unknown as AgentRuntime,
    transcript: {
      messages: () => {
        reads++;
        return reads === 1 ? transcript.promise : Promise.resolve([]);
      },
      saveMessage: async () => {},
      savePart: async () => {},
    },
  });
  try {
    h.driver.startAsk(h.session, instance, { instructions: "first", typed: true });
    await tick();
    h.driver.respondToSubmit(instance, { kind: "accept" });
    turns[0]!.resolve(resolvedTurn());
    await tick();
    assert.equal(reads, 1);
    const next: InstanceRef = { siteId: "ask#2", ordinal: 1 };
    h.driver.startAsk(h.session, next, { instructions: "next", typed: false });
    await tick();
    assert.equal(started, 1, "executeTurn alone resolving must not release the actor runtime");

    transcript.resolve([]);
    await tick();
    assert.equal(started, 2);
    assert.equal(
      h.journal.getNode(h.runId, instance.siteId, instance.ordinal)?.messageBoundary,
      undefined,
    );
    assert.equal(h.order.includes("ended"), false, "the stale handler must not settle the new ask");

    turns[1]!.resolve(resolvedTurn());
    await tick();
    assert.deepEqual(h.order, ["progress", "stats", "progress", "stats", "ended"]);
  } finally {
    transcript.resolve([]);
    for (const turn of turns) turn.resolve(resolvedTurn());
    h.driver.dispose?.();
    await Promise.all(h.residency);
  }
});

test("a nudge uses the same runtime only after progress and stats finish the old turn", async () => {
  const turns = [defer<TurnResult>(), defer<TurnResult>()];
  const options: ExecuteTurnOptions[] = [];
  const h = await fixture({
    runtimeFactory: () =>
      ({
        executeTurn: (_input: string, _attachments: unknown, turnOptions: ExecuteTurnOptions) => {
          options.push(turnOptions);
          return turns[options.length - 1]!.promise;
        },
        closeBrowserSession: async () => {},
      }) as unknown as AgentRuntime,
    onTurnEnded: (current) => {
      h.driver.respondToSubmit(current, { kind: "nudge" });
      assert.equal(options.length, 1, "a synchronous nudge must not overlap its old handler");
    },
  });
  try {
    h.driver.startAsk(h.session, instance, { instructions: "first", typed: true });
    await tick();
    turns[0]!.resolve(resolvedTurn("not submitted"));
    await tick();
    assert.deepEqual(h.order, ["progress", "stats", "ended"]);
    assert.equal(options.length, 2);
    assert.equal(options[0]?.epilogueStart, "first".length);
    assert.equal(options[1]?.epilogueStart, 0);
    assert.notEqual(options[0]?.queryId, options[1]?.queryId);

    h.driver.respondToSubmit(instance, { kind: "accept" });
    turns[1]!.resolve(resolvedTurn());
    await tick();
    assert.deepEqual(h.order, ["progress", "stats", "ended", "progress", "stats"]);
  } finally {
    h.driver.cancelAsk(instance);
    for (const turn of turns) turn.resolve(resolvedTurn());
    h.driver.dispose?.();
    await Promise.all(h.residency);
  }
});
