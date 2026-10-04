import type { ComponentProps } from "react";
import { Command, CommandInput } from "@/components/ui/command.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { matchesGitBranchSearch } from "./display.js";
import { GitBranchPickerList } from "./GitBranchPickerList.js";

const branchFilter = (value: string, search: string) =>
  matchesGitBranchSearch(value, search) ? 1 : 0;

export function focusBranchPickerSearch(event: Event) {
  event.preventDefault();
  // 触控端避免自动唤起键盘遮挡列表；两种模式共用同一焦点规则。
  if (isCoarseTouchDevice()) return;
  if (event.currentTarget instanceof HTMLElement)
    event.currentTarget.querySelector<HTMLElement>('[data-slot="command-input"]')?.focus();
}

export function GitBranchPickerContent({
  description,
  ...props
}: ComponentProps<typeof GitBranchPickerList> & { description?: string }) {
  const { intl } = useLCodeIntl();
  return (
    <Command
      className="min-h-0 h-auto bg-transparent p-0 text-foreground [&>[data-slot=command-input-wrapper]]:shrink-0"
      filter={branchFilter}
    >
      <CommandInput
        placeholder={intl.formatMessage({ id: "git.branchSwitcher.searchPlaceholder" })}
        className="h-8"
      />
      {description ? (
        <p className="shrink-0 border-b border-border px-3 py-2 text-ui-sm text-foreground-subtle">
          {description}
        </p>
      ) : null}
      <GitBranchPickerList {...props} />
    </Command>
  );
}
