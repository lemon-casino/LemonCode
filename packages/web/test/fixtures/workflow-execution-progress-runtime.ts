import {
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type V4ConversationSubscribeResult,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { progressRun, type ProgressScenario } from "./workflow-execution-progress-data.js";

const topic = "conversation/fixture-parent";
const base = conversationSnapshotSchema.parse({
  protocolVersion: 1,
  sessionId: "fixture-parent",
  logEpoch: "fixture-epoch",
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
  config: { provider: "fixture", model: "fixture", thought: "", followupMode: "queue" },
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
let subscription = 0;
let recover: ((value: V4ConversationSubscribeResult) => void) | undefined;
let rejectRecovery: ((error: Error) => void) | undefined;
const transport = {
  subscribe: async () => ({
    ack: {
      subscriptionId: `fixture-sub-${++subscription}`,
      mode: "snapshot",
      logEpoch: base.logEpoch,
    },
  }),
  activate: () => {},
  unsubscribe: async () => {},
  resync: () =>
    new Promise<V4ConversationSubscribeResult>((resolve, reject) => {
      recover = resolve;
      rejectRecovery = reject;
    }),
  onAssemblyFault: () => () => {},
  onRuntimeRestart: () => () => {},
} as unknown as ConversationTransport;
// 拆分超长夹具只隔离传输职责，所有控件仍共享原来的唯一投影及 lease。
const store = new ConversationProjectionStore(topic, transport);
export const lease: SessionLease = {
  sessionId: base.sessionId,
  store,
  openKind: "cold",
  startedAt: 0,
  release: () => {
    void store.close();
  },
};
// 以实时导入绑定保留源时间，UI 重绘和连接恢复不得推进静态观察时钟。
export let sourceNow = Date.now();
let seq = 0;
let scenario: ProgressScenario = "model";
let current: ConversationSnapshot = base;

export function sendScene(next: ProgressScenario) {
  scenario = next;
  sourceNow = Date.now();
  seq += 1;
  current = conversationSnapshotSchema.parse({
    ...base,
    seq,
    revision: seq,
    workflowRuns: { revision: seq, runs: [progressRun(next, sourceNow)] },
  });
  store.handleFrame(
    conversationTopicFrameSchema.parse({
      topic,
      subscriptionId: store.getState().subscriptionId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: sourceNow,
      payload: { kind: "snapshot", snapshot: current },
    }),
    { deliveryKind: "online" },
  );
}

export async function initialise() {
  await store.connect();
  seq += 1;
  current = conversationSnapshotSchema.parse({
    ...base,
    seq,
    revision: seq,
    workflowRuns: { revision: seq, runs: [progressRun(scenario, sourceNow)] },
  });
  store.handleFrame(
    conversationTopicFrameSchema.parse({
      topic,
      subscriptionId: store.getState().subscriptionId,
      fromSeq: 0,
      toSeq: seq,
      sentAt: sourceNow,
      payload: { kind: "snapshot", snapshot: current },
    }),
    { deliveryKind: "initial" },
  );
}

export function beginRecovery() {
  store.recoverFromStaleAuthority();
}

export async function finishRecovery(profile: string) {
  const subscriptionId = store.getState().subscriptionId!;
  recover?.({
    ack: {
      subscriptionId,
      mode: profile === "desktop-continuous" ? "snapshot" : "resume",
      logEpoch: base.logEpoch,
    },
  });
  await Promise.resolve();
  store.handleFrame(
    conversationTopicFrameSchema.parse({
      topic,
      subscriptionId,
      fromSeq: profile === "desktop-continuous" ? 0 : seq,
      toSeq: seq,
      sentAt: Date.now(),
      payload:
        profile === "desktop-continuous"
          ? { kind: "snapshot", snapshot: current }
          : { kind: "deltas", deltas: [] },
    }),
    { deliveryKind: "recovery" },
  );
}

export function failRecovery() {
  beginRecovery();
  rejectRecovery?.(new Error("Fixture connection unavailable"));
}

export function sendStaleFrame() {
  store.handleFrame(
    {
      topic,
      subscriptionId: "stale-fixture-subscription",
      fromSeq: 0,
      toSeq: seq + 100,
      sentAt: Date.now(),
      payload: {
        kind: "snapshot",
        snapshot: {
          ...current,
          workflowRuns: { revision: 100, runs: [progressRun("reasoning", Date.now())] },
        },
      },
    },
    { deliveryKind: "online" },
  );
}
