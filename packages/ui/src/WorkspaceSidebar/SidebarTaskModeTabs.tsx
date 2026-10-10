import type { CSSProperties, RefObject } from "react";
import { Folder, GitBranch, Hash } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export type SidebarPrimaryTaskMode = "grouped" | "workspace" | "worktrees";
export function SidebarTaskModeTabs({
  value,
  onValueChange,
  listRef,
  triggerRefs,
  indicatorStyle,
}: {
  value: SidebarPrimaryTaskMode;
  onValueChange: (value: string) => void;
  listRef?: RefObject<HTMLDivElement | null>;
  triggerRefs?: RefObject<Record<SidebarPrimaryTaskMode, HTMLButtonElement | null>>;
  indicatorStyle?: CSSProperties;
}) {
  const { intl } = useLCodeIntl();
  const modes = [
    { value: "grouped", icon: Hash, label: "workspaceSidebar.organizeGrouped" },
    { value: "workspace", icon: Folder, label: "workspaceSidebar.organizeByProject" },
    { value: "worktrees", icon: GitBranch, label: "workspaceSidebar.organizeWorktrees" },
  ] as const;
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className="w-fit shrink-0"
      aria-label={intl.formatMessage({ id: "workspaceSidebar.organize" })}
    >
      <TabsList
        ref={listRef}
        className="relative h-7 w-fit overflow-hidden rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7"
      >
        {indicatorStyle ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0.5 left-0 rounded-full bg-background transition-[opacity,transform,width] duration-200 ease-out"
            style={indicatorStyle}
          />
        ) : null}
        {modes.map((mode) => (
          <TabsTrigger
            key={mode.value}
            ref={(node) => {
              if (triggerRefs) triggerRefs.current[mode.value] = node;
            }}
            value={mode.value}
            data-testid={`sidebar-${mode.value}-tab`}
            className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
          >
            <mode.icon aria-hidden="true" className="size-3 shrink-0" />
            <span>{intl.formatMessage({ id: mode.label })}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
