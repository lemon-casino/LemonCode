import { FolderGit2Icon } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeBadge({ bindingId }: { bindingId?: string }) {
  const { intl } = useLCodeIntl();
  if (!bindingId) return null;
  const label = intl.formatMessage({ id: "worktree.mode.worktree" });
  return (
    <span
      className="shrink-0 text-foreground-subtle"
      title={label}
      aria-label={label}
      role="img"
      data-testid="task-worktree-badge"
    >
      <FolderGit2Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}
