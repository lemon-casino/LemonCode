import { useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useSidebarText } from "./sidebarText.js";
import "./sidebarSourceReadError.css";

/** 读取错误属于具体来源；悬停、键盘与触控共用同一原因，不能提升成整个侧栏故障。 */
export function SidebarSourceReadError({
  label,
  workspacePath,
  error,
  refreshing,
  onRefresh,
}: {
  label: string;
  workspacePath: string;
  error: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const text = useSidebarText();
  const [open, setOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const details = (
    <div className="flex min-w-0 flex-col gap-1 text-ui-sm">
      <span className="font-medium">
        {label} · {text("readFailed")}
      </span>
      <span className="break-all opacity-75">{workspacePath}</span>
      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{error}</p>
    </div>
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setHintOpen(false);
      }}
    >
      <Tooltip open={!open && hintOpen} onOpenChange={setHintOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 text-warning hover:text-warning"
              aria-label={`${text("readFailed")} · ${label}`}
              data-testid="sidebar-source-error"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <CircleAlert className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* 提示退场曾覆盖 pointerup，使 click 落到 body；只读提示不接收指针，操作统一在点击后的浮层。 */}
        <TooltipContent
          data-sidebar-source-hint
          side="right"
          className="pointer-events-none max-w-[min(22rem,calc(100vw-1rem))] p-3 data-[state=closed]:hidden"
        >
          {details}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        data-sidebar-source-panel
        align="end"
        className="w-72 max-w-[calc(100vw-1rem)] space-y-3 p-3 data-[state=closed]:hidden data-[state=closed]:pointer-events-none"
        onClick={(event) => event.stopPropagation()}
      >
        {details}
        {onRefresh ? (
          <div className="border-t border-border pt-2">
            <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
              <RefreshCw
                className={`size-3.5 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
              {text("reread")}
            </Button>
            <p className="mt-1 text-ui-xs text-foreground-subtle">{text("rereadHint")}</p>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
