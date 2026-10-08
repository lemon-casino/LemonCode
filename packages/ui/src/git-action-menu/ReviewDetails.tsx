import type { ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";

export function ReviewDetails({
  title,
  children,
  defaultOpen = false,
  testId,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  return (
    <details
      open={defaultOpen || undefined}
      className="group/details min-w-0 text-ui-sm"
      data-testid={testId}
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-2 text-foreground-subtle hover:bg-hover [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/details:rotate-90" />
        <span className="min-w-0 break-words">{title}</span>
      </summary>
      <div className="min-w-0 space-y-2 px-2 pb-2 pt-1">{children}</div>
    </details>
  );
}
