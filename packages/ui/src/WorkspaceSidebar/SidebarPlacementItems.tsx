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
  const entries =
    organization.batch &&
    organization.selected.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry))
      ? organization.selected
      : [entry];
  return (
    <>
      <Separator />
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
