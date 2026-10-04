import type { Ref } from "react";
import type { GitLocalBranch } from "@lcode/shared";
import { CheckIcon, GitBranchIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBranchDeleteButton } from "./GitBranchDeletionDialog.js";

export function GitBranchPickerList({
  branches,
  currentBranchName,
  currentBranchDirtyLabel,
  selectedBranchName = currentBranchName,
  headOption = false,
  loading,
  error,
  onRetry,
  disabled,
  listRef,
  className,
  testId = "git-branch-list",
  onSelect,
  onDelete,
}: {
  branches: GitLocalBranch[];
  currentBranchName: string | null;
  currentBranchDirtyLabel: string | null;
  selectedBranchName?: string | null;
  headOption?: boolean;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  disabled: boolean;
  listRef: Ref<HTMLDivElement>;
  className?: string;
  testId?: string;
  onSelect: (name: string) => void;
  onDelete: (branch: GitLocalBranch) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <CommandList ref={listRef} data-testid={testId} className={cn("min-h-0 max-h-72", className)}>
      <CommandEmpty className="px-4 py-5 text-foreground-subtle">
        {error ? (
          <div role="alert" className="space-y-2 break-all text-destructive">
            <p>{error}</p>
            <Button variant="outline" onClick={onRetry}>
              {intl.formatMessage({ id: "worktree.retry" })}
            </Button>
          </div>
        ) : (
          intl.formatMessage({ id: loading ? "common.loading" : "git.branchSwitcher.empty" })
        )}
      </CommandEmpty>
      <CommandGroup
        heading={intl.formatMessage({ id: "git.branchSwitcher.section.branches" })}
        className="space-y-0.5 p-1 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle"
      >
        {headOption && !loading && !error ? (
          <CommandItem
            value="HEAD"
            data-testid="git-branch-row"
            data-branch-name="HEAD"
            data-checked={selectedBranchName === "HEAD" ? "true" : undefined}
            disabled={disabled}
            className="items-start gap-3 rounded-md px-3 py-2 text-ui-base [&>svg:last-child]:hidden"
            onSelect={() => onSelect("HEAD")}
          >
            <GitBranchIcon className="mt-0.5 size-4 text-foreground-subtle" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-left">
              <div className="font-medium">HEAD</div>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "git.branchPicker.headDescription" })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1 self-center">
              <CheckIcon
                className={cn(
                  "size-4 text-foreground-subtle",
                  selectedBranchName !== "HEAD" && "invisible",
                )}
              />
              <span className="size-6" aria-hidden />
            </div>
          </CommandItem>
        ) : null}
        {branches.map((branch) => {
          const isCurrent = branch.name === currentBranchName;
          const isSelected = branch.name === selectedBranchName;
          return (
            <CommandItem
              key={branch.name}
              value={branch.name}
              data-testid="git-branch-row"
              data-branch-name={branch.name}
              data-checked={isSelected ? "true" : undefined}
              data-branch-current={isCurrent ? "true" : undefined}
              disabled={disabled}
              className="items-start gap-3 rounded-md px-3 py-2 text-ui-base [&>svg:last-child]:hidden"
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
                {branch.checkedOutPath && !branch.isCurrent ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "git.branchDelete.occupiedLabel" })}
                  </p>
                ) : null}
              </div>
              {/* 选中标记保留相同宽度，避免当前分支和其他分支的右侧操作错位。 */}
              <div className="flex shrink-0 items-center gap-1 self-center">
                <CheckIcon
                  className={cn("size-4 text-foreground-subtle", !isSelected && "invisible")}
                />
                <GitBranchDeleteButton branch={branch} disabled={disabled} onRequest={onDelete} />
              </div>
            </CommandItem>
          );
        })}
      </CommandGroup>
    </CommandList>
  );
}
