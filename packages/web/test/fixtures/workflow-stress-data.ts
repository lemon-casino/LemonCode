import {
  conversationSnapshotSchema,
  reduceWorkflowRunsState,
  type ConversationSnapshot,
  type WorkflowRunsState,
} from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

export const stressGraph: WorkflowCausalityGraphData = {
  lanes: [{ id: "actor#parallel", name: "Synthetic actors" }],
  steps: [
    {
      id: "ask#work",
      kind: "ask",
      label: "Sustained synthetic load",
      lane: "actor#parallel",
      phase: "load",
    },
  ],
  participants: [
    { id: "parallel-load", lane: "actor#parallel", phase: "load", steps: ["ask#work"] },
  ],
  phases: [{ id: "load", name: "Synthetic load" }],
  phaseEdges: [],
  handoffs: [],
};

export function emptyStressSnapshot(): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: "stress-parent",
    logEpoch: "stress-epoch",
    seq: 0,
    revision: 0,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: Object.fromEntries(
      [
        "fork",
        "compact",
        "switchModelConfig",
        "setFollowupMode",
        "queueEdit",
        "sendQueuedNow",
        "pauseGoal",
        "resumeGoal",
      ].map((key) => [key, { allowed: true }]),
    ),
    inputRouting: { mode: "enqueue" },
    config: { provider: "synthetic", model: "synthetic", thought: "", followupMode: "queue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    rows: { window: [], totalCount: 0, firstRowId: null },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    pendingInteractions: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
  });
}

/** Browser-only synthetic owner. Runtime/driver/wire performance is measured separately. */
export class StressSource {
  state: WorkflowRunsState | undefined;
  sequence = 0;
  readonly counts = {
    inputDeltas: 0,
    activity: 0,
    ordinary: 0,
    boundary: 0,
    lifecycle: 0,
    rotations: 0,
  };
  private ordinal = 0;
  private tickNumber = 0;
  private readonly lanes: Array<{
    ordinal: number;
    lastAt: number;
    since: number;
    request: number;
    completed: number;
    tools: number;
    kind: "text" | "tool" | "unknown";
  }>;

  constructor(readonly actors: number) {
    this.emit("run-started", { caps: { maxConcurrency: actors } });
    this.emit("phase-entered", { name: "Synthetic load", ordinal: 1 });
    this.lanes = Array.from({ length: actors }, (_, index) => {
      this.emit("actor-created", {
        actor: { siteId: "actor#parallel", ordinal: index + 1 },
        name: `Synthetic ${index + 1}`,
        phaseName: "Synthetic load",
      });
      return {
        ordinal: 0,
        lastAt: 0,
        since: Date.now(),
        request: 1,
        completed: 0,
        tools: 0,
        kind: "text",
      };
    });
    // 历史由同一生产 reducer 归约，不能直接拼出 truncated=true 假装验证窗口。
    for (let index = 0; index < 260; index++) {
      const instance = this.queue(index % actors);
      this.emit("node-settled", { instance, outcome: "ok" });
    }
    for (let index = 0; index < actors; index++)
      this.lanes[index]!.ordinal = this.queue(index).ordinal;
  }

  private emit(eventType: string, payload: Record<string, unknown>) {
    const next = reduceWorkflowRunsState(this.state, {
      runId: "stress-run",
      sequence: ++this.sequence,
      eventType,
      payload,
      occurredAt: Date.now(),
    });
    if (next !== null) this.state = next;
    if (eventType !== "node-activity") this.counts.lifecycle++;
  }

  private queue(index: number) {
    const instance = { siteId: "ask#work", ordinal: ++this.ordinal };
    this.emit("node-queued", {
      instance,
      actor: { siteId: "actor#parallel", ordinal: index + 1 },
      kind: "ask",
      phaseName: "Synthetic load",
    });
    this.emit("node-dispatched", { instance });
    this.emit("node-executing", { instance });
    return instance;
  }

  tick() {
    const now = Date.now();
    this.tickNumber++;
    for (const [index, lane] of this.lanes.entries()) {
      this.counts.inputDeltas++;
      const phase = (this.tickNumber + index * 7) % 200;
      const instance = { siteId: "ask#work", ordinal: lane.ordinal };
      let boundary = false;
      if (phase === 100) {
        lane.kind = "tool";
        lane.tools++;
        lane.completed++;
        boundary = true;
      } else if (phase === 102 || phase === 184) {
        lane.kind = "text";
        lane.request++;
        this.emit("node-executing", { instance });
        boundary = true;
      } else if (phase === 180) {
        lane.kind = "unknown";
        this.emit("node-waiting", {
          instance,
          cause: "backoff",
          reason: "network_error",
          attempt: 2,
          delayMs: 200,
        });
        boundary = true;
      }
      if (boundary) lane.since = now;
      if (boundary || now - lane.lastAt >= 1_000) {
        this.emit("node-activity", {
          instance,
          activity: {
            kind: lane.kind,
            observedAt: now,
            since: lane.since,
            requestsCompleted: lane.completed,
            toolCalls: lane.tools,
            ...(lane.kind === "tool"
              ? { toolName: "Read" }
              : { requestId: `request-${index}-${lane.request}` }),
          },
        });
        lane.lastAt = now;
        this.counts.activity++;
        if (boundary) this.counts.boundary++;
        else this.counts.ordinary++;
      }
    }
    if (this.tickNumber % 200 === 0) {
      const index = Math.floor(this.tickNumber / 200) % this.actors;
      const lane = this.lanes[index]!;
      this.emit("node-settled", {
        instance: { siteId: "ask#work", ordinal: lane.ordinal },
        outcome: "ok",
      });
      lane.ordinal = this.queue(index).ordinal;
      lane.lastAt = 0;
      lane.since = now;
      this.counts.rotations++;
    }
  }

  verifyStale() {
    const before = this.state;
    const next = reduceWorkflowRunsState(before, {
      runId: "stress-run",
      sequence: 1,
      eventType: "run-started",
      payload: {},
      occurredAt: Date.now(),
    });
    return next === null;
  }
}
