import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="hover-card-content"]';
const FOCUSABLE_SELECTOR =
  'a[href], button, input, textarea, select, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';

function isVisibleInteractiveElement(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest('[inert], [hidden], [aria-hidden="true"]') ||
    element.matches(":disabled") ||
    element.getClientRects().length === 0 ||
    getComputedStyle(element).visibility === "hidden"
  )
    return false;
  return true;
}

function isNonEditingFocusTarget(element: HTMLElement | null): element is HTMLElement {
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).opacity === "0") return false;
  }
  return Boolean(
    element &&
    !element.matches('input:not([type="button"]), textarea, select, [contenteditable="true"]') &&
    isVisibleInteractiveElement(element),
  );
}

/**
 * 常驻展示壳：不建 portal、不换父树、不持有第二份 open 状态。
 * 背景由 Shell 的 inert 隔离；这里补齐 Tab、最顶层 Escape 和非编辑入口回焦。
 */
export function WorkspacePanelDrawer({
  id,
  enabled,
  open,
  label,
  closeLabel,
  onOpenChange,
  triggerRef,
  fallbackFocusRef,
  keepInactiveContentInteractive = false,
  children,
}: {
  id: string;
  enabled: boolean;
  open: boolean;
  label: string;
  closeLabel: string;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
  /** 桌面 browser-use 截图 surface 沿用既有交互/合成门禁，不受 Web 模态策略影响。 */
  keepInactiveContentInteractive?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !open || !panel || panel.closest("[inert]")) return;
    const document = panel.ownerDocument;
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // commit 已把背景设为 inert，此时先记住原触发器，等关闭时再验证它是否重新可交互。
    const returnTarget =
      activeElement &&
      activeElement !== document.body &&
      !activeElement.matches(
        'input:not([type="button"]), textarea, select, [contenteditable="true"]',
      )
        ? activeElement
        : triggerRef?.current;

    // Radix 菜单/Select/Popover 可 portal 到 body；不把它们误当背景，也不吞掉其第一次 Escape。
    const openOverlays = () =>
      Array.from(document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)).filter(
        (element) =>
          element !== panel &&
          isVisibleInteractiveElement(element) &&
          element.dataset.state !== "closed",
      );
    const focusCloseButton = () => closeRef.current?.focus({ preventScroll: true });
    let hasInteractedInside = false;
    const handlePointerDown = () => {
      hasInteractedInside = true;
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panel.contains(event.target)) {
        // 子级 Terminal/Search 的延后自动聚焦不能覆盖抽屉初始导航焦点；主动点击/Tab 后照常编辑。
        if (
          !hasInteractedInside &&
          event.target instanceof HTMLElement &&
          event.target.matches('input, textarea, select, [contenteditable="true"]')
        )
          focusCloseButton();
        return;
      }
      const target = event.target;
      if (openOverlays().some((overlay) => overlay.contains(target))) return;
      focusCloseButton();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || panel.closest("[inert]")) return;
      if (openOverlays().length > 0) return;
      if (event.key === "Escape") {
        // 在 document 捕获阶段消费抽屉 Escape，避免继续触发背后会话的停止生成/取消编辑。
        event.preventDefault();
        event.stopPropagation();
        onOpenChangeRef.current(false);
        return;
      }
      if (event.key !== "Tab") return;
      hasInteractedInside = true;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.tabIndex >= 0 && isVisibleInteractiveElement(element),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
      } else if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        // 首尾循环是用户键盘导航，目标可能在抽屉正文屏外；仅这里允许原生滚入。
        // 初始/关闭回焦仍 preventScroll，结构外壳由 clip 保持不滚动。
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    focusCloseButton();
    panel.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      panel.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown, true);
      // 等当前 commit 解除背景 inert 再回焦；切到设置页或另一抽屉时，失效目标不会抢焦点。
      queueMicrotask(() => {
        const target = [returnTarget, triggerRef?.current, fallbackFocusRef?.current].find(
          (candidate) => isNonEditingFocusTarget(candidate ?? null),
        );
        target?.focus({ preventScroll: true });
      });
    };
  }, [enabled, fallbackFocusRef, open, triggerRef]);

  return (
    <div
      ref={panelRef}
      id={id}
      role={enabled && open ? "dialog" : undefined}
      aria-modal={enabled && open ? true : undefined}
      aria-label={enabled ? label : undefined}
      aria-hidden={!open}
      inert={!open && !keepInactiveContentInteractive ? true : undefined}
      tabIndex={-1}
      data-workspace-panel-drawer={enabled ? "enabled" : "disabled"}
      className="relative flex h-full min-h-0 min-w-0 flex-col outline-none"
    >
      <div
        className={cn(
          "h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3",
          enabled ? "flex" : "hidden",
        )}
      >
        <span className="min-w-0 truncate text-ui-base font-medium">{label}</span>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={closeLabel}
          onClick={() => onOpenChange(false)}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
