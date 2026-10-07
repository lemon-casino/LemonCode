/* eslint-disable max-lines -- 发送夹具同时覆盖 composer、工作树准备与时间线故障注入，保持一个可复用浏览器入口。 */
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView, WorktreeBinding } from "@lcode/services";
import type { ConversationSnapshot, ConversationRow } from "@lcode/shared/lcode-protocol-v4";
import { useGitFailureComposerBridge } from "@/hooks/useGitFailureHandoff.js";
import { GitFailureAction } from "@/git-action-menu/GitFailureAction.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  DraftWorktreeConversation,
  hasDraftWorktreePreparation,
  SessionWorktreePreparation,
} from "@/worktree/WorktreeConversationPreparation.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { LiveOutputRateRegistry } from "@/v4/composer/liveOutputRateRegistry.js";
import { platform } from "./git-backup-platform.js";
import { WorktreeManagementActions } from "@/worktree/WorktreeManagementActions.js";
import { createReviewWorkspaceFixture } from "./review-workspace-service.js";
import "@lcode/ui/styles.css";

const query = new URLSearchParams(location.search);
const existing = query.has("existing");
const worktree = query.has("worktree");
const initialSessionId = existing ? (query.get("session") ?? "existing-session") : null;
const workspacePath = "/fixture/origin";
const modelSelection = {
  providerId: "custom",
  modelId: "demo",
  options: { reasoningLevel: "high", speed: "fast" },
};
const view = {
  revision: 1,
  providers: [
    {
      providerId: "custom",
      providerName: "Fixture",
      config: { api: { type: "anthropic" } },
      models: [
        {
          modelId: "demo",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              maxOutputTokens: { max: 4096, map: "{}" },
              speed: { values: ["standard", "fast"], map: "{}" },
            },
          },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;
const services = {
  settingService: { get: async () => ({}), update: async () => {} },
  clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null }) },
  lcodeAgentService: {},
  lcodeTaskService: { getTaskMeta: async ({ taskId }: { taskId: string }) => ({ taskId }) },
  broadcastService: {},
  promptAttachmentTransferService: {
    cleanup: async () => {},
    cancel: async () => {},
    adopt: async () => {},
  },
  gitService: createReviewWorkspaceFixture(),
} as unknown as IServiceAccessor;
const context = {
  layer: { liveOutputRates: new LiveOutputRateRegistry() },
} as unknown as V4ConversationContextValue;
const fixture = {
  uploads: [] as { draftId?: string; sessionId?: string }[],
  calls: [] as { text: string; options: unknown }[],
  fail: false,
  hold: false,
  release: () => {},
  prepare: false,
  preparation: null as WorktreeBinding | null,
  updates: [] as unknown[],
  hideStart: () => {},
  showStart: () => {},
  forkSame: () => {},
  restartPreparation: () => {
    const draft = useDraftExecutionStore.getState().drafts[workspacePath];
    if (!draft.creationEnvelope) throw new Error("missing fixture creation request");
    useDraftExecutionStore
      .getState()
      .begin(
        workspacePath,
        draft.creationEnvelope.commandId,
        false,
        { mode: "worktree" },
        draft.creationEnvelope,
      );
  },
};
services.worktreeService = {
  getBinding: async () => structuredClone(fixture.preparation),
  prepare: async () => {
    fixture.preparation!.status = "cancelled";
    fixture.preparation!.preparation!.stage = "cancelled";
    return structuredClone(fixture.preparation);
  },
} as unknown as IServiceAccessor["worktreeService"];
services.settingService.update = async (patch) => {
  fixture.updates.push(patch);
};
Object.assign(globalThis, { __sendFixture: fixture });

function snapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    logEpoch: "fixture",
    control: { phase: "completedSuccess", canStop: false, lastError: null },
    inputRouting: { mode: "startNow" },
    config: {
      mode: "build",
      provider: "custom",
      model: "demo",
      modelSelection,
      thought: "high",
      thoughtLevels: [],
      followupMode: "queue",
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingCommands: [],
    pendingInteractions: [],
    backgroundWorks: [],
    rows: { window: [], totalCount: 0, firstRowId: null },
    goal: null,
    plan: null,
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
  } as unknown as ConversationSnapshot;
}

function App() {
  Object.assign(fixture, {
    newTask: () =>
      useLCodeSessionStore
        .getState()
        .startDraft(workspacePath, undefined, undefined, { resetDraft: true }),
  });
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [messages, setMessages] = useState<string[]>([]);
  const [draft, setDraft] = useState<V4ComposerDraft>({
    text: "",
    updatedAt: 0,
    mode: "build",
    modelSelection,
  });
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  fixture.hideStart = () => setHasOlder(true);
  fixture.showStart = () => setHasOlder(false);
  fixture.forkSame = () => {
    fixture.preparation!.taskId = "parent-session";
    setSessionId("child-same");
  };
  const executionDraft = useDraftExecutionStore((state) => state.drafts[workspacePath]);
  const preparing = !sessionId && hasDraftWorktreePreparation(executionDraft);
  const rows = useMemo(
    () =>
      messages.map((text, index) => ({
        kind: "userInput",
        rowId: index + 1,
        turnId: `turn-${index}`,
        text,
        createdAt: index,
        origin: "realUser",
      })) as ConversationRow[],
    [messages],
  );
  const rowContext = useMemo(
    () => ({
      workspacePath,
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [],
  );
  const initialSlot = useMemo(
    () =>
      sessionId && fixture.preparation ? (
        <SessionWorktreePreparation workspacePath={workspacePath} sessionId={sessionId} />
      ) : undefined,
    [sessionId],
  );
  const config = useMemo(
    () => ({ mode: draft.mode, modelSelection: draft.modelSelection }),
    [draft.mode, draft.modelSelection],
  );
  const state = useMemo(() => (sessionId ? snapshot(sessionId) : null), [sessionId]);
  const updateContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      setDraft((current) =>
        current.text === content.text &&
        current.editorStateJson === content.editorStateJson &&
        current.mention === content.mention
          ? current
          : { ...current, editorStateJson: undefined, mention: undefined, ...content },
      );
    },
    [],
  );
  const replaceDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) =>
      setDraft({ ...replacement, updatedAt: Date.now() }),
    [],
  );
  const failureBridge = useGitFailureComposerBridge(
    workspacePath,
    undefined,
    sessionId,
    query.has("handoff"),
  );
  const composer = (
    <ConversationComposer
      centered={!sessionId && !preparing}
      workspacePath={workspacePath}
      executionWorkspacePath={worktree ? "/fixture/worktrees/task" : workspacePath}
      executionSourceFolderPaths={worktree ? ["/fixture/worktrees/task"] : [workspacePath]}
      sessionId={sessionId}
      externalTextInsertRequest={failureBridge.request}
      onExternalTextInsertApplied={failureBridge.consume}
      snapshot={state}
      draftMode={!sessionId}
      draftConfig={config}
      composerDraft={draft}
      updateComposerContent={updateContent}
      replaceComposerDraft={replaceDraft}
      createSubmissionFromComposer={() => createComposerSubmissionConfig(config, view)}
      submissionReady={
        createComposerSubmissionConfig(config, view) !== null &&
        !(!sessionId && Boolean(executionDraft?.requestId || executionDraft?.error))
      }
      // 与真实 pane 一致：准备门禁只阻止再次发送，编辑下一条草稿仍可用。
      disabled={false}
      modelSelectionView={view}
      modelSelectionState={{ status: "ready", view }}
      attachmentPut={async (params, options) => {
        fixture.uploads.push(params);
        options?.onProgress?.({ phase: "committing", uploadedBytes: 1, totalBytes: 1 });
        return { ref: "artifact://fixture-pasted-image" };
      }}
      onSendText={async (text, options) => {
        fixture.calls.push({ text, options });
        let preparingId: string | undefined;
        if (worktree && !sessionId && fixture.prepare) {
          const envelope = createCommandEnvelope({
            type: "createSession",
            sessionId: null,
            payload: {
              workspaceId: workspacePath,
              execution: { mode: "worktree" },
              firstInput: { text },
            },
          });
          preparingId = envelope.commandId;
          fixture.preparation = {
            id: "prepared-binding",
            taskId: "created-session",
            requestId: preparingId,
            originalWorkspacePath: workspacePath,
            workspacePath: "/fixture/worktrees/task",
            checkoutPath: "/fixture/worktrees/task",
            branch: "lcode/task-聊天区首发",
            targetBranch: "main",
            status: "preparing",
            preparation: {
              stage: "environment",
              activeStep: "environment",
              log: "Preparing workspace\nChecking out files\nInstalling dependencies\n",
              logTruncated: false,
              environmentSource: "detected",
              cancelRequested: false,
            },
          } as unknown as WorktreeBinding;
          useDraftExecutionStore
            .getState()
            .begin(workspacePath, preparingId, false, { mode: "worktree" }, envelope);
        }
        if (fixture.hold)
          await new Promise<void>((resolve) => {
            fixture.release = resolve;
          });
        if (fixture.fail || fixture.preparation?.status === "cancelled") {
          if (preparingId)
            useDraftExecutionStore
              .getState()
              .settle(workspacePath, preparingId, "worktreePreparationFailed");
          setError("fixture-send-failed");
          throw new Error("fixture-send-failed");
        }
        if (preparingId) useDraftExecutionStore.getState().reset(workspacePath);
        setSessionId((current) => current ?? "created-session");
        setMessages((current) => [...current, text]);
      }}
      onStop={() => {}}
      onSelectModel={() => {}}
      onSelectThought={() => {}}
      onSelectSpeed={() => {}}
      onSwitchMode={() => {}}
    />
  );
  return (
    <main className="@container/conversation flex h-dvh max-w-full flex-col bg-background text-foreground">
      {query.has("handoff") && !query.has("preparationFailure") ? (
        <GitFailureAction
          workspacePath={workspacePath}
          sessionId={sessionId ?? undefined}
          context={{
            phase: "merge",
            workspacePath: "/fixture/worktrees/task",
            targetBranch: "L-GO",
            targetPath: "/fixture/origin",
            candidatePath: "/fixture/candidate",
            error: "conflict: src/button.ts:12",
            files: ["src/button.ts"],
            ...(query.has("environmentFailure")
              ? {
                  environmentError: {
                    code: "dependency-install-failed" as const,
                    stage: "preparingDependencies" as const,
                    retryable: true,
                    message: "fixture environment preparation failed",
                    diagnostic: {
                      environmentId: "a".repeat(32),
                      purpose: "worktree" as const,
                      revision: 2,
                      manifestDigest: "fixture-manifest",
                      command: "pnpm install",
                      exitCode: 1,
                      stderrTail: "token=fixture-private",
                      paths: ["/fixture/worktrees/task"],
                    },
                  },
                }
              : {}),
          }}
        />
      ) : null}
      <aside data-testid="session-list">{sessionId ?? ""}</aside>
      {sessionId && fixture.preparation ? (
        <WorktreeManagementActions
          workspacePath={workspacePath}
          sessionId={sessionId}
          busy={false}
        />
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div data-testid="sent-messages" className="flex min-h-0 flex-1 flex-col">
        <ConversationTimeline
          rows={rows}
          totalCount={rows.length}
          sessionKey={sessionId ?? "draft"}
          rowContext={rowContext}
          canLoadOlder={hasOlder}
          bottomDock={composer}
          centerEmptyStateWithDock={!sessionId && !preparing}
          emptyState={
            !sessionId && !preparing ? <p data-testid="fixture-welcome">Welcome</p> : null
          }
          headerSlot={
            preparing ? <DraftWorktreeConversation workspacePath={workspacePath} /> : null
          }
          initialUserInputSlot={initialSlot}
        />
      </div>
    </main>
  );
}

function TimelineDepthFixture() {
  const allRows = useMemo(() => {
    const rows: ConversationRow[] = [];
    for (let turn = 0; turn < 84; turn += 1) {
      const rowId = turn * 4 + 1;
      const base = { turnId: `turn-${turn}`, createdAt: turn, createdAtSeq: turn };
      rows.push(
        { ...base, rowId, kind: "userInput", origin: "realUser", text: `Question ${turn}` },
        {
          ...base,
          rowId: rowId + 1,
          kind: "reasoning",
          text: `Reasoning ${turn} `.repeat(20),
          state: "complete",
        },
        {
          ...base,
          rowId: rowId + 2,
          kind: "toolCall",
          toolCallId: `tool-${turn}`,
          toolName: "Bash",
          status: "success",
          inputText: `command-${turn}`,
        },
        {
          ...base,
          rowId: rowId + 3,
          kind: "assistantText",
          text: `Answer ${turn} `.repeat(30),
          state: "complete",
        },
      );
    }
    return rows;
  }, []);
  const [visibleCount, setVisibleCount] = useState(60);
  const [session, setSession] = useState("first");
  const [mounted, setMounted] = useState(true);
  const [revision, setRevision] = useState(0);
  const [findState, setFindState] = useState({ matchCount: 0, activeIndex: -1 });
  const rows = allRows.slice(-visibleCount).map((row) => ({
    ...row,
    ...(revision ? { createdAtSeq: revision } : {}),
  }));
  const rowContext = useMemo(
    () => ({
      workspacePath,
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [],
  );
  const handleFindMatchStateChange = useCallback(
    (next: { matchCount: number; activeIndex?: number }) =>
      setFindState({ matchCount: next.matchCount, activeIndex: next.activeIndex ?? -1 }),
    [],
  );
  const handleLoadOlder = useCallback(
    () => setVisibleCount((count) => Math.min(allRows.length, count + 60)),
    [allRows.length],
  );
  const handleLoadAllOlder = useCallback(async () => {
    setVisibleCount(allRows.length);
    return { status: "hydrated" as const, logEpoch: "fixture" };
  }, [allRows.length]);
  Object.assign(globalThis, {
    __timelineDepthFixture: {
      loadOlder: () => setVisibleCount((count) => Math.min(allRows.length, count + 60)),
      loadAll: () => setVisibleCount(allRows.length),
      switchSession: () => setSession((current) => (current === "first" ? "second" : "first")),
      retry: () => {
        setMounted(false);
        requestAnimationFrame(() => setMounted(true));
      },
      resizeRows: () => setRevision((current) => current + 1),
    },
  });
  return (
    <main className="@container/conversation flex h-dvh flex-col">
      <output data-testid="timeline-depth-find-count">{findState.matchCount}</output>
      {mounted ? (
        <ConversationTimeline
          rows={rows}
          totalCount={allRows.length}
          sessionKey={session}
          scrollMemoryKey={`timeline-depth:${session}`}
          rowContext={rowContext}
          canLoadOlder={visibleCount < allRows.length}
          onLoadOlder={handleLoadOlder}
          onLoadAllOlder={handleLoadAllOlder}
          conversationFindQuery="Question"
          conversationFindActiveIndex={findState.activeIndex}
          onConversationFindMatchStateChange={handleFindMatchStateChange}
          sessionPhase="completedSuccess"
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <TabStoreProvider>
        <LCodeIntlProvider initialLocale={query.has("english") ? "en-US" : "zh-CN"}>
          <TooltipProvider>
            <V4ConversationContext value={context}>
              {query.has("timelineDepth") ? <TimelineDepthFixture /> : <App />}
            </V4ConversationContext>
          </TooltipProvider>
        </LCodeIntlProvider>
      </TabStoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
