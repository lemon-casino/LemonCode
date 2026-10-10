import type { LCodeTaskMeta } from "@lcode/shared";
import { CornerDownLeftIcon } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useTaskHandoff } from "@/hooks/useTaskHandoff.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function TaskHandoffMenuItem({
  task,
  disabled,
  dropdown = false,
}: {
  task: LCodeTaskMeta;
  disabled?: boolean;
  dropdown?: boolean;
}) {
  const { intl } = useLCodeIntl();
  const handoff = useTaskHandoff(task);
  const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
  return (
    <>
      <Item
        data-testid="task-handoff"
        disabled={disabled || !handoff.available}
        title={
          !handoff.available
            ? intl.formatMessage({ id: "taskList.handoff.unavailable" })
            : undefined
        }
        onSelect={() =>
          handoff.insert(
            intl.formatMessage({ id: "taskList.handoff.draft" }, { session: `#${task.taskId}` }),
          )
        }
      >
        <CornerDownLeftIcon className="size-4" />
        {intl.formatMessage({ id: "taskList.handoff.title" })}
      </Item>
      <Item
        data-testid="task-handoff-save"
        disabled={disabled || !handoff.available}
        onSelect={() =>
          handoff.insert(
            intl.formatMessage(
              { id: "taskList.handoff.saveDraft" },
              { session: `#${task.taskId}` },
            ),
          )
        }
      >
        <CornerDownLeftIcon className="size-4" />
        {intl.formatMessage({ id: "taskList.handoff.saveTitle" })}
      </Item>
    </>
  );
}
