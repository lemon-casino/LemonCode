import type { Ref } from "react";
import type { GitLocalBranch } from "@lcode/shared";
import { GitBranchIcon } from "lucide-react";
import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBranchDeleteButton } from "./GitBranchDeletionDialog.js";

export function GitBranchPickerList({
  branches,
  currentBranchName,
  currentBranchDirtyLabel,
  loading,
  disabled,
  listRef,
  className,
  onSelect,
  onDelete,
}: {
  branches: GitLocalBranch[];
  currentBranchName: string | null;
  currentBranchDirtyLabel: string | null;
  loading: boolean;
  disabled: boolean;
  listRef: Ref<HTMLDivElement>;
  className?: string;
  onSelect: (name: string) => void;
  onDelete: (branch: GitLocalBranch) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <CommandList
      ref={listRef}
      data-testid="git-branch-list"
      className={cn("min-h-0 max-h-72", className)}
    >
      <CommandEmpty className="px-4 py-5 text-foreground-subtle">
        {intl.formatMessage({ id: loading ? "common.loading" : "git.branchSwitcher.empty" })}
      </CommandEmpty>
      <CommandGroup
        heading={intl.formatMessage({ id: "git.branchSwitcher.section.branches" })}
        className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
      >
        {branches.map((branch) => {
          const isCurrent = branch.name === currentBranchName;
          return (
            <CommandItem
              key={branch.name}
              value={branch.name}
              data-testid="git-branch-row"
              data-branch-name={branch.name}
              data-checked={isCurrent ? "true" : undefined}
              data-branch-current={isCurrent ? "true" : undefined}
              disabled={disabled}
              className="items-start gap-3 rounded-md px-3 py-2 text-ui-base"
              onSelect={() => onSelect(branch.name)}
            >
              <GitBranchIcon className="mt-0.5 size-4 text-foreground-subtle" />
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-left">
                {/* 分支名可能是无空格长 ref；完整换行，避免裁剪名称或挤掉右侧删除按钮。 */}
                <div
                  data-testid="git-branch-name"
                  className="whitespace-normal break-all text-ui-base font-medium text-foreground"
                >
                  {branch.name}
                </div>
                {isCurrent && currentBranchDirtyLabel ? (
                  <p className="pt-0.5 text-ui-base text-foreground-subtle">
                    {currentBranchDirtyLabel}
                  </p>
                ) : null}
              </div>
              <GitBranchDeleteButton branch={branch} disabled={disabled} onRequest={onDelete} />
            </CommandItem>
          );
        })}
      </CommandGroup>
    </CommandList>
  );
}
