import { useState, type ReactNode } from "react";
import { sidebarEntryKey, sidebarEntryRefSchema, type SidebarEntryRef } from "@lcode/shared";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSidebarText } from "./sidebarText.js";
import { sidebarInsertionIndex } from "@/lib/sidebarOrganization.js";
import { Checkbox } from "@/components/ui/checkbox.js";

export function SidebarEntryInteraction({
  entry,
  children,
}: {
  entry: SidebarEntryRef;
  children: ReactNode;
}) {
  const organization = useSidebarOrganization();
  const [over, setOver] = useState(false);
  const text = useSidebarText();
  const selected = organization?.selected.some(
    (item) => sidebarEntryKey(item) === sidebarEntryKey(entry),
  );
  return (
    <div
      className={`relative flex min-w-0 items-start rounded-lg ${selected ? "bg-selected" : ""} ${over ? "border-t-2 border-brand" : ""}`}
      data-sidebar-entry={sidebarEntryKey(entry)}
      data-sidebar-ref={JSON.stringify(entry)}
      onClickCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey || event.shiftKey) &&
          !(event.target as HTMLElement).closest("[data-task-item-key]")
        ) {
          event.preventDefault();
          event.stopPropagation();
          organization?.setBatch(true);
          organization?.select(entry, event.shiftKey);
        }
      }}
      onContextMenuCapture={(event) => {
        if (!(event.target as HTMLElement).closest("[data-task-item-key]"))
          organization?.target(entry);
      }}
      draggable={organization?.writable}
      onDragStart={(event) => {
        if ((event.target as HTMLElement).closest("[data-task-item-key]")) return;
        event.dataTransfer.setData(
          "application/x-lcode-sidebar-entry",
          JSON.stringify(selected ? organization?.selected : [entry]),
        );
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/x-lcode-sidebar-entry")) {
          event.preventDefault();
          event.stopPropagation();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const raw = event.dataTransfer.getData("application/x-lcode-sidebar-entry");
        if (!raw || !organization?.writable) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          const entries = (JSON.parse(raw) as unknown[]).map((item) =>
            sidebarEntryRefSchema.parse(item),
          );
          const section = organization.snapshot.sections.find(
            (item) => item.id === organization.sectionFor(entry),
          );
          if (section) {
            // index 必须按移除拖动项后的列表计算；沿用旧索引会把“放在目标前”错误插到目标后。
            const index = sidebarInsertionIndex(section.entries, entries, entry);
            if (index === null) return;
            void organization.run([
              {
                type: "move",
                entries,
                sectionId: section.id,
                index,
              },
            ]);
          } else {
            const roots = [
              ...new Map(
                [
                  ...organization.snapshot.rootOrders,
                  ...organization.catalog.map((item) => item.ref),
                ]
                  .filter((item) => item.kind === entry.kind && !organization.sectionFor(item))
                  .map((item) => [sidebarEntryKey(item), item]),
              ).values(),
            ];
            const keys = new Set(entries.map(sidebarEntryKey));
            const rest = roots.filter((item) => !keys.has(sidebarEntryKey(item)));
            const index = rest.findIndex(
              (item) => sidebarEntryKey(item) === sidebarEntryKey(entry),
            );
            const sameKind = entries.filter((item) => item.kind === entry.kind);
            rest.splice(index < 0 ? rest.length : index, 0, ...sameKind);
            void organization.run([
              { type: "move", entries, sectionId: null },
              { type: "reorderRoot", kind: entry.kind, entries: rest },
            ]);
          }
        } catch {
          /* 非侧栏引用不能改变组织结构。 */
        }
      }}
    >
      {organization?.batch ? (
        <Checkbox
          aria-label={`${text("selected")} ${organization.catalog.find((item) => sidebarEntryKey(item.ref) === sidebarEntryKey(entry))?.label ?? ""}`}
          checked={Boolean(selected)}
          onCheckedChange={() => organization.select(entry)}
          className="ml-2 mt-2 size-3.5 shrink-0"
        />
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
