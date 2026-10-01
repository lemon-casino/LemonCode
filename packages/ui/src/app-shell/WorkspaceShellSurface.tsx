import { useMemo, useRef, type ComponentProps } from "react";
import { Group, useDefaultLayout, type LayoutStorage } from "react-resizable-panels";
import { cn } from "@/components/lib/utils.js";

const BODY_PANEL_IDS = ["conversation-column", "browser"];

/** Shell 的常驻几何层；不承载会话/显隐状态，不因断点切换内容父树。 */
export function WorkspaceShellSurface({
  isNarrowWebLayout,
  isNativeDesktop,
  className,
  ...props
}: ComponentProps<"div"> & { isNarrowWebLayout: boolean; isNativeDesktop: boolean }) {
  return (
    <div
      {...props}
      data-workspace-shell="true"
      className={cn(
        "relative flex h-full min-h-0 w-full",
        // Web 极窄屏 Tab 到工具条时，overflow:hidden 仍会被浏览器焦点算法纵向滚动，
        // 把顶部导航一起移出视口。结构壳不拥有滚动，使用 clip；正文/工具条各自保留原生滚动。
        isNativeDesktop ? "overflow-hidden" : "overflow-clip",
        !isNativeDesktop && "pt-12 [&_[data-panel]>div]:!touch-auto",
        // RRP className 落在内层，定位必须命中 data-panel 外层；抽屉越出 Group 时不能被其裁切。
        isNarrowWebLayout &&
          "[&_[data-workspace-body-group]>[data-panel]]:!flex-none [&_[data-workspace-body-group]>[data-panel]]:!w-full [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:!absolute [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:!inset-y-0 [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:!right-0 [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:!w-[calc(100%-1rem)] [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:!h-full [&_[data-workspace-body-group]>[data-workspace-side-pane-panel]]:z-40",
        className,
      )}
    />
  );
}

export function WorkspaceSidebarPanel({
  isNarrowWebLayout,
  open,
  className,
  ...props
}: ComponentProps<"div"> & { isNarrowWebLayout: boolean; open: boolean }) {
  return (
    <div
      {...props}
      data-panel=""
      data-workspace-sidebar-panel="true"
      className={cn(
        "flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
        isNarrowWebLayout
          ? "absolute inset-y-0 left-0 z-40 w-[min(22rem,calc(100%-1rem))] max-w-full bg-sidebar shadow-md"
          : "w-[var(--workspace-sidebar-panel-width)] max-w-[50%]",
        open ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    />
  );
}

export function WorkspaceContentColumn({
  isNarrowWebLayout,
  hasDesktopPanelInset = false,
  className,
  ...props
}: ComponentProps<"div"> & { isNarrowWebLayout: boolean; hasDesktopPanelInset?: boolean }) {
  return (
    <div
      {...props}
      data-panel=""
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        isNarrowWebLayout ? "min-w-0" : "min-w-[320px]",
        hasDesktopPanelInset ? "p-1 pl-0 pt-0" : "p-0",
        className,
      )}
    />
  );
}

export function WorkspaceDrawerBackdrop({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? (
    <div
      aria-hidden="true"
      data-workspace-drawer-backdrop="true"
      className="absolute inset-0 z-30 bg-black/60"
      onClick={onClose}
    />
  ) : null;
}

export function WorkspaceTopNavigation({
  isNativeDesktop,
  blocked,
  children,
}: {
  isNativeDesktop: boolean;
  blocked: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        isNativeDesktop
          ? "contents"
          : "absolute inset-x-0 top-0 h-12 border-b border-border bg-background"
      }
      inert={blocked ? true : undefined}
    >
      {children}
    </div>
  );
}

export function WorkspaceBodyPanelGroup({
  isNarrowWebLayout,
  children,
}: {
  isNarrowWebLayout: boolean;
  children: React.ReactNode;
}) {
  const persistLayoutRef = useRef(!isNarrowWebLayout);
  persistLayoutRef.current = !isNarrowWebLayout;
  const storage = useMemo<LayoutStorage>(
    () => ({
      getItem: (key) => {
        try {
          return typeof window === "undefined" ? null : window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        // 沿用原存储 key；窄屏只暂停写入，不把抽屉几何当成宽屏 split 偏好。
        if (persistLayoutRef.current) window.localStorage.setItem(key, value);
      },
    }),
    [],
  );
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: "workspace-body-layout",
    panelIds: BODY_PANEL_IDS,
    storage,
  });
  return (
    <Group
      data-workspace-body-group="true"
      defaultLayout={defaultLayout}
      onLayoutChange={isNarrowWebLayout ? undefined : onLayoutChange}
      disabled={isNarrowWebLayout}
      className={cn("flex h-full w-full min-h-0 flex-1", isNarrowWebLayout && "!overflow-visible")}
    >
      {children}
    </Group>
  );
}
