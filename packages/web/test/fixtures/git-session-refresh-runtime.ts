import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import type { GitRefreshResult } from "@lcode/shared";
import {
  conversationSnapshotSchema,
  V4_WIRE_PROTOCOL_VERSION,
  type PlanState,
} from "@lcode/shared/lcode-protocol-v4";

export const origin = "/fixture/repo";
const worktree = new URLSearchParams(location.search).has("worktree");
export const metrics = {
  sessionReads: 0,
  gitReads: 0,
  watchStarts: 0,
  watchEnds: 0,
  heldReads: 0,
  subscribes: 0,
  directories: 0,
};
const events = new Set<(frame: unknown) => void>();
const emptyEvent = () => ({ dispose: () => {} });
let subscriptionNumber = 0;
let holdNext = false;
let releaseRead: (() => void) | undefined;
export const fixture = {
  dirty: true,
  openedChild: "",
  error: null as unknown,
  holdNextRead: () => {
    holdNext = true;
  },
  releaseRead: () => {
    releaseRead?.();
    releaseRead = undefined;
  },
};
window.addEventListener("error", (event) => {
  fixture.error = {
    message: event.error?.message,
    issues: event.error?.issues,
    stack: event.error?.stack,
  };
});
window.addEventListener("unhandledrejection", (event) => {
  fixture.error = { message: event.reason?.message, stack: event.reason?.stack };
});
(window as unknown as { __sessionRefresh: typeof fixture }).__sessionRefresh = fixture;
export const plan: PlanState = {
  updatedAt: 1,
  items: [
    { id: "1", content: "Prepare spec", status: "completed" },
    { id: "2", content: "Implement fix", status: "completed" },
    { id: "3", content: "Run validation", status: "inProgress" },
    { id: "4", content: "Review results", status: "pending" },
  ],
};
function execution(sessionId: string) {
  return {
    workspacePath: worktree ? `/fixture/checkouts/${sessionId}` : origin,
    ...(worktree ? { executionBindingId: `binding-${sessionId}` } : {}),
  };
}
function binding(taskId: string): WorktreeBinding | null {
  return worktree
    ? {
        id: `binding-${taskId}`,
        taskId,
        requestId: "request",
        status: "ready",
        originalWorkspacePath: origin,
        workspacePath: execution(taskId).workspacePath,
        checkoutPath: execution(taskId).workspacePath,
        repositoryRoot: origin,
        commonDirectory: `${origin}/.git`,
        branch: `lcode/task-${taskId}`,
        targetBranch: "L-GO",
        baseCommit: "a".repeat(40),
        sourceFolderPaths: [],
        createdAt: "now",
        updatedAt: "now",
      }
    : null;
}
function snapshot(sessionId: string) {
  const child = sessionId.startsWith("child-");
  const rows = child
    ? [
        {
          kind: "turnHeader",
          rowId: 1,
          turnId: "turn",
          entityId: "turn",
          origin: "userInput",
          state: "failed",
          startedAt: 1,
          createdAt: 1,
          createdAtSeq: 1,
        },
        {
          kind: "assistantText",
          rowId: 2,
          turnId: "turn",
          text: `${sessionId}: Provider returned a server error.`,
          state: "failed",
          createdAt: 1,
          createdAtSeq: 1,
        },
      ]
    : [];
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      canStop: false,
      lastError: null,
      apiRetry: null,
      sessionEnded: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
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
      ].map((key) => [key, { allowed: false, reasonCode: "fixture_readonly" }]),
    ),
    config: { provider: "fixture", model: "fixture", thought: "", followupMode: "queue" },
    inputRouting: { mode: "enqueue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    rows: { window: rows, totalCount: rows.length, firstRowId: child ? 1 : null },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    pendingInteractions: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    subagents: {
      revision: 1,
      childSessionIds: [1, 2, 3, 4].map((n) => `child-${n}`),
      running: [],
      endedTotal: 4,
    },
  });
}
export const services = {
  settingService: { get: async () => ({ gitCommitReviewMode: "off" }), update: async () => {} },
  broadcastService: { send: async () => {}, onMessage: emptyEvent },
  systemService: { info: async () => ({ platform: "win32", homedir: "/fixture/home" }) },
  lcodeSessionService: {
    readSession: async ({ sessionId }: { sessionId: string }) => {
      metrics.sessionReads++;
      const result = { session: { workspace: execution(sessionId) } };
      if (holdNext) {
        holdNext = false;
        metrics.heldReads++;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      return result;
    },
  },
  worktreeService: {
    getBinding: async ({ taskId }: { taskId: string }) => binding(taskId),
    getCapabilities: async () => ({
      supported: true,
      create: true,
      integrate: true,
      archive: true,
      restore: true,
    }),
  },
  fileWatcherService: {
    watch: async () => ({ id: String(++metrics.watchStarts) }),
    unwatch: async () => {
      metrics.watchEnds++;
    },
    onDynamicChange: () => emptyEvent,
  },
  gitService: {
    refresh: async ({ workspacePath }: { workspacePath: string }): Promise<GitRefreshResult> => {
      metrics.gitReads++;
      return {
        summary: {
          workspacePath,
          repoRoot: origin,
          workspaceInRepoPath: "",
          branchName: "L-GO",
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 1,
          behind: 0,
          isDirty: fixture.dirty,
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [],
        },
        identity: null,
        stagedChanges: [],
        unstagedChanges: [],
        branchComparison: null,
      };
    },
    getBranches: async () => [],
  },
  lcodeAgentService: {
    helloConversationV4: async () => ({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "fixture",
      clientMode: worktree ? "web-remote-replayable" : "desktop-continuous",
      deliveryProfile: worktree ? "replayable" : "continuous",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    }),
    initializeConversationV4: async () => ({}),
    onAgentRuntimeRestarted: emptyEvent,
    onDynamicLocalTtftFacts: () => emptyEvent,
    onDynamicConversationFrame: () => (listener: (frame: unknown) => void) => {
      events.add(listener);
      return { dispose: () => events.delete(listener) };
    },
    subscribeConversationV4: async ({ sessionId }: { sessionId: string }) => {
      metrics.subscribes++;
      const subscriptionId = `sub-${++subscriptionNumber}`;
      setTimeout(() => {
        const frame = {
          topic: `conversation/${sessionId}`,
          logEpoch: "epoch",
          subscriptionId,
          fromSeq: 0,
          toSeq: 1,
          sentAt: 1,
          payload: { kind: "snapshot", snapshot: snapshot(sessionId) },
        };
        for (const listener of events)
          listener({
            wireVersion: V4_WIRE_PROTOCOL_VERSION,
            kind: "complete",
            deliveryKind: "initial",
            logicalFrameId: subscriptionId,
            logicalFrameOrdinal: 1,
            topic: frame.topic,
            subscriptionId,
            frame,
          });
      }, 0);
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch" } };
    },
    unsubscribeConversationV4: async () => {},
    queryConversationCommandsV4: async () => ({ commands: [] }),
    conversationPlansV4: async () => ({ plans: [], atSeq: 1, atLogEpoch: "epoch" }),
    conversationRowsRangeV4: async ({ sessionId }: { sessionId: string }) => ({
      rows: snapshot(sessionId).rows.window,
      hasMore: false,
      atRevision: 1,
      atSeq: 1,
      atLogEpoch: "epoch",
    }),
    listSessionSubagents: async () => {
      metrics.directories++;
      return {
        revision: 1,
        childSessionIds: [1, 2, 3, 4].map((n) => `child-${n}`),
        running: [],
        ended: {
          total: 4,
          items: [1, 2, 3, 4].map((n) => ({
            childSessionId: `child-${n}`,
            subagentType: "review",
            title: `Agent ${n}`,
            status: "failed",
            summary: "Provider returned a server error.",
          })),
        },
      };
    },
  },
} as unknown as IServiceAccessor;
