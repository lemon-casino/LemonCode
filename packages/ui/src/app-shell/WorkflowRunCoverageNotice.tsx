import { InfoIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 运行投影被有界窗口截断时，阶段分数只代表仍在窗口内的记录。 */
export function WorkflowRunCoverageNotice() {
  const { intl } = useZCodeIntl();
  return (
    <p
      className="flex items-center gap-1.5 px-3 pb-2 text-ui-xs text-foreground-subtle"
      data-testid="workflow-run-partial-status"
    >
      <InfoIcon aria-hidden className="size-3.5 shrink-0" />
      {intl.formatMessage({ id: "chat.toolCall.workflow.run.partialStatus" })}
    </p>
  );
}
