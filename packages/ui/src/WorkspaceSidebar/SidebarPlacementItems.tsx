import type { ComponentType, ReactNode } from "react";
import { sidebarEntryKey, type SidebarEntryRef } from "@lcode/shared";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarPlacementItems({
  entry,
  Item,
  Separator,
  pinned = false,
}: {
  entry: SidebarEntryRef;
  pinned?: boolean;
  Item: ComponentType<{
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    title?: string;
  }>;
  Separator: ComponentType;
}) {
  const organization = useSidebarOrganization();
  const text = useSidebarText();
  if (!organization) return null;
  const sectionId = organization.sectionFor(entry);
  const scope =
    entry.kind === "task" ? entry.workspace : entry.kind === "project" ? entry : entry.origin;
  const project = organization.catalog.find(
    (item) =>
      item.ref.kind === "project" &&
      sidebarEntryKey(item.ref) === sidebarEntryKey({ kind: "project", ...scope }),
  );
  const entries =
    organization.batch &&
    organization.selected.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry))
      ? organization.selected
      : [entry];
  return (
    <>
      <Separator />
      {entry.kind === "task" ? (
        <Item onSelect={() => organization.inspectScope(entry)}>{text("inspectScope")}</Item>
      ) : null}
      {project ? (
        <Item
          onSelect={() =>
            organization.editProject({
              ...scope,
              label: project.label,
              ...(project.ref.kind === "project"
                ? { localProjectId: project.ref.localProjectId }
                : {}),
            })
          }
        >
          {text(entry.kind === "project" ? "editProject" : "editSourceProject")}
        </Item>
      ) : null}
      <Item
        disabled={!organization.writable}
        onSelect={() => organization.showDialog({ type: "move", entries })}
      >
        {text(
          pinned
            ? "movePinned"
            : sectionId
              ? "moveOther"
              : entry.kind === "task"
                ? "moveTask"
                : "move",
        )}
      </Item>
      {sectionId ? (
        <Item
          disabled={!organization.writable}
          onSelect={() => void organization.run([{ type: "move", entries, sectionId: null }])}
        >
          {text("remove")}
        </Item>
      ) : null}
      <Item
        disabled={!organization.writable}
        onSelect={() => organization.showDialog({ type: "create", entries })}
      >
        {text("createMove")}
      </Item>
    </>
  );
}
