import { Check } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import { useSidebarText } from "./sidebarText.js";
export function SidebarSortContextMenu({
  sortBy,
  setSortBy,
  dates,
  setDates,
}: {
  sortBy: "created" | "updated";
  setSortBy(value: "created" | "updated"): void;
  dates: boolean;
  setDates(value: boolean): void;
}) {
  const text = useSidebarText();
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>{text("filter")}</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {(["updated", "created"] as const).map((value) => (
            <ContextMenuItem key={value} onSelect={() => setSortBy(value)}>
              <Check className={`size-3 ${sortBy === value ? "" : "invisible"}`} />
              {text(value)}
            </ContextMenuItem>
          ))}
          <ContextMenuSeparator />
          {([false, true] as const).map((value) => (
            <ContextMenuItem key={String(value)} onSelect={() => setDates(value)}>
              <Check className={`size-3 ${dates === value ? "" : "invisible"}`} />
              {text(value ? "dates" : "compact")}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
    </>
  );
}
