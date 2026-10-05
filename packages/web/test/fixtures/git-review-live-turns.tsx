import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
import type { GitChangeSourceId, GitFileChange, GitRefreshResult } from "@lcode/shared";
import {
  conversationSnapshotSchema,
  type ConversationTopicFrame,
  type TurnHeaderRow,
  type V4ConversationFileChangesResult,
} from "@lcode/shared/lcode-protocol-v4";
import { GitPane } from "@/GitPane.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useGitLastTurn } from "@/hooks/useGitLastTurn.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider, useLCodeStore } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { GitTurnReviewRequest } from "@/v4/gitTurnReview.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

const workspacePath = "/fixture/repo";
const sessionId = "review-session";
const params = new URLSearchParams(location.search);
let nextState: TurnHeaderRow["state"] = "running";
let phase: "unstaged" | "staged" | "committed" = "unstaged";
let seq = 1;
let subscriptions = 0;
let refreshes = 0;
let detailReads = 0;
let detailCompleted = 0;
let detailDelay = 0;
let detailFailure = false;
let delayGit = 0;
let inFlight = 0;
let maxInFlight = 0;
let watcherId = 0;
const listeners = new Set<
  (frame: ConversationTopicFrame, context: { deliveryKind: "initial" | "online" }) => void
>();
const watchers = new Map<string, (event: { dirPath: string }) => void>();
function header(
  rowId: number,
  files: number,
  state: TurnHeaderRow["state"] = "completedSuccess",
): TurnHeaderRow {
  return {
    kind: "turnHeader",
    rowId,
    turnId: `turn-${rowId}`,
    entityId: `entity-${rowId}`,
    origin: "userInput",
    state,
    createdAt: 1,
    createdAtSeq: rowId,
    startedAt: 1,
    fileChanges: { files, additions: files * 2, deletions: files },
    actions: { canRewindFiles: true },
  };
}
function snapshot() {
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: "epoch",
    seq,
    revision: seq,
    control: {
      phase: "running",
      canStop: true,
      lastError: null,
      apiRetry: null,
      sessionEnded: false,
      stopState: "stoppable",
      stopTargetKind: "assistant",
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
      ].map((key) => [key, { allowed: true }]),
    ),
    config: { provider: "fixture", model: "fixture", thought: "", followupMode: "queue" },
    inputRouting: { mode: "enqueue" },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    rows: {
      window: [header(1, 48), header(4, nextState === "completedInterrupted" ? 0 : 1, nextState)],
      totalCount: 2,
      firstRowId: 1,
    },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    pendingInteractions: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
  });
}
function emit(subscriptionId: string, initial = false) {
  const frame: ConversationTopicFrame = {
    topic: `conversation/${sessionId}`,
    subscriptionId,
    fromSeq: 0,
    toSeq: seq,
    sentAt: 1,
    payload: { kind: "snapshot", snapshot: snapshot() },
  };
  for (const listener of listeners)
    listener(frame, { deliveryKind: initial ? "initial" : "online" });
}
const transport = {
  subscribe: async () => ({
    ack: { subscriptionId: `sub-${++subscriptions}`, mode: "snapshot", logEpoch: "epoch" },
  }),
  activate: (id: string) => emit(id, true),
  unsubscribe: async () => {},
  plans: async () => ({ plans: [], atSeq: seq, atLogEpoch: "epoch" }),
  onFrame: (listener: typeof listeners extends Set<infer T> ? T : never) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onAssemblyFault: () => () => {},
  onRuntimeRestart: () => () => {},
  fileChanges: async ({
    target,
  }: {
    target: { rowId: number };
  }): Promise<V4ConversationFileChangesResult> => {
    detailReads++;
    if (detailDelay) await new Promise((resolve) => setTimeout(resolve, detailDelay));
    detailCompleted++;
    if (detailFailure) throw new Error("fixture historical query failed");
    const count = target.rowId === 1 ? 48 : 1;
    return {
      files: count,
      additions: count * 2,
      deletions: count,
      items: Array.from({ length: count }, (_, index) => ({
        path: `${workspacePath}/turn-${target.rowId}-${index}.txt`,
        additions: 2,
        deletions: 1,
        writeCount: 1,
        toolNames: ["Edit"],
        patches: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: ["-old", `+historical turn ${target.rowId}`, "+second line"],
          },
        ],
      })),
    };
  },
} as unknown as ConversationTransport;
const layer = new SessionDataLayer({ transport, keepWarmMs: 0 });

function change(): GitFileChange {
  return {
    path: `${workspacePath}/current.txt`,
    repoRelativePath: "current.txt",
    workspaceRelativePath: "current.txt",
    kind: "modified",
    section: phase === "staged" ? "staged" : "unstaged",
    added: 1,
    removed: 1,
    isStaged: phase === "staged",
    isUntracked: false,
    isConflicted: false,
  };
}
const services = {
  systemService: { info: async () => ({ platform: params.has("linux") ? "linux" : "win32" }) },
  fileWatcherService: {
    watch: async () => ({ id: String(++watcherId) }),
    unwatch: async ({ id }: { id: string }) => {
      watchers.delete(id);
    },
    onDynamicChange: (id: string) => (listener: (event: { dirPath: string }) => void) => {
      watchers.set(id, listener);
      return { dispose: () => watchers.delete(id) };
    },
  },
  gitService: {
    refresh: async (): Promise<GitRefreshResult> => {
      refreshes++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const captured = phase;
      if (delayGit) await new Promise((resolve) => setTimeout(resolve, delayGit));
      inFlight--;
      return {
        summary: {
          workspacePath,
          repoRoot: workspacePath,
          workspaceInRepoPath: "",
          branchName: "L-GO",
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 1,
          behind: 0,
          isDirty: captured !== "committed",
          isGitAvailable: true,
          isRepository: true,
          autoRefreshWatchPaths: [],
        },
        identity: null,
        unstagedChanges: captured === "unstaged" ? [change()] : [],
        stagedChanges: captured === "staged" ? [change()] : [],
        branchComparison: null,
      };
    },
    getDiff: async ({ path }: { path: string }) => ({
      path,
      availability: "patch",
      patch: "--- a/current.txt\n+++ b/current.txt\n@@ -1 +1 @@\n-old\n+current Git content\n",
      beforeContent: null,
      afterContent: null,
    }),
  },
} as unknown as IServiceAccessor;
const broadcastService = {
  send: async () => {},
  onMessage: () => () => {},
} as unknown as IBroadcastService;

function Fixture() {
  const [lease, setLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    const lease = layer.acquire(sessionId);
    setLease(lease);
    return () => lease.release();
  }, []);
  const [source, setSource] = useState<GitChangeSourceId>("last-turn");
  const [refreshToken, setRefreshToken] = useState(0);
  const [historyToken, setHistoryToken] = useState(0);
  const [request, setRequest] = useState<GitTurnReviewRequest | null>(null);
  const [, rerender] = useState(0);
  const last = useGitLastTurn({
    workspacePath,
    lease,
    transport,
    refreshToken: historyToken,
    reviewTurn: request,
  });
  const gitState = useGitRepository({
    workspacePath,
    activeTaskId: sessionId,
    includeExtendedData: true,
    refreshToken,
    lastTurnDataset: { ...last, isSelectedTurn: Boolean(request) },
  });
  useGitAutoRefresh({
    workspacePath,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: true,
    livePanelVisible: true,
    onRefreshGit: () => setRefreshToken((value) => value + 1),
  });
  const context = {
    workspacePath,
    theme: "light",
    codePreviewSettings: useLCodeStore((state) => state.codePreviewSettings),
    onReviewTurn: (h: TurnHeaderRow) => {
      setRequest({ workspacePath, sessionId, header: h, logEpoch: "epoch" });
      setSource("last-turn");
    },
  } as unknown as ConversationRowRenderContext;
  Object.assign(window, {
    __liveReview: {
      phase: (next: typeof phase) => {
        phase = next;
        for (const listener of watchers.values()) listener({ dirPath: workspacePath });
      },
      finish: (state: typeof nextState) => {
        nextState = state;
        seq++;
        emit(`sub-${subscriptions}`);
        rerender((value) => value + 1);
      },
      failure: (value: boolean) => {
        detailFailure = value;
        setHistoryToken((value) => value + 1);
      },
      delayDetails: (value: number) => {
        detailDelay = value;
      },
      slow: (value: number) => {
        delayGit = value;
      },
      metrics: () => ({
        refreshes,
        detailReads,
        detailCompleted,
        maxInFlight,
        watchers: watchers.size,
        subscriptions,
        files: gitState.datasets["last-turn"].sections.flatMap((section) => section.changes).length,
      }),
    },
  });
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <div data-testid="previous-turn">
        <ConversationFileSummaryPanel header={header(1, 48)} context={context} />
      </div>
      <div data-testid="next-turn">
        <ConversationFileSummaryPanel header={header(4, 1, nextState)} context={context} />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <GitPane
          workspacePath={workspacePath}
          gitState={gitState}
          selectedSourceId={source}
          fileChangeFindActiveIndex={0}
          fileChangeFindNavigationRequestId={0}
          fileChangeFindQuery=""
          onFileChangeFindMatchCountChange={() => {}}
          onSelectSource={(next) => {
            setRequest(null);
            setSource(next);
          }}
          onClose={() => {}}
          onRefresh={() => {
            setRefreshToken((value) => value + 1);
            setHistoryToken((value) => value + 1);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <StoreProvider broadcastService={broadcastService}>
          <TabStoreProvider>
            <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
              <Fixture />
            </LCodeIntlProvider>
          </TabStoreProvider>
        </StoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </StrictMode>,
);
