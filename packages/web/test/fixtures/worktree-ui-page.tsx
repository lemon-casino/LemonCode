import { useMemo, useState, type ReactNode } from "react";
import type { GitRepositorySummary } from "@lcode/shared";
import { DraftWorkspaceExecutionControls } from "@/worktree/DraftWorkspaceExecutionControls.js";
import { DraftWorktreeConversation } from "@/worktree/WorktreeConversationPreparation.js";
import { ProjectWorktreeManagementDialog } from "@/worktree/ProjectWorktreeManagementDialog.js";
import {
  GlobalExecutionPolicySettings,
  ProjectExecutionPolicySettings,
} from "@/worktree/ExecutionPolicySettings.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { WorktreeSettingsSection } from "@/settings/WorktreeSettingsSection.js";

export function WorktreeFixturePage({
  workspacePath,
  gitSummary,
  controller,
  children,
}: {
  workspacePath: string;
  gitSummary: GitRepositorySummary;
  controller: { chooseScope: (identity?: string) => void; hideDraft: () => void };
  children: ReactNode;
}) {
  const [identity, setIdentity] = useState<string | undefined>();
  const [draftVisible, setDraftVisible] = useState(true);
  const [managementOpen, setManagementOpen] = useState(false);
  const [reviewProjectSelected, setReviewProjectSelected] = useState(false);
  const { intl } = useLCodeIntl();
  const tabStore = useTabStoreApi();
  const settingsOpen = useTabStore(
    (state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.kind === "settings",
  );
  const workspaceTabs = useMemo(
    () => [
      {
        id: "fixture-project",
        kind: "workspace" as const,
        workspacePath,
        workspaceIdentity: identity,
        label: "Fixture project",
      },
    ],
    [workspacePath, identity],
  );
  const activeSessionId = useLCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, identity).activeTaskId,
  );
  controller.chooseScope = setIdentity;
  controller.hideDraft = () => setDraftVisible(false);
  if (settingsOpen)
    return (
      <main className="max-w-3xl p-4">
        <button
          data-testid="fixture-close-worktree-settings"
          onClick={() => {
            const id = tabStore.getState().activeTabId;
            if (id) tabStore.getState().closeTab(id);
          }}
        >
          返回工作区
        </button>
        <WorktreeSettingsSection
          section="worktrees"
          workspaceTabs={workspaceTabs}
          activeWorkspacePath={workspacePath}
          activeWorkspaceIdentity={identity}
          onSectionChange={() => {}}
        />
      </main>
    );
  return (
    <main className="w-full max-w-3xl space-y-6 p-4">
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="project-menu-trigger">
          Fixture project menu
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setManagementOpen(true)}>
            {intl.formatMessage({ id: "worktree.projectWorktrees" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectWorktreeManagementDialog
        key={identity ?? workspacePath}
        workspacePath={workspacePath}
        workspaceIdentity={identity}
        open={managementOpen}
        onOpenChange={setManagementOpen}
        onSelectSession={(sessionId) => {
          controller.lastReviewNavigation = {
            workspacePath,
            workspaceIdentity: identity,
            sessionId,
          };
          setReviewProjectSelected(true);
          useLCodeSessionStore.getState().setActiveTaskId(workspacePath, sessionId, identity);
        }}
      />
      {reviewProjectSelected && activeSessionId ? (
        <GitActionMenu
          workspacePath="/fixture/worktrees/task"
          originWorkspacePath={workspacePath}
          originWorkspaceIdentity={identity}
          executionSessionId={activeSessionId}
          executionBindingId="binding"
          gitSummary={{ ...gitSummary, workspacePath: "/fixture/worktrees/task" }}
          onRefreshGit={() => {}}
        />
      ) : null}
      {draftVisible ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-0"
          data-testid="draft-composer-header"
        >
          <button
            type="button"
            className="shrink-0 px-2 text-ui-sm"
            data-testid="draft-project-entry"
          >
            Fixture project
          </button>
          <DraftWorkspaceExecutionControls
            workspacePath={workspacePath}
            workspaceIdentity={identity}
            gitSummary={gitSummary}
            dirtyFileCount={0}
            onRefreshGit={() => {}}
          />
        </div>
      ) : null}
      {draftVisible ? (
        <section data-testid="fixture-conversation-stream">
          <DraftWorktreeConversation
            key={identity ?? workspacePath}
            workspacePath={workspacePath}
            workspaceIdentity={identity}
          />
        </section>
      ) : null}
      <section data-testid="global-policy">
        <GlobalExecutionPolicySettings />
      </section>
      <section data-testid="project-policy">
        <ProjectExecutionPolicySettings
          workspacePath={workspacePath}
          workspaceIdentity={identity}
        />
      </section>
      {children}
    </main>
  );
}

export function fixtureGitRefresh(workspacePath: string) {
  return {
    summary: {
      workspacePath,
      repoRoot: workspacePath,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "worktree/task",
      trackingBranchName: null,
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: {
      userName: "Fixture",
      userEmail: "fixture@example.invalid",
      nameSource: "local",
      emailSource: "local",
      scopeLabel: "fixture",
    },
    unstagedChanges: [
      {
        path: "file.txt",
        repoRelativePath: "file.txt",
        workspaceRelativePath: "file.txt",
        kind: "modified",
        section: "unstaged",
        added: 1,
        removed: 0,
      },
    ],
    stagedChanges: [],
  };
}
