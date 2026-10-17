import { FolderPlus, LoaderCircle } from "lucide-react";
import {
  isSameLocalProjectPath,
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  type ProjectMember,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ProjectMemberRow } from "./ProjectMemberRow.js";
import { useProjectEditorText } from "./projectEditorText.js";

export function ProjectSourceFolders({
  members,
  primaryPath,
  primaryLocked,
  disabled,
  checking,
  remote = false,
  ready = true,
  errors,
  dragging,
  canDrop,
  addTestId,
  onAdd,
  onChange,
  onRemove,
  onMove,
}: {
  members: ProjectMember[];
  primaryPath?: string;
  primaryLocked: boolean;
  disabled: boolean;
  checking: boolean;
  remote?: boolean;
  ready?: boolean;
  errors?: Record<string, string>;
  dragging?: boolean;
  canDrop?: boolean;
  addTestId?: string;
  onAdd(): void;
  onChange(member: ProjectMember): void;
  onRemove(id: string): void;
  onMove?(index: number, delta: number): void;
}) {
  const text = useProjectEditorText();
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-ui-sm">
        <span>
          {text("folders")} · {members.length}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid={addTestId}
          disabled={disabled || !ready || members.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT}
          onClick={onAdd}
        >
          {checking ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <FolderPlus className="size-4" />
          )}
          {text("add")}
        </Button>
      </div>
      <div
        data-testid="project-folder-list"
        aria-busy={checking}
        className={cn(
          "h-48 divide-y divide-border overflow-y-auto overscroll-contain rounded-xl border border-border",
          dragging ? "border-border-hover bg-surface-hover" : "bg-surface",
        )}
      >
        {members.length ? (
          members.map((member, index) => (
            <ProjectMemberRow
              key={member.id}
              member={member}
              primary={Boolean(primaryPath && isSameLocalProjectPath(primaryPath, member.path))}
              primaryLocked={primaryLocked}
              first={!index}
              last={index === members.length - 1}
              disabled={disabled}
              remote={remote}
              ready={ready}
              error={errors?.[member.path]}
              onChange={onChange}
              onRemove={() => onRemove(member.id)}
              onMove={onMove ? (delta) => onMove(index, delta) : undefined}
            />
          ))
        ) : (
          <p className="flex h-full items-center justify-center px-3 text-ui-sm text-foreground-subtle">
            {text(canDrop ? "dropHint" : "addHint")}
          </p>
        )}
      </div>
      {canDrop && members.length ? (
        <p className="text-ui-xs text-foreground-subtlest">{text("dropHint")}</p>
      ) : null}
    </section>
  );
}
