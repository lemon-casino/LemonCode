import {
  conversationTopicFrameSchema,
  workflowRunsStateSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type V4ConversationResyncResult,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { emptyStressSnapshot, StressSource } from "./workflow-stress-data.js";
import { StressBrowserMetrics } from "./workflow-stress-metrics.js";

export type StressProfile = "desktop-continuous" | "web-remote-replayable";
export class BrowserStressController {
  readonly metrics = new StressBrowserMetrics();
  readonly store: ConversationProjectionStore;
  readonly lease: SessionLease;
  private readonly source: StressSource;
  private current: ConversationSnapshot;
  private sourceTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private finishRecovery: (() => void) | undefined;
  private subscriptions = 0;
  private transportListeners = 0;
  private sourceTicks = 0;
  private wallStarted = 0;
  private lastProjectionRevision = -1;
  private revision = 0;
  private seq = 0;
  private generation = 0;
  private closed = false;
  private live = false;
  private frames = 0;
  private logicalBytes = 0;
  private updates = 0;
  private maxNodes = 0;
  private maxActive = 0;
  private warmupEndedAt = 0;
  private measurementStartDeltas = 0;
  private pendingRecovery = false;

  constructor(
    readonly actors: number,
    readonly profile: StressProfile,
    readonly warmupMs: number,
  ) {
    this.source = new StressSource(actors);
    this.current = emptyStressSnapshot();
    const subscribeHook = () => {
      this.transportListeners++;
      return () => {
        this.transportListeners--;
      };
    };
    const transport = {
      subscribe: async () => {
        this.subscriptions++;
        return {
          ack: {
            subscriptionId: "stress-subscription",
            mode: "snapshot",
            logEpoch: this.current.logEpoch,
          },
        };
      },
      activate: () => this.deliver("initial", true),
      unsubscribe: async () => {
        this.subscriptions--;
      },
      resync: () =>
        new Promise<V4ConversationResyncResult>((resolve) => {
          this.pendingRecovery = true;
          this.finishRecovery = () => {
            this.recoveryTimer = undefined;
            this.finishRecovery = undefined;
            const subscriptionId = this.store.getState().subscriptionId!;
            // 同订阅恢复显式标记 deliveryKind；恢复时间不能重写 activity 的源时间。
            resolve({
              ack: {
                subscriptionId,
                mode: profile === "desktop-continuous" ? "snapshot" : "resume",
                logEpoch: this.current.logEpoch,
              },
            });
            if (!this.closed) {
              this.deliver("recovery", profile === "desktop-continuous");
              // schema 会按声明顺序重建键；原始 owner 与 wire 直接 stringify 会误报恢复失败。
              // 双方先按同一协议规范化，仍比较全部字段值、缺失与数组顺序，不等待额外 drain。
              const actual = workflowRunsStateSchema.safeParse(
                this.store.getState().snapshot?.workflowRuns,
              );
              const expected = workflowRunsStateSchema.safeParse(this.current.workflowRuns);
              const equal =
                actual.success &&
                expected.success &&
                JSON.stringify(actual.data) === JSON.stringify(expected.data);
              if (!equal) this.metrics.recoveryConsistencyFailures++;
              this.metrics.recoveries++;
            }
            this.pendingRecovery = false;
          };
          this.recoveryTimer = setTimeout(() => this.finishRecovery?.(), 250);
        }),
      onAssemblyFault: subscribeHook,
      onRuntimeRestart: subscribeHook,
    } as unknown as ConversationTransport;
    this.store = new ConversationProjectionStore("conversation/stress-parent", transport);
    this.lease = {
      sessionId: "stress-parent",
      store: this.store,
      openKind: "cold",
      startedAt: performance.now(),
      release: () => {
        void this.stop();
      },
    };
  }

  async start() {
    await this.store.connect();
    this.live = true;
    this.wallStarted = performance.now();
    const generation = ++this.generation;
    const tick = () => {
      this.sourceTimer = undefined;
      if (!this.live || generation !== this.generation) return;
      this.source.tick();
      this.sourceTicks++;
      const run = this.source.state?.runs[0];
      this.maxNodes = Math.max(this.maxNodes, run?.nodes.length ?? 0);
      this.maxActive = Math.max(
        this.maxActive,
        run?.nodes.filter((node) => node.phase !== "settled").length ?? 0,
      );
      if (!this.pendingRecovery && this.source.state?.revision !== this.lastProjectionRevision)
        this.deliver("online", false);
      if (this.warmupEndedAt === 0 && performance.now() - this.wallStarted >= this.warmupMs) {
        this.warmupEndedAt = performance.now();
        this.measurementStartDeltas = this.source.counts.inputDeltas;
        this.metrics.start();
      }
      const deadline = this.wallStarted + (this.sourceTicks + 1) * 50;
      this.sourceTimer = setTimeout(tick, Math.max(0, deadline - performance.now()));
    };
    this.sourceTimer = setTimeout(tick, 50);
  }

  private deliver(kind: "initial" | "online" | "recovery", snapshot: boolean) {
    const fromSeq = this.store.getState().snapshot?.seq ?? 0;
    this.seq++;
    this.revision++;
    this.current = {
      ...this.current,
      seq: this.seq,
      revision: this.revision,
      workflowRuns: this.source.state,
    };
    this.lastProjectionRevision = this.source.state?.revision ?? 0;
    const frame = conversationTopicFrameSchema.parse({
      topic: "conversation/stress-parent",
      subscriptionId: this.store.getState().subscriptionId,
      fromSeq: snapshot ? 0 : fromSeq,
      toSeq: this.seq,
      sentAt: Date.now(),
      payload: snapshot
        ? { kind: "snapshot", snapshot: this.current }
        : {
            kind: "deltas",
            deltas: [{ op: "state.updated", patch: { workflowRuns: this.source.state } }],
          },
    });
    this.frames++;
    this.logicalBytes += new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    this.updates++;
    this.store.handleFrame(frame, { deliveryKind: kind });
  }

  recover() {
    if (!this.live) return;
    this.store.recoverFromStaleAuthority();
  }

  stale() {
    const before = this.store.getState().snapshot;
    const frame: ConversationTopicFrame = {
      topic: "conversation/stress-parent",
      subscriptionId: "stale-subscription",
      fromSeq: 0,
      toSeq: this.seq + 1,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot: emptyStressSnapshot() },
    };
    this.store.handleFrame(frame, { deliveryKind: "online" });
    if (before !== this.store.getState().snapshot || !this.source.verifyStale())
      this.metrics.recoveryConsistencyFailures++;
    this.metrics.staleChecks++;
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.generation++;
    if (this.sourceTimer !== undefined) clearTimeout(this.sourceTimer);
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer);
    this.sourceTimer = undefined;
    this.recoveryTimer = undefined;
    this.finishRecovery?.();
    this.metrics.stop();
    await this.store.close();
  }

  result() {
    const metrics = this.metrics.result();
    const run = this.source.state?.runs[0];
    return {
      actors: this.actors,
      profile: this.profile,
      requestedWarmupMs: this.warmupMs,
      warmupWallMs: this.warmupEndedAt === 0 ? null : this.warmupEndedAt - this.wallStarted,
      phase: this.closed ? "stopped" : this.warmupEndedAt === 0 ? "warming" : "measuring",
      targetDeltasPerSecondPerActor: 20,
      inputDeltas: this.source.counts.inputDeltas,
      measuredInputDeltas: this.source.counts.inputDeltas - this.measurementStartDeltas,
      activity: { ...this.source.counts },
      projectionUpdates: this.updates,
      logicalFrames: this.frames,
      logicalFrameBytes: this.logicalBytes,
      maxNodes: this.maxNodes,
      maxActiveNodes: this.maxActive,
      truncated: run?.truncated === true,
      sourceObservedAt:
        run?.nodes.find((node) => node.phase !== "settled")?.activity?.observedAt ?? null,
      ...metrics,
      subscriptionsRemaining: this.subscriptions,
      transportListenersRemaining: this.transportListeners,
      sourceTimersRemaining: Number(this.sourceTimer !== undefined),
      recoveryTimersRemaining: Number(this.recoveryTimer !== undefined),
      storeStatus: this.store.getState().status,
      storeSyncing: this.store.getState().syncing === true,
      browserRuntimeBoundary:
        "synthetic owner -> production shared reducer -> parent ConversationProjectionStore -> real React; independent from Node driver/wire benchmark",
      performanceSloAsserted: false,
    };
  }
}
