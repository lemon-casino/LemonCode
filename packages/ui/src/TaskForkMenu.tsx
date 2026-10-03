import { useEffect, useState } from "react";
import type { LCodeTaskMeta } from "@lcode/shared";
import { GitForkIcon, FolderGit2Icon, FolderIcon, LoaderIcon } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useTaskFork, type TaskForkNavigation } from "@/hooks/useTaskFork.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function TaskForkMenu({
  task,
  remoteSessionId,
  onCreated,
  disabled,
  dropdown = false,
}: {
  task: LCodeTaskMeta;
  remoteSessionId?: string;
  onCreated: TaskForkNavigation;
  disabled?: boolean;
  dropdown?: boolean;
}) {
  const { intl } = useLCodeIntl();
  const { fork, pending, resolved } = useTaskFork(task, remoteSessionId, onCreated);
  const [capability, setCapability] = useState<{ supported: boolean; reason?: string }>({
    supported: false,
  });
  useEffect(() => {
    let active = true;
    const service = resolved.services.worktreeService;
    if (!resolved.rpcReady || !service || disabled) return;
    void service
      .getCapabilities({
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity,
      })
      .then(
        (value) => {
          if (active) setCapability({ supported: value.create, reason: value.reason });
        },
        (error: unknown) => {
          if (active)
            setCapability({
              supported: false,
              reason: error instanceof Error ? error.message : String(error),
            });
        },
      );
    return () => {
      active = false;
    };
  }, [resolved.rpcReady, resolved.services, task.workspacePath, task.workspaceIdentity, disabled]);
  const Sub = dropdown ? DropdownMenuSub : ContextMenuSub;
  const Trigger = dropdown ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
  const Content = dropdown ? DropdownMenuSubContent : ContextMenuSubContent;
  const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
  const blocked = disabled || pending || !resolved.rpcReady;
  return (
    <Sub>
      <Trigger disabled={blocked} data-testid="task-fork-menu">
        <GitForkIcon className="size-4" />
        {intl.formatMessage({ id: "taskList.fork.title" })}
      </Trigger>
      <Content className="w-80 max-w-[calc(100vw-2rem)] text-ui-sm">
        <Item
          disabled={blocked}
          data-testid="task-fork-same"
          onSelect={(event) => {
            event.preventDefault();
            void fork("same");
          }}
        >
          {task.executionBindingId ? (
            <FolderGit2Icon className="size-4 shrink-0" />
          ) : (
            <FolderIcon className="size-4 shrink-0" />
          )}
          <span className="min-w-0 whitespace-normal">
            <span className="block">
              {intl.formatMessage({
                id: task.executionBindingId
                  ? "taskList.fork.sameWorktree"
                  : "taskList.fork.sameLocal",
              })}
            </span>
            <span className="block text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.fork.shared" })}
            </span>
          </span>
        </Item>
        <Item
          disabled={blocked || !capability.supported}
          title={capability.reason}
          data-testid="task-fork-worktree"
          onSelect={(event) => {
            event.preventDefault();
            void fork("worktree");
          }}
        >
          <FolderGit2Icon className="size-4 shrink-0" />
          <span className="min-w-0 whitespace-normal">
            <span className="block">{intl.formatMessage({ id: "taskList.fork.newWorktree" })}</span>
            <span className="block text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.fork.isolated" })}
            </span>
          </span>
        </Item>
        {pending ? (
          <p role="status" className="flex items-center gap-2 px-2 py-1 text-foreground-subtle">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "taskList.fork.pending" })}
          </p>
        ) : null}
      </Content>
    </Sub>
  );
}
