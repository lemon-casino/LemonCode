import { InfoIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function CodingPlanUsageNotice({
  message,
  onRefresh,
  refreshLabel,
}: {
  message: string;
  onRefresh?: () => void | Promise<void>;
  refreshLabel: string;
}) {
  return (
    <div
      data-coding-plan-usage-notice="true"
      className="col-span-full flex w-full min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 py-2 text-ui-base text-foreground-subtle"
    >
      <InfoIcon className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-foreground">{message}</span>
      {onRefresh ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={refreshLabel}
          className="text-foreground-subtle"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onRefresh();
          }}
        >
          <RefreshCwIcon className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
