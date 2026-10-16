import { Check } from "lucide-react";
import type { SidebarContentFocus } from "@/lib/sidebarTaskPreferences.js";
import { useSidebarText } from "./sidebarText.js";

export interface SidebarOrganizeChoicesProps {
  kind: "focus" | "sort";
  focus: SidebarContentFocus;
  setFocus(value: SidebarContentFocus): void;
  sortBy: "created" | "updated";
  setSortBy(value: "created" | "updated"): void;
  dates: boolean;
  setDates(value: boolean): void;
  action(run: () => void): void;
}

export function SidebarOrganizeChoices(props: SidebarOrganizeChoicesProps) {
  const text = useSidebarText();
  const choice = (label: string, checked: boolean, run: () => void) => (
    <button
      key={label}
      type="button"
      role={props.kind === "focus" ? "menuitemradio" : "menuitem"}
      aria-checked={props.kind === "focus" ? checked : undefined}
      data-sidebar-menu-item
      onClick={() => props.action(run)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm outline-none hover:bg-menu-hover focus-visible:bg-menu-hover aria-checked:bg-menu-hover"
    >
      <Check className={`size-4 shrink-0 ${checked ? "" : "invisible"}`} />
      {label}
    </button>
  );
  return props.kind === "focus" ? (
    <>
      {(["all", "projects", "worktrees", "chats"] as const).map((value) =>
        choice(text(value), props.focus === value, () => props.setFocus(value)),
      )}
    </>
  ) : (
    <>
      {(["updated", "created"] as const).map((value) =>
        choice(text(value), props.sortBy === value, () => props.setSortBy(value)),
      )}
      <div role="separator" className="my-1 border-t border-border" />
      {([false, true] as const).map((value) =>
        choice(text(value ? "dates" : "compact"), props.dates === value, () =>
          props.setDates(value),
        ),
      )}
    </>
  );
}
