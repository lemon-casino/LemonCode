import { useState, type ReactNode } from "react";
import { ChevronRight, Ellipsis, Hash } from "lucide-react";
import type { SidebarSection } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSidebarText } from "./sidebarText.js";

export interface SidebarHeaderAction {
  label: string;
  run(): void;
  disabled?: boolean;
  separator?: boolean;
  submenu?: SidebarHeaderAction[];
  destructive?: boolean;
}
function HeaderMenuItems({ items, context }: { items: SidebarHeaderAction[]; context?: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = context ? ContextMenuSub : DropdownMenuSub;
  const Trigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const Content = context ? ContextMenuSubContent : DropdownMenuSubContent;
  return (
    <>
      {items.map((item) => (
        <div key={item.label}>
          {item.separator ? <Separator /> : null}
          {item.submenu ? (
            <Sub>
              <Trigger disabled={item.disabled}>{item.label}</Trigger>
              <Content>
                <HeaderMenuItems items={item.submenu} context={context} />
              </Content>
            </Sub>
          ) : (
            <Item
              variant={item.destructive ? "destructive" : "default"}
              disabled={item.disabled}
              onSelect={item.run}
            >
              {item.label}
            </Item>
          )}
        </div>
      ))}
    </>
  );
}
export function SidebarSectionHeader({
  title,
  open,
  toggle,
  section,
  actions = [],
  children,
  testId,
}: {
  title: string;
  open: boolean;
  toggle(): void;
  section?: SidebarSection;
  actions?: SidebarHeaderAction[];
  children?: ReactNode;
  testId?: string;
}) {
  const organization = useSidebarOrganization();
  const text = useSidebarText();
  const [drop, setDrop] = useState(false);
  const index = organization?.snapshot.sections.findIndex((item) => item.id === section?.id) ?? 0;
  const total = organization?.snapshot.sections.length ?? 0;
  const writable = organization?.writable;
  const items: SidebarHeaderAction[] =
    section && organization
      ? [
          {
            label: text("add"),
            disabled: !writable,
            run: () => organization.showDialog({ type: "add", sectionId: section.id }),
          },
          {
            label: text("newChat"),
            run: () => organization.showDialog({ type: "target", sectionId: section.id }),
          },
          {
            label: text("rename"),
            separator: true,
            disabled: !writable,
            run: () => organization.showDialog({ type: "rename", sectionId: section.id }),
          },
          { label: text(open ? "collapse" : "expand"), run: toggle },
          {
            label: text("up"),
            separator: true,
            disabled: !writable || index === 0,
            run: () =>
              void organization.run([{ type: "reorder", sectionId: section.id, index: index - 1 }]),
          },
          {
            label: text("down"),
            disabled: !writable || index === total - 1,
            run: () =>
              void organization.run([{ type: "reorder", sectionId: section.id, index: index + 1 }]),
          },
          {
            label: text("top"),
            disabled: !writable || index === 0,
            run: () =>
              void organization.run([{ type: "reorder", sectionId: section.id, index: 0 }]),
          },
          {
            label: text("bottom"),
            disabled: !writable || index === total - 1,
            run: () =>
              void organization.run([{ type: "reorder", sectionId: section.id, index: total - 1 }]),
          },
          ...(section.entries.length
            ? [
                {
                  label: text("split"),
                  separator: true,
                  disabled: !writable,
                  run: () => organization.showDialog({ type: "split", sectionId: section.id }),
                },
                {
                  label: text("dissolve"),
                  disabled: !writable,
                  run: () => organization.showDialog({ type: "dissolve", sectionId: section.id }),
                },
              ]
            : [
                {
                  label: text("deleteEmpty"),
                  separator: true,
                  disabled: !writable,
                  run: () => void organization.run([{ type: "remove", sectionId: section.id }]),
                },
              ]),
        ]
      : actions;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-testid={testId}
          data-sidebar-section={section?.id}
          className={`group/section mt-3 flex min-w-0 items-center rounded-md px-1 ${drop ? "bg-accent ring-1 ring-brand" : ""}`}
          onDragOver={(event) => {
            if (
              event.dataTransfer.types.includes("application/x-lcode-sidebar-entry") &&
              organization?.writable
            ) {
              event.preventDefault();
              event.stopPropagation();
              setDrop(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(false);
          }}
          onDrop={(event) => {
            setDrop(false);
            const payload = event.dataTransfer.getData("application/x-lcode-sidebar-entry");
            if (!payload || !organization?.writable) return;
            event.preventDefault();
            event.stopPropagation();
            try {
              void organization.run([
                { type: "move", entries: JSON.parse(payload), sectionId: section?.id ?? null },
              ]);
            } catch {
              /* 无效外部拖放不提交。 */
            }
          }}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1.5 text-left text-ui-sm font-medium text-foreground-subtle hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
          >
            <ChevronRight
              className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            />
            {section ? <Hash className="size-3 shrink-0" /> : null}
            <span className="truncate">
              {drop ? text(section ? "drop" : "dropNatural") : title}
            </span>
          </button>
          {children}
          {items.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-6 shrink-0 text-foreground-subtle opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`${title} · ${text("more")}`}
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <HeaderMenuItems items={items} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <HeaderMenuItems items={items} context />
      </ContextMenuContent>
    </ContextMenu>
  );
}
