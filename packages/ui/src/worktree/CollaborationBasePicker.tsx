import { Layers } from "lucide-react";
import { useState } from "react";
import type { CollaborationRepositorySource } from "@/hooks/useWorktreeCapabilities.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { WorktreeBaseBranchPicker } from "./WorktreeBaseBranchPicker.js";

/** 只编辑未提交的选择；同库成员共用基线，提交后由 Host 固定实际 commit。 */
export function CollaborationBasePicker({
  repositories,
  baseRefs,
  frozen,
  supported,
  remoteSessionId,
  onChoose,
  onRefreshGit,
}: {
  repositories: CollaborationRepositorySource[];
  baseRefs?: Record<string, string>;
  frozen: boolean;
  supported: boolean;
  remoteSessionId?: string;
  onChoose(refs: Record<string, string> | undefined): void;
  onRefreshGit(): void;
}) {
  const text = useSidebarText();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open && !frozen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 gap-1 px-1 text-ui-sm"
          disabled={frozen || !supported || !repositories.length}
          data-testid="collaboration-base-trigger"
        >
          <Layers className="size-3.5 shrink-0" />
          <span className="truncate">
            {text("collaborationBases")} · {repositories.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] space-y-3 bg-menu p-3"
        data-testid="collaboration-base-picker"
      >
        <p className="text-ui-sm text-foreground-subtle">{text("collaborationBasesHint")}</p>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {repositories.map((repository) => (
            <div
              className="min-w-0 rounded-lg border border-border p-2"
              key={repository.workspaceIdentity || repository.workspacePath}
              data-testid="collaboration-base-repository"
            >
              <p className="truncate text-ui-sm font-medium" title={repository.workspacePath}>
                {repository.workspacePath.split(/[\\/]/).filter(Boolean).at(-1)}
              </p>
              <p
                className="truncate text-ui-xs text-foreground-subtle"
                title={repository.workspacePath}
              >
                {repository.workspacePath}
              </p>
              <WorktreeBaseBranchPicker
                workspacePath={repository.workspacePath}
                workspaceIdentity={repository.workspaceIdentity}
                workspaceRemoteSessionId={remoteSessionId}
                baseRef={baseRefs?.[repository.memberIds[0]!]}
                currentBranchName={repository.currentBranch}
                frozen={frozen}
                supported={supported}
                onRefreshGit={onRefreshGit}
                onChoose={(ref) => {
                  // 中文依据：同一仓库只建一棵树，不能为 frontend/contracts 提交互相矛盾的基线。
                  const next = { ...baseRefs };
                  for (const memberId of repository.memberIds) {
                    if (ref) next[memberId] = ref;
                    else delete next[memberId];
                  }
                  onChoose(Object.keys(next).length ? next : undefined);
                }}
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
