import { useWorktreeBaseBranches } from "@/hooks/useWorktreeBaseBranches.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Button } from "@/components/ui/button.js";

export function WorktreeTargetSelect({
  workspacePath,
  workspaceIdentity,
  value,
  onChange,
  disabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const branches = useWorktreeBaseBranches(workspacePath, workspaceIdentity, true);
  const { intl } = useLCodeIntl();
  const names = [
    ...new Set([value, ...(branches.result?.branches.map((branch) => branch.name) ?? [])]),
  ];
  return (
    <div className="space-y-1 text-ui-sm">
      <span>{intl.formatMessage({ id: "worktree.targetBranch" })}</span>
      <Select
        value={value}
        onValueChange={onChange}
        disabled={disabled || branches.loading || Boolean(branches.error)}
      >
        <SelectTrigger
          data-testid="worktree-target-branch"
          aria-label={intl.formatMessage({ id: "worktree.targetBranch" })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {names.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.targetCheckoutHint" })}
      </p>
      {branches.error ? (
        <>
          <p role="alert" className="break-words text-destructive">
            {branches.error}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void branches.refresh()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </>
      ) : null}
    </div>
  );
}
