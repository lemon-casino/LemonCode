import assert from "node:assert/strict";
import { setImmediate as yieldTurn, setTimeout as sleep } from "node:timers/promises";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type ActorId,
  type RunEvent,
  type StoredEvent,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import { SessionEventType } from "@lcode/contracts";
import { createAgentRuntimeWorkflowDriver } from "../../../src/app/workflow-driver.js";
import type {
  ActorRuntimeFactory,
  AgentRuntimeWorkflowDriverDeps,
} from "../../../src/app/workflow-driver-types.js";
import { SyntheticActor } from "./actors.js";
import { createProjectionPipeline } from "./projection.js";
import { createResourceMeter, createTimerOwner, RSS_BUDGET_BYTES } from "./metrics.js";

class MeasuredJournal extends InMemoryJournalStore {
  last: StoredEvent | undefined;
  eventCount = 0;
  eventJsonBytes = 0;
  override appendEvent(runId: string, event: RunEvent) {
    const stored = super.appendEvent(runId, event);
    this.last = stored;
    this.eventCount++;
    this.eventJsonBytes += Buffer.byteLength(JSON.stringify(stored));
    return stored;
  }
}

interface Lane {
  actor: ActorId;
  site: string;
  ordinal: number;
  result: Promise<unknown>;
}
export interface StressParameters {
  actors: number;
  warmupMs: number;
  durationMs: number;
  deltasPerSecond: number;
}

export async function runStress(parameters: StressParameters) {
  const { actors, warmupMs, durationMs, deltasPerSecond } = parameters;
  assert.ok(Number.isInteger(actors) && actors > 0 && actors <= 256);
  assert.equal(deltasPerSecond, 20);
  const runId = "synthetic-stress";
  const started = performance.now();
  const maxWallMs = warmupMs + durationMs + 90_000;
  const timers = createTimerOwner();
  const journal = new MeasuredJournal();
  const pipeline = createProjectionPipeline(runId);
  const runtimes: SyntheticActor[] = [];
  const lanes: Lane[] = [];
  const disposals: Promise<unknown>[] = [];
  const counts = {
    inputDeltas: 0,
    activityEvents: 0,
    lifecycleEvents: 0,
    ordinaryActivity: 0,
    boundaryActivity: 0,
    asksStarted: 0,
    asksSettled: 0,
    lateEventsRejected: 0,
    actorRetries: 0,
    sourceTimestampChecks: 0,
  };
  const lastActivity = new Map<string, { signature: string; at: number }>();
  const emit = (event: RunEvent) => {
    assert.ok(journal.last);
    if (event.type === "node-activity") {
      counts.activityEvents++;
      const key = `${event.instance.siteId}@${event.instance.ordinal}`;
      const { kind, requestId, requestsCompleted, toolCalls, observedAt } = event.activity;
      const signature = JSON.stringify([kind, requestId, requestsCompleted, toolCalls]);
      const prior = lastActivity.get(key);
      if (prior?.signature === signature) counts.ordinaryActivity++;
      else counts.boundaryActivity++;
      assert.ok(observedAt <= Date.now() && observedAt >= (prior?.at ?? 0));
      counts.sourceTimestampChecks++;
      lastActivity.set(key, { signature, at: observedAt });
    } else {
      counts.lifecycleEvents++;
      if (event.type === "node-settled") {
        counts.asksSettled++;
        lastActivity.delete(`${event.instance.siteId}@${event.instance.ordinal}`);
      }
    }
    pipeline.consume(event, journal.last);
  };
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askActivity: (instance, value) => engine.askActivity(instance, value),
    askProgress: (instance, value) => engine.askProgress(instance, value),
    askStats: (instance, value) => engine.askStats(instance, value),
    askSubmitAttempted: (instance, value) => engine.askSubmitAttempted(instance, value),
    askTurnEnded: (instance, value) => engine.askTurnEnded(instance, value),
    askFailed: (instance, value) => engine.askFailed(instance, value),
    askWaiting: (instance, value) => engine.askWaiting(instance, value),
    askExecuting: (instance) => engine.askExecuting(instance),
    askMutating: (instance) => engine.askMutating(instance),
    stopRun: (error) => engine.stopRun(error),
    runStalled: (value) => engine.runStalled(value),
    concurrencyChanged: (value) => engine.concurrencyChanged(value),
  };
  const driver = createAgentRuntimeWorkflowDriver({
    runId,
    journal,
    emit,
    runtimeFactory: (input: Parameters<ActorRuntimeFactory>[0]) => {
      const runtime = new SyntheticActor(input.sessionId, input.actor.ordinal);
      runtimes.push(runtime);
      return runtime.runtime;
    },
    clock: { now: Date.now, schedule: timers.schedule },
    registerResidencyBlockingWork: (work: Promise<unknown>) => {
      disposals.push(work);
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps)(sink);
  engine = new WorkflowEngine({
    runId,
    driver,
    caps: { maxConcurrency: actors },
    askSpecs: new Map(
      Array.from({ length: actors }, (_, index) => [`ask#${index}`, { typed: false }]),
    ),
    validate: () => [],
    launch: { inputId: "synthetic-input", phaseNames: ["Synthetic load"] },
  });
  engine.enterPhase("Synthetic load");
  let failure: string | undefined;
  let stage = "setup";
  let failureStage: string | undefined;
  let resources: ReturnType<ReturnType<typeof createResourceMeter>["summary"]> | undefined;
  let measuredCounts: typeof counts | undefined;
  let projectionWindow:
    | { before: ReturnType<typeof pipeline.counters>; after: ReturnType<typeof pipeline.counters> }
    | undefined;
  let measuredWallMs = 0;
  let warmupWallMs = 0;
  let maxSchedulingLagMs = 0;
  let projection: ReturnType<typeof pipeline.summary> | undefined;
  let cleanup = { subscribersRemaining: -1 };
  let journalStatus = "unknown";
  let endConsistency = false;
  const startLane = (lane: Lane) => {
    lane.ordinal++;
    counts.asksStarted++;
    lane.result = engine.ask(lane.site, lane.actor, "synthetic task");
    void lane.result.catch(() => {});
  };
  const replaceLane = async (index: number) => {
    const lane = lanes[index]!;
    const runtime = runtimes[index]!;
    const oldTurn = runtime.finish();
    assert.equal(await lane.result, "synthetic-result");
    startLane(lane);
    await yieldTurn();
    const previous = counts.activityEvents;
    runtime.emit(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "stale", done: false },
      oldTurn,
    );
    assert.equal(counts.activityEvents, previous);
    counts.lateEventsRejected++;
  };
  try {
    for (let index = 0; index < actors; index++) {
      const lane: Lane = {
        actor: engine.createActor("actor#parallel", `Synthetic ${index + 1}`),
        site: `ask#${index}`,
        ordinal: 0,
        result: Promise.resolve(),
      };
      lanes.push(lane);
      startLane(lane);
    }
    await yieldTurn();
    assert.equal(new Set(runtimes.map((runtime) => runtime.sessionId)).size, actors);
    assert.equal(new Set(runtimes.map((runtime) => runtime.current?.queryId)).size, actors);
    assert.equal(new Set(runtimes.map((runtime) => runtime.current?.id)).size, actors);
    // 先用真实结算制造超过窗口的历史；各档正式采样从完整 N 个活动节点起步。
    for (let index = 0; index < 260; index++) await replaceLane(index % actors);
    pipeline.verifyActive(actors);
    pipeline.flush();
    let absoluteTick = 0;
    async function drive(ms: number, measured: boolean) {
      const origin = performance.now();
      const meter = measured ? createResourceMeter() : undefined;
      let sampleAt = origin + 1_000;
      let nextContinuous = origin;
      let nextReplayable = origin;
      let nextRecovery = origin + Math.min(15_000, ms / 2);
      let rotatedAt = origin + 10_000;
      let iteration = 0;
      const targetTicks = Math.ceil(ms / (1_000 / deltasPerSecond));
      const before = { ...counts };
      const projectionBefore = pipeline.counters();
      try {
        while (iteration < targetTicks) {
          const deadline = origin + (iteration + 1) * (1_000 / deltasPerSecond);
          const delay = deadline - performance.now();
          // 压力超载后也交还事件循环；否则追赶输入会饿死真实 driver 的 1Hz timer。
          await sleep(Math.max(0, delay));
          maxSchedulingLagMs = Math.max(maxSchedulingLagMs, performance.now() - deadline);
          for (const runtime of runtimes) {
            runtime.stream();
            runtime.boundary(absoluteTick);
            counts.inputDeltas++;
          }
          absoluteTick++;
          iteration++;
          const now = performance.now();
          if (now >= rotatedAt) {
            await replaceLane(Math.floor(absoluteTick / 200) % actors);
            pipeline.verifyActive(actors);
            rotatedAt = now + 10_000;
          }
          if (now >= nextRecovery) {
            stage = "recovery";
            pipeline.recover();
            pipeline.stale();
            stage = measured ? "measured" : "warmup";
            nextRecovery = now + 15_000;
          }
          if (now >= nextContinuous) {
            pipeline.flush("continuous");
            nextContinuous = now + 30;
          }
          if (now >= nextReplayable) {
            pipeline.flush("replayable");
            nextReplayable = now + 150;
          }
          if (now >= sampleAt) {
            const sample = meter?.sample();
            assert.ok(
              (sample?.rssBytes ?? process.memoryUsage().rss) <= RSS_BUDGET_BYTES,
              "rss-budget",
            );
            sampleAt = now + 1_000;
          }
          assert.ok(now - started < maxWallMs, "wall-budget");
        }
        const remaining = origin + ms - performance.now();
        if (remaining > 0) await sleep(remaining);
        return performance.now() - origin;
      } finally {
        // 预算中止也必须保留已经发生的墙钟与采样，不能把失败档写成未运行的 0。
        if (meter !== undefined) {
          resources = meter.summary();
          projectionWindow = { before: projectionBefore, after: pipeline.counters() };
          measuredWallMs = performance.now() - origin;
          measuredCounts = Object.fromEntries(
            Object.entries(counts).map(([key, value]) => [
              key,
              value - before[key as keyof typeof counts],
            ]),
          ) as typeof counts;
        }
      }
    }
    stage = "warmup";
    warmupWallMs = await drive(warmupMs, false);
    stage = "measured";
    measuredWallMs = await drive(durationMs, true);
    assert.equal(measuredCounts?.inputDeltas, actors * Math.ceil(durationMs / 50));
    stage = "recovery";
    // 取消/重试是真实 engine attempt 边界，旧 turn 事件不得落入新观察代次。
    const lane = lanes[0]!;
    const oldTurn = runtimes[0]!.current!.id;
    assert.equal(engine.pauseAsk({ siteId: lane.site, ordinal: lane.ordinal }), true);
    assert.equal(engine.retryAsk({ siteId: lane.site, ordinal: lane.ordinal }), true);
    await yieldTurn();
    counts.actorRetries++;
    const previous = counts.activityEvents;
    runtimes[0]!.emit(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: "stale", done: false },
      oldTurn,
    );
    assert.equal(counts.activityEvents, previous);
    counts.lateEventsRejected++;
    for (const runtime of runtimes) runtime.finish();
    await Promise.all(lanes.map((item) => item.result));
    engine.complete("synthetic-result");
    await yieldTurn();
    await Promise.all(disposals);
    pipeline.recover();
    pipeline.flush();
    projection = pipeline.summary();
    journalStatus = journal.getRun(runId)?.status ?? "unknown";
    const projected = pipeline.snapshot().workflowRuns?.runs[0];
    assert.equal(journalStatus, "completed");
    assert.equal(projected?.status, "completed");
    assert.equal(projected?.usage.spentTokens, journal.getRun(runId)?.spentTokens);
    assert.equal(projected?.nodes.filter((node) => node.phase !== "settled").length, 0);
    assert.equal(projection.truncatedObserved, true);
    assert.equal(counts.asksStarted, counts.asksSettled);
    endConsistency = true;
  } catch (error) {
    failure =
      error instanceof assert.AssertionError
        ? error.message === "wall-budget"
          ? "wall-budget"
          : error.message === "rss-budget"
            ? "rss-budget"
            : "invariant-failed"
        : "runtime-error";
    failureStage = stage;
    // 只输出合成断言分类，不把任意异常正文或路径写入数字报告。
    process.stderr.write(
      `${JSON.stringify({ phase: "failed", stage: failureStage, category: failure, assertion: error instanceof assert.AssertionError ? error.message.split("\n")[0] : error instanceof Error ? error.name : "unknown" })}\n`,
    );
  } finally {
    stage = "cleanup";
    if (journal.getRun(runId)?.status === "running") engine.stop("user");
    await yieldTurn();
    await Promise.all(disposals);
    try {
      pipeline.flush();
      projection ??= pipeline.summary();
      journalStatus = journal.getRun(runId)?.status ?? "unknown";
    } catch {
      failure ??= "cleanup-projection-failed";
      failureStage ??= stage;
    }
    cleanup = pipeline.close();
  }
  const timerState = timers.summary();
  const listenersRemaining = runtimes.reduce((sum, value) => sum + value.listeners.size, 0);
  const closedRuntimes = runtimes.reduce((sum, value) => sum + value.closed, 0);
  const cleanupPassed =
    timerState.remaining === 0 &&
    listenersRemaining === 0 &&
    closedRuntimes === actors &&
    cleanup.subscribersRemaining === 0;
  const rssPassed = resources !== undefined && resources.rssPeakBytes <= RSS_BUDGET_BYTES;
  timers.clear();
  return {
    parameters,
    passed: failure === undefined && cleanupPassed && rssPassed,
    failure:
      failure ??
      (!cleanupPassed ? "cleanup-failed" : !rssPassed ? "rss-budget-or-unmeasured" : null),
    failureStage: failureStage ?? (!cleanupPassed ? "cleanup" : null),
    measurementCompleted: measuredCounts?.inputDeltas === actors * Math.ceil(durationMs / 50),
    budgets: { rssBytes: RSS_BUDGET_BYTES, maxWallMs },
    setupAndTotalWallMs: performance.now() - started,
    warmupWallMs,
    measuredWallMs,
    achievedDeltasPerSecondPerActor:
      measuredCounts === undefined
        ? null
        : measuredCounts.inputDeltas / actors / (measuredWallMs / 1_000),
    maxSchedulingLagMs,
    counts,
    measuredCounts,
    resources,
    projection,
    projectionWindow,
    endConsistency,
    journalStatus,
    journal: {
      implementation: "InMemoryJournalStore",
      retainedEventCount: journal.eventCount,
      retainedEventJsonBytes: journal.eventJsonBytes,
      costIncludedInResources: true,
    },
    cleanup: {
      ...cleanup,
      ...timerState,
      listenersRemaining,
      closedRuntimes,
      passed: cleanupPassed,
    },
  };
}
