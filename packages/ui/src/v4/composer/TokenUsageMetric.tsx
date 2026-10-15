import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";

export type UsageTone = "speed" | "context" | "session" | "cache" | "request" | "subagents";
export type UsageMetricOpenMode = "hover" | "pinned" | null;

export function DetailRow({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone: UsageTone;
}) {
  return (
    <div
      className="token-usage-detail-row token-usage-tone flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1"
      data-usage-tone={tone}
    >
      <span className="token-usage-detail-label inline-flex items-center gap-1.5">
        <i className="token-usage-detail-dot size-1.5 shrink-0 rounded-full" aria-hidden="true" />
        {label}
      </span>
      <span className="font-mono tabular-nums text-foreground">{children}</span>
    </div>
  );
}

export function UsageMetric({
  id,
  label,
  icon,
  value,
  children,
  openMode,
  onOpenModeChange,
}: {
  id: UsageTone;
  label: string;
  icon: ReactNode;
  value: ReactNode;
  children: ReactNode;
  openMode: UsageMetricOpenMode;
  onOpenModeChange: (mode: UsageMetricOpenMode) => void;
}) {
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnFocus = useRef(false);
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => () => cancelClose(), []);
  const enter = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    if (openMode === null) {
      returnFocus.current = false;
      onOpenModeChange("hover");
    }
  };
  const leave = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || openMode !== "hover") return;
    cancelClose();
    // 触发器和 Portal 之间有间隙；仅缓冲指针移出，进入任一区域立即取消关闭。
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onOpenModeChange(null);
    }, 120);
  };
  return (
    <Popover
      open={openMode !== null}
      onOpenChange={(open) => {
        cancelClose();
        if (open) returnFocus.current = true;
        onOpenModeChange(open ? "pinned" : null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="token-usage-metric token-usage-tone min-h-5 max-w-full gap-1 rounded-md px-1 text-ui-xs text-foreground-subtle"
          aria-label={label}
          data-testid={`token-usage-${id}`}
          data-usage-tone={id}
          // 只读指标不抢走 Lexical 的编辑选区；键盘仍可通过 Tab 聚焦并打开。
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onClick={(event) => {
            cancelClose();
            if (openMode === "hover") {
              // hover 已打开时默认 toggle 会关闭；首次点击应固定，触屏/键盘沿用 Popover。
              event.preventDefault();
              returnFocus.current = true;
              onOpenModeChange("pinned");
            }
          }}
        >
          <span className="token-usage-metric-icon inline-flex shrink-0" aria-hidden="true">
            {icon}
          </span>
          <span>{label}</span>
          <span className="min-w-0 font-mono tabular-nums text-foreground">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        className="token-usage-detail token-usage-tone gap-3 text-ui-sm [overflow-wrap:anywhere]"
        data-testid={`token-usage-detail-${id}`}
        data-usage-tone={id}
        // 明细没有可操作字段，自动聚焦内容会与 Lexical 的选区恢复竞争并关闭浮层。
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          // 纯悬停关闭不得把编辑焦点拉到指标按钮；点击/键盘打开仍保留焦点返回。
          if (!returnFocus.current) event.preventDefault();
        }}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <div className="token-usage-detail-heading flex items-center gap-2 border-b border-border pb-2 text-ui-sm font-medium text-foreground">
          <span
            className="token-usage-heading-icon inline-flex shrink-0 rounded-md p-1"
            aria-hidden="true"
          >
            {icon}
          </span>
          {label}
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}
