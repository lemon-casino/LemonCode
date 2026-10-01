import { useEffect, useState } from "react";

interface FocusScrollMeasurement {
  active: string;
  activeRect: { top: number; bottom: number; visible: boolean; hit: boolean } | null;
  drawer: {
    id: string;
    top: number;
    bottom: number;
    scrollOwners: Array<{
      element: string;
      scrollTop: number;
      clientHeight: number;
      scrollHeight: number;
    }>;
  } | null;
  shellScrollTop: number;
  maxShellScrollTop: number;
  windowScrollY: number;
  navigation: { top: number; bottom: number; visible: boolean; hit: boolean };
  toolbar: { scrollLeft: number; clientWidth: number; scrollWidth: number } | null;
  ancestors: Array<{
    element: string;
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    overflowY: string;
  }>;
}

/** 只观察真实焦点/滚动后的 DOM；不改 scrollTop、不合成按键、不移动焦点。 */
export function FocusScrollProbe() {
  const [measurement, setMeasurement] = useState<FocusScrollMeasurement | null>(null);
  useEffect(() => {
    let frame: number | null = null;
    let maxShellScrollTop = 0;
    const observe = () => {
      frame = null;
      const shell = document.querySelector<HTMLElement>('[data-workspace-shell="true"]');
      const trigger = shell?.querySelector<HTMLElement>(
        'button[aria-controls="fixture-navigation"]',
      );
      if (!shell || !trigger || shell.closest("[hidden]") || shell.getClientRects().length === 0)
        return;
      const rect = trigger.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth;
      const hit =
        visible &&
        trigger.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        );
      const toolbar = shell.querySelector<HTMLElement>("[data-composer-leading-actions]");
      const ancestors: FocusScrollMeasurement["ancestors"] = [];
      for (let element = trigger.parentElement; element; element = element.parentElement) {
        ancestors.push({
          element: element.hasAttribute("data-workspace-shell")
            ? "workspace-shell"
            : element.hasAttribute("data-desktop-window-frame")
              ? "window-frame"
              : element.tagName.toLowerCase(),
          scrollTop: element.scrollTop,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: getComputedStyle(element).overflowY,
        });
      }
      maxShellScrollTop = Math.max(maxShellScrollTop, Math.abs(shell.scrollTop));
      const active = document.activeElement;
      const activeRect = active?.getBoundingClientRect();
      const activeVisible = Boolean(
        activeRect &&
        activeRect.width > 0 &&
        activeRect.height > 0 &&
        activeRect.top >= 0 &&
        activeRect.left >= 0 &&
        activeRect.bottom <= window.innerHeight &&
        activeRect.right <= window.innerWidth,
      );
      const activeHit = Boolean(
        activeVisible &&
        activeRect &&
        active?.contains(
          document.elementFromPoint(
            activeRect.left + activeRect.width / 2,
            activeRect.top + activeRect.height / 2,
          ),
        ),
      );
      const drawer = active?.closest<HTMLElement>(
        '[data-workspace-panel-drawer="enabled"][role="dialog"]',
      );
      const drawerRect = drawer?.getBoundingClientRect();
      const scrollOwners: NonNullable<FocusScrollMeasurement["drawer"]>["scrollOwners"] = [];
      if (drawer) {
        for (
          let element = active?.parentElement;
          element && drawer.contains(element);
          element = element.parentElement
        ) {
          const overflowY = getComputedStyle(element).overflowY;
          if (overflowY === "auto" || overflowY === "scroll")
            scrollOwners.push({
              element: element.getAttribute("aria-label") ?? element.tagName.toLowerCase(),
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            });
          if (element === drawer) break;
        }
      }
      setMeasurement({
        active:
          active?.getAttribute("aria-label") ??
          active?.getAttribute("data-testid") ??
          active?.textContent?.trim().slice(0, 80) ??
          active?.tagName.toLowerCase() ??
          "none",
        activeRect: activeRect
          ? {
              top: activeRect.top,
              bottom: activeRect.bottom,
              visible: activeVisible,
              hit: activeHit,
            }
          : null,
        drawer:
          drawer && drawerRect
            ? { id: drawer.id, top: drawerRect.top, bottom: drawerRect.bottom, scrollOwners }
            : null,
        shellScrollTop: shell.scrollTop,
        maxShellScrollTop,
        windowScrollY: window.scrollY,
        navigation: { top: rect.top, bottom: rect.bottom, visible, hit },
        toolbar: toolbar
          ? {
              scrollLeft: toolbar.scrollLeft,
              clientWidth: toolbar.clientWidth,
              scrollWidth: toolbar.scrollWidth,
            }
          : null,
        ancestors,
      });
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(observe);
    };
    document.addEventListener("focusin", schedule);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    schedule();
    return () => {
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <output
      aria-hidden="true"
      data-testid="fixture-focus-scroll"
      data-measurements={measurement ? JSON.stringify(measurement) : undefined}
      className="pointer-events-none fixed right-1 top-12 z-[70] max-w-[calc(100%-0.5rem)] rounded-md bg-menu px-1 text-ui-xs text-foreground-subtle"
    >
      {measurement
        ? `shell Y=${measurement.shellScrollTop}; max=${measurement.maxShellScrollTop}; nav=${measurement.navigation.visible ? "visible" : "outside"}`
        : "Waiting for focus/scroll measurement"}
    </output>
  );
}
