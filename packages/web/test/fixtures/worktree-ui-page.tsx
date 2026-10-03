import { useState, type ReactNode } from "react";
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
  const { intl } = useLCodeIntl();
  controller.chooseScope = setIdentity;
  controller.hideDraft = () => setDraftVisible(false);
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
      />
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
