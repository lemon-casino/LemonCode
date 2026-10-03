import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, WorktreeBinding, WorktreeIntegration } from "@lcode/services";
import type { AppSettings, GitRepositorySummary } from "@lcode/shared";
import { WorktreeBadge } from "@/worktree/WorktreeBadge.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { useActiveExecutionWorkspace } from "@/hooks/useActiveExecutionWorkspace.js";
import { useFileMentionProvider } from "@/mentions/providers/fileMentionProvider.js";
import { platform } from "./git-backup-platform.js";
import { WorktreeWorkflowScenario } from "./worktree-ui-scenarios.js";
import { FixtureReviewPreview } from "./review-preview.js";
import { WorktreeSidebarRows } from "./worktree-sidebar-rows.js";
import { WorktreeFixturePage } from "./worktree-ui-page.js";
import {
  installForkPreparationFixture,
  beginFixtureDraftExecution,
} from "./worktree-fork-preparation.js";
import { createReviewWorkspaceFixture } from "./review-workspace-service.js";
import "@/styles.css";

const origin = "/fixture/repo";
const actual = "/fixture/worktrees/task";
let settings: AppSettings = {
  defaultSessionExecutionMode: "local",
  autoOpenGitCommitReview: true,
  projectExecutionPreferences: { other: { executionMode: "worktree" } },
};
if (new URLSearchParams(location.search).has("legacyReview")) {
  settings.autoGenerateGitCommitMessage = true;
  settings.autoOpenGitCommitReview = false;
  settings.projectExecutionPreferences![origin] = { autoOpenGitCommitReview: "enabled" };
}
if (new URLSearchParams(location.search).has("legacySetup")) {
  settings.projectExecutionPreferences![origin] = {
    setupCommands: ["pnpm install", "pnpm build"],
    copyIgnoredPaths: ["cache/data"],
    validationCommands: ["pnpm test"],
  };
}
const binding: WorktreeBinding = {
  id: "binding",
  taskId: "orphan",
  requestId: "request",
  originalWorkspacePath: origin,
  workspacePath: actual,
  repositoryRoot: origin,
  commonDirectory: origin + "/.git",
  checkoutPath: actual,
  branch: "worktree/task",
  baseCommit: "base",
  targetBranch: "L-GO",
  sourceFolderPaths: [actual, actual + "/tools"],
  status: "ready",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};
const calls: { method: string; params: unknown }[] = [];
const candidate = "c".repeat(40);
const createFixtureIntegration = (): WorktreeIntegration => ({
  id: "operation",
  bindingId: binding.id,
  requestId: "merge",
  sourceHead: "s".repeat(40),
  targetHead: "t".repeat(40),
  mergeBase: "b".repeat(40),
  targetBranch: "L-GO",
  targetPath: origin,
  checkoutPath: "/fixture/integration",
  candidateHead: candidate,
  status: "awaiting-review",
  conflictPaths: [],
  diff: "+ feature",
  validationCommands: ["fixture-check"],
  validationResults: [],
  createdAt: "now",
  updatedAt: "now",
});
let operation: WorktreeIntegration | null = new URLSearchParams(location.search).has("seedReview")
  ? createFixtureIntegration()
  : null;
if (operation) binding.latestIntegrationId = operation.id;
const fixture = {
  calls,
  failSave: false,
  holdSave: false,
  releaseSave: () => {},
  failBranches: false,
  failRead: false,
  holdRead: false,
  releaseRead: () => {},
  supported: true,
  failPublication: false,
  failRemote: true,
  failIntegration: false,
  conflicted: false,
  conflictCount: 1,
  ignoredCount: 0,
  targetHead: candidate,
  operation: () => operation,
  chooseScope: (_identity?: string) => {},
  chooseTask: (_task: string | null) => {},
  hideDraft: () => {},
  settings: () => settings,
  chooseDraft: (intent: { mode?: "local" | "worktree"; baseRef?: string }) =>
    useDraftExecutionStore.getState().choose(origin, intent),
  resetDraft: () => useDraftExecutionStore.getState().reset(origin),
  externalMode: (mode: "local" | "worktree") => {
    settings.projectExecutionPreferences![origin] = {
      ...settings.projectExecutionPreferences![origin],
      executionMode: mode,
    };
  },
  begin: (scope = origin) => beginFixtureDraftExecution(scope),
  fail: (scope = origin) =>
    useDraftExecutionStore
      .getState()
      .settle(scope, "same-request", "fault.command.worktreePreparationFailed"),
  draft: (scope = origin) => useDraftExecutionStore.getState().drafts[scope],
  invalidate: () => useWorktreeLifecycleStore.getState().invalidate(origin),
};
Object.assign(window, { __worktreeFixture: fixture });
const services = {
  settingService: {
    get: async () => structuredClone(settings),
    update: async (patch: Partial<AppSettings>) => {
      calls.push({ method: "settings.update", params: patch });
      if (fixture.holdSave)
        await new Promise<void>((resolve) => {
          fixture.releaseSave = resolve;
        });
      if (fixture.failSave) throw new Error("fixture-save-failed");
      const preferences = { ...settings.projectExecutionPreferences };
      for (const [key, value] of Object.entries(patch.projectExecutionPreferences ?? {}))
        preferences[key] = { ...preferences[key], ...value };
      settings = { ...settings, ...patch, projectExecutionPreferences: preferences };
    },
  },
  gitService: {
    ...createReviewWorkspaceFixture(),
    getDiff: async ({ path }: { path: string }) => {
      calls.push({ method: "diff", params: { path } });
      return {
        path,
        availability: "patch",
        patch: "+fixture",
        beforeContent: "",
        afterContent: "fixture",
      };
    },
    getPublishState: async (params: unknown) => {
      calls.push({ method: "publishState", params });
      return {
        headCommitHash: fixture.targetHead,
        branchName: "L-GO",
        indexFingerprint: "index",
        worktreeFingerprint: "files",
      };
    },
    listRemotes: async (params: unknown) => {
      calls.push({ method: "remotes", params });
      return {
        remotes: [
          { name: "origin", url: "fixture-origin" },
          { name: "backup", url: "fixture-backup" },
        ],
      };
    },
    listTags: async () => ({ tags: [], unsupportedTags: [] }),
    push: async (params: { remote: string }) => {
      calls.push({ method: "push", params });
      if (params.remote === "backup" && fixture.failRemote)
        throw new Error("fixture-remote-offline");
      return {};
    },
    getLocalBranches: async (params: unknown) => {
      calls.push({ method: "branches", params });
      if (fixture.failBranches) throw new Error("fixture-branches-failed");
      return {
        headRefType: "branch",
        currentBranchName: "L-GO",
        branches: ["L-GO", "feature"].map((name) => ({
          name,
          isCurrent: name === "L-GO",
          upstreamName: null,
          commitHash: "base",
          commitTimestampMs: null,
        })),
      };
    },
    switchBranch: async (params: unknown) => {
      calls.push({ method: "switchBranch", params });
      throw new Error("unexpected Git mutation");
    },
  },
  worktreeService: {
    getIntegration: async () => structuredClone(operation),
    integrate: async (params: {
      requestId: string;
      sourceCommits?: { review?: { id: string; groupId: string } }[];
    }) => {
      calls.push({ method: "integrate", params });
      if (fixture.failIntegration) throw new Error("fixture-integration-unavailable");
      binding.latestIntegrationId = "operation";
      operation = createFixtureIntegration();
      if (fixture.conflicted) {
        operation.status = "conflicted";
        operation.conflictPaths =
          fixture.conflictCount === 1
            ? ["file.txt"]
            : Array.from({ length: fixture.conflictCount }, (_, i) => `file-${i}.txt`);
        operation.candidateHead = undefined;
      }
      if (params.sourceCommits)
        operation.sourceReceipts = params.sourceCommits.map((command) => ({
          reviewId: command.review!.id,
          groupId: command.review!.groupId,
          commitHash: candidate,
        }));
      return structuredClone(operation);
    },
    continueIntegration: async (params: { cancel?: boolean }) => {
      calls.push({ method: "continueIntegration", params });
      if (params.cancel) {
        operation!.status = "cancelled";
        return structuredClone(operation);
      }
      operation!.status = operation!.status === "conflicted" ? "awaiting-review" : "ready";
      operation!.candidateHead = candidate;
      operation!.conflictPaths = [];
      operation!.validationResults = [{ command: "fixture-check", exitCode: 0, output: "checked" }];
      return structuredClone(operation);
    },
    publishIntegration: async (params: unknown) => {
      calls.push({ method: "publishIntegration", params });
      operation!.status = fixture.failPublication ? "publishing" : "published";
      if (fixture.failPublication) throw new Error("fixture-publication-response-lost");
      return structuredClone(operation);
    },
    getCapabilities: async (params: unknown) => {
      calls.push({ method: "capabilities", params });
      return {
        supported: fixture.supported,
        create: fixture.supported,
        archive: true,
        restore: true,
        integrate: true,
        head: "base",
      };
    },
    prepare: async (params: unknown) => {
      calls.push({ method: "prepare", params });
      throw new Error("UI must not prepare");
    },
    list: async (params: unknown) => {
      calls.push({ method: "list", params });
      return [structuredClone(binding)];
    },
    getBinding: async (params: { taskId: string }) =>
      params.taskId === "local" ? null : structuredClone(binding),
    archive: async (params: { acknowledgeIgnoredFiles?: boolean }) => {
      calls.push({ method: "archive", params });
      if (!params.acknowledgeIgnoredFiles)
        throw new Error("Ignored files require explicit acknowledgement");
      binding.status = "archived";
      binding.snapshot = {
        commit: "snapshot",
        indexTree: "index",
        head: "base",
        createdAt: "2026-01-01",
        ignoredPaths: Array.from({ length: fixture.ignoredCount }, (_, i) => `ignored-${i}.env`),
      };
      return structuredClone(binding);
    },
    restore: async (params: unknown) => {
      calls.push({ method: "restore", params });
      binding.status = "ready";
      return structuredClone(binding);
    },
  },
  lcodeSessionService: {
    readSession: async ({ sessionId }: { sessionId: string }) => {
      if (fixture.holdRead)
        await new Promise<void>((resolve) => {
          fixture.releaseRead = resolve;
        });
      if (fixture.failRead) throw new Error("fixture-read-failed");
      return {
        session: {
          workspace:
            sessionId === "local"
              ? { workspacePath: origin }
              : {
                  workspacePath: actual,
                  executionBindingId: binding.id,
                  originWorkspacePath: origin,
                },
        },
      };
    },
  },
  fileService: {
    searchWorkspaceFiles: async (params: unknown) => {
      calls.push({ method: "fileSearch", params });
      return [];
    },
  },
} as unknown as IServiceAccessor;
installForkPreparationFixture(services, calls, binding);
const summary: GitRepositorySummary = {
  workspacePath: origin,
  repoRoot: origin,
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [],
  branchName: "L-GO",
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: true,
  isRepository: true,
};

function FileSearch({
  workspacePath,
  roots,
}: {
  workspacePath: string;
  roots?: readonly string[];
}) {
  useFileMentionProvider(workspacePath, undefined, "", true, "empty", "Files", 8, roots);
  return (
    <button type="button" data-testid="file-entry" data-workspace={workspacePath}>
      Files
    </button>
  );
}
function ActiveExecution() {
  const [task, setTask] = useState<string | null>("local");
  fixture.chooseTask = setTask;
  const execution = useActiveExecutionWorkspace(origin, undefined, task);
  return (
    <section>
      <WorktreeBadge bindingId={execution.binding?.id} />
      <output data-testid="actual-location">
        {execution.pending ? "pending" : (execution.workspace?.workspacePath ?? "unavailable")}
      </output>
      {execution.workspace ? (
        <FileSearch
          workspacePath={execution.workspace.workspacePath}
          roots={execution.binding?.sourceFolderPaths}
        />
      ) : null}
      {execution.error ? <p role="alert">{execution.error}</p> : null}
    </section>
  );
}
function Fixture() {
  return (
    <WorktreeFixturePage workspacePath={origin} gitSummary={summary} controller={fixture}>
      <ActiveExecution />
    </WorktreeFixturePage>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <LCodeIntlProvider initialLocale={location.search.includes("english") ? "en-US" : "zh-CN"}>
          <TooltipProvider>
            <FixtureReviewPreview />
            {new URLSearchParams(location.search).has("scenario") ? (
              <WorktreeWorkflowScenario
                mode={new URLSearchParams(location.search).get("scenario")!}
                onResolve={async (operationId) => {
                  calls.push({ method: "resolveWithAI", params: { operationId } });
                  operation!.status = "awaiting-review";
                  operation!.candidateHead = candidate;
                  operation!.conflictPaths = [];
                }}
              />
            ) : new URLSearchParams(location.search).has("sidebar") ? (
              <WorktreeSidebarRows />
            ) : (
              <Fixture />
            )}
          </TooltipProvider>
        </LCodeIntlProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
