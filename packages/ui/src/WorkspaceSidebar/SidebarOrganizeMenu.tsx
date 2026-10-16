import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ChevronRight,
  FolderPlus,
  ListFilter,
  ListChecks,
  Maximize2,
  Minimize2,
  Undo2,
  Focus,
  MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useSidebarText } from "./sidebarText.js";
import { SidebarOrganizeChoices } from "./SidebarOrganizeChoices.js";
import type { SidebarContentFocus } from "@/lib/sidebarTaskPreferences.js";

const compactQuery = "(width < 640px)";
const compactSnapshot = () =>
  typeof window !== "undefined" && window.matchMedia(compactQuery).matches;
const serverSnapshot = () => false;
function subscribeCompact(onChange: () => void) {
  const media = window.matchMedia(compactQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function SidebarOrganizeMenu({
  sortBy,
  setSortBy,
  dates,
  setDates,
  expand,
  focus,
  setFocus,
}: {
  sortBy: "created" | "updated";
  setSortBy(value: "created" | "updated"): void;
  dates: boolean;
  setDates(value: boolean): void;
  expand(value: boolean | null): void;
  focus: SidebarContentFocus;
  setFocus(value: SidebarContentFocus): void;
}) {
  const organization = useSidebarOrganization()!;
  const compact = useSyncExternalStore(subscribeCompact, compactSnapshot, serverSnapshot);
  const text = useSidebarText();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<"focus" | "sort" | null>(null);
  const hover = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const subAnchor = useRef({
    getBoundingClientRect: () => filterTrigger.current?.getBoundingClientRect() ?? new DOMRect(),
  });
  const subPanel = useRef<HTMLDivElement>(null);
  const focusAfterPanelChange = useRef<"sub" | "root" | null>(null);
  const focusSub = () => {
    const item = [
      ...(subPanel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ].find((button) => button.getClientRects().length);
    item?.focus();
    return Boolean(item);
  };
  useLayoutEffect(() => {
    if (!open) return;
    if (focusAfterPanelChange.current === "sub" && sub) {
      if (focusSub()) focusAfterPanelChange.current = null;
    } else if (focusAfterPanelChange.current === "root" && !sub) {
      filterTrigger.current?.focus();
      focusAfterPanelChange.current = null;
    }
  }, [sub, open, compact]);
  const enterSub = (kind: "focus" | "sort") => {
    if (sub === kind) focusSub();
    else {
      focusAfterPanelChange.current = "sub";
      setSub(kind);
    }
  };
  const backToRoot = () => {
    focusAfterPanelChange.current = "root";
    setSub(null);
  };
  const pendingAction = useRef<(() => void) | null>(null);
  const close = () => {
    setOpen(false);
    setSub(null);
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    if (
      event.relatedTarget instanceof Element &&
      event.relatedTarget.closest("[data-sidebar-organize-menu]")
    )
      return;
    if (document.activeElement?.closest("[data-sidebar-organize-menu][role=menu]")) return;
    close();
  };
  const action = (run: () => void) => {
    pendingAction.current = run;
    close();
  };
  const item = (label: string, run: () => void, icon?: ReactNode, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      data-sidebar-menu-item
      disabled={disabled}
      onPointerEnter={(event) => {
        if (
          event.pointerType === "mouse" &&
          !event.currentTarget.closest("[data-sidebar-sub-panel]")
        )
          setSub(null);
      }}
      onClick={() => action(run)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm outline-none hover:bg-menu-hover focus-visible:bg-menu-hover disabled:opacity-40"
    >
      {icon ?? <span className="size-4" />}
      {label}
    </button>
  );
  const divider = <div role="separator" className="my-1 border-t border-border" />;
  const sortPanel = (
    <div
      ref={subPanel}
      data-menu-panel
      data-sidebar-sub-panel
      data-sidebar-sort-panel={sub === "sort" ? "" : undefined}
      data-sidebar-focus-panel={sub === "focus" ? "" : undefined}
      role="menu"
      aria-label={text(sub === "focus" ? "focus" : "filter")}
      className="max-h-[calc(var(--radix-popover-content-available-height)-0.75rem)] w-full overflow-y-auto"
    >
      <button
        type="button"
        data-sidebar-menu-item
        className={`flex items-center gap-2 rounded-md p-2 text-ui-sm hover:bg-menu-hover ${compact ? "" : "hidden"}`}
        onClick={backToRoot}
      >
        <ArrowLeft className="size-3" />
        {text("organize")}
      </button>
      <SidebarOrganizeChoices
        kind={sub ?? "sort"}
        {...{ focus, setFocus, sortBy, setSortBy, dates, setDates }}
        action={(run) => {
          // 展示偏好不依赖浮层退场；双层同时卸载时不能把写入寄托于焦点恢复事件。
          run();
          close();
        }}
      />
    </div>
  );
  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSub(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="sm"
          className="gap-1 px-2 text-ui-sm text-foreground-subtle"
          data-sidebar-organize-menu
          data-testid="sidebar-organize"
          aria-label={text("organize")}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              hover.current = true;
              setOpen(true);
            }
          }}
          onPointerLeave={leave}
          onKeyDown={() => {
            hover.current = false;
          }}
          onPointerDown={() => {
            hover.current = false;
          }}
        >
          <MoreHorizontal className="size-4" />
          {text("sidebar")}
        </Button>
      </PopoverTrigger>
      {/* 主菜单固定宽度；桌面子菜单独立定位，不能扩大同一个右对齐容器而把主菜单向左推。 */}
      <PopoverContent
        align="end"
        sideOffset={0}
        role="menu"
        aria-label={text("organize")}
        className="w-56 max-w-[calc(100vw-16px)] gap-0 overflow-hidden rounded-lg bg-menu p-1 shadow-lg"
        data-sidebar-organize-menu
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          if (hover.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (hover.current || pendingAction.current) event.preventDefault();
          const run = pendingAction.current;
          pendingAction.current = null;
          if (run) queueMicrotask(run);
        }}
        onEscapeKeyDown={(event) => {
          if (sub) {
            event.preventDefault();
            backToRoot();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && sub) {
            event.preventDefault();
            backToRoot();
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const panel =
              (event.target as HTMLElement).closest("[data-menu-panel]") ?? event.currentTarget;
            const items = [
              ...panel.querySelectorAll<HTMLButtonElement>(
                "[data-sidebar-menu-item]:not(:disabled)",
              ),
            ].filter((button) => button.getClientRects().length > 0);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length
            ]?.focus();
          }
        }}
      >
        <Popover
          modal={false}
          open={Boolean(sub) && !compact}
          onOpenChange={(next) => {
            if (!next) setSub(null);
          }}
        >
          <PopoverAnchor virtualRef={subAnchor} />
          <div
            data-menu-panel
            className={`max-h-[calc(var(--radix-popover-content-available-height)-0.75rem)] w-full overflow-y-auto ${sub && compact ? "hidden" : ""}`}
          >
            {item(
              text("newSection"),
              () => organization.showDialog({ type: "create" }),
              <FolderPlus className="size-4" />,
              !organization.writable,
            )}
            {item(
              text("batch"),
              () => organization.setBatch(!organization.batch),
              <ListChecks className="size-4" />,
              !organization.writable,
            )}
            {divider}
            {(["focus", "sort"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="menuitem"
                aria-label={text(kind === "focus" ? "focus" : "filter")}
                aria-haspopup="menu"
                aria-expanded={sub === kind}
                data-sidebar-menu-item
                onPointerEnter={(event) => {
                  // 桌面子层以当前行作独立锚点；窄屏仅显式切层，避免 click 落入替换后的内容。
                  if (event.pointerType === "mouse" && !compact) {
                    filterTrigger.current = event.currentTarget;
                    setSub(kind);
                  }
                }}
                onClick={(event) => {
                  filterTrigger.current = event.currentTarget;
                  enterSub(kind);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") {
                    event.preventDefault();
                    filterTrigger.current = event.currentTarget;
                    enterSub(kind);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm outline-none hover:bg-menu-hover focus-visible:bg-menu-hover"
              >
                {kind === "focus" ? (
                  <Focus className="size-4" />
                ) : (
                  <ListFilter className="size-4" />
                )}
                {text(kind === "focus" ? "focus" : "filter")}
                {kind === "focus" && focus !== "all" ? (
                  <span className="ml-auto text-ui-xs text-foreground-subtlest">{text(focus)}</span>
                ) : null}
                <ChevronRight
                  className={`${kind === "focus" && focus !== "all" ? "" : "ml-auto"} size-3`}
                />
              </button>
            ))}
            {divider}
            {item(text("expandAll"), () => expand(true), <Maximize2 className="size-4" />)}
            {item(text("collapseAll"), () => expand(false), <Minimize2 className="size-4" />)}
            {item(text("reset"), () => expand(null))}
            {divider}
            {item(
              text("undo"),
              organization.undo,
              <Undo2 className="size-4" />,
              !organization.writable || !organization.canUndo,
            )}
          </div>
          {/* 关闭子层时立即卸载，避免退场期间的嵌套 Escape 监听继续拦住主菜单关闭。 */}
          {compact ? (
            sub ? (
              sortPanel
            ) : null
          ) : sub ? (
            <PopoverContent
              key={sub}
              side="right"
              align="start"
              sideOffset={0}
              collisionPadding={8}
              role="presentation"
              className="w-56 max-w-[calc(100vw-16px)] gap-0 rounded-lg bg-menu p-1 shadow-lg"
              data-sidebar-organize-menu
              onPointerLeave={leave}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                if (focusAfterPanelChange.current === "sub" && focusSub())
                  focusAfterPanelChange.current = null;
              }}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                backToRoot();
              }}
            >
              {sortPanel}
            </PopoverContent>
          ) : null}
        </Popover>
      </PopoverContent>
    </Popover>
  );
}
