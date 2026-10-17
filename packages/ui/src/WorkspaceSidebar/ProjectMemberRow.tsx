import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Folder, X } from "lucide-react";
import { PROJECT_MEMBER_PURPOSE_MAX_LENGTH, type ProjectMember } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Textarea } from "@/components/ui/textarea.js";
import { getPathLeaf } from "@/lib/path.js";
import { SidebarSourceReadError } from "./SidebarSourceReadError.js";
import {
  formatProjectMemberPurpose,
  useProjectEditorText,
  useProjectRoleText,
} from "./projectEditorText.js";
import { useSidebarText } from "./sidebarText.js";

export function ProjectMemberRow({
  member,
  primary,
  primaryLocked = true,
  first,
  last,
  disabled,
  error,
  remote,
  ready,
  onChange,
  onRemove,
  onMove,
}: {
  member: ProjectMember;
  primary: boolean;
  primaryLocked?: boolean;
  first?: boolean;
  last?: boolean;
  disabled: boolean;
  error?: string;
  remote: boolean;
  ready: boolean;
  onChange(member: ProjectMember): void;
  onRemove(): void;
  onMove?(delta: number): void;
}) {
  const text = useProjectEditorText();
  const roleText = useProjectRoleText();
  const sidebar = useSidebarText();
  const name = getPathLeaf(member.path) || member.path;
  // 中文依据：旧用途仅做兼容合并；已合并的输入必须读取原值，不能 trim 掉正在输入的空格或换行。
  const purpose = member.role ? formatProjectMemberPurpose(member, roleText) : member.description;
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pointerActive = useRef(false);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!editing) return;
    // 中文依据：pointerdown 失焦后立即收起会改变列表 scrollTop，吞掉 checkbox 的 click；click 定靶后再收起，键盘失焦仍立即处理。
    const pointerDown = () => {
      pointerActive.current = true;
    };
    const pointerEnd = () => {
      pointerActive.current = false;
    };
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!input.current?.contains(event.target) && !trigger.current?.contains(event.target))
        setEditing(false);
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointerup", pointerEnd, true);
    document.addEventListener("pointercancel", pointerEnd, true);
    document.addEventListener("click", click, true);
    return () => {
      pointerActive.current = false;
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointerup", pointerEnd, true);
      document.removeEventListener("pointercancel", pointerEnd, true);
      document.removeEventListener("click", click, true);
    };
  }, [editing]);
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [editing]);
  return (
    <div className="min-w-0 px-3 py-2" data-project-member={member.path}>
      <div className="flex min-w-0 items-center gap-2">
        <Folder className="size-4 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate text-ui-base font-medium" title={name}>
          {name}
        </span>
        {primary ? (
          <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {text("primary")}
          </span>
        ) : null}
        {error ? (
          <SidebarSourceReadError label={name} workspacePath={member.path} error={error} />
        ) : null}
        {onMove ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || first}
              aria-label={`${name} · ${sidebar("up")}`}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || last}
              aria-label={`${name} · ${sidebar("down")}`}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled || (primary && primaryLocked)}
          title={primary && primaryLocked ? text("primaryHint") : text("remove")}
          aria-label={`${name} · ${text("remove")}`}
          onClick={onRemove}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 pl-6">
        <p
          className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle"
          title={member.path}
        >
          {member.path}
        </p>
        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
          {text(remote ? "remote" : "local")}
          {!ready ? ` · ${text("disconnected")}` : ""}
        </span>
      </div>
      <div className="mt-1 space-y-1 pl-6">
        <div className="flex items-start gap-3">
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-auto min-h-6 min-w-0 flex-1 flex-col items-start gap-1 whitespace-normal px-2 py-1 text-left font-normal"
            disabled={disabled}
            aria-label={`${name} · ${text("purpose")}`}
            onClick={() => {
              setEditing(true);
              input.current?.focus();
            }}
          >
            <span className="text-ui-xs text-foreground-subtle">{text("purpose")}</span>
            {!editing && purpose ? (
              <span className="line-clamp-2 break-words whitespace-pre-wrap text-ui-sm">
                {purpose}
              </span>
            ) : null}
          </Button>
          <label className="flex shrink-0 items-center gap-2 py-1 text-ui-xs text-foreground-subtle">
            <Checkbox
              checked={member.enabled}
              disabled={disabled}
              onCheckedChange={(value) => onChange({ ...member, enabled: value === true })}
            />
            <span>{text("defaultMember")}</span>
          </label>
        </div>
        {editing ? (
          <Textarea
            ref={input}
            autoFocus
            data-project-purpose
            aria-label={text("purpose")}
            className="h-16 min-h-16 resize-none"
            maxLength={PROJECT_MEMBER_PURPOSE_MAX_LENGTH}
            placeholder={text("purposePlaceholder")}
            disabled={disabled}
            value={purpose}
            onChange={(event) => {
              // 中文依据：输入即写入唯一项目草稿，失焦只收起；直接点击保存不会漏掉末次输入，也不在打开时迁移旧用途。
              onChange({ ...member, role: "", label: "", description: event.target.value });
            }}
            onBlur={() => {
              if (!pointerActive.current) setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              restoreFocus.current = true;
              setEditing(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
