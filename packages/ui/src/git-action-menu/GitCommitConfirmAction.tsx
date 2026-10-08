import { GitCommitIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";
import { ReviewActionBar } from "./ReviewActionBar.js";

export function GitCommitConfirmAction({
  disabled,
  pending,
  label,
  onSubmit,
  secondary = false,
}: {
  disabled: boolean;
  pending: boolean;
  label: string;
  onSubmit: () => void;
  secondary?: boolean;
}) {
  return (
    <ReviewActionBar>
      <Button
        type="button"
        data-testid="git-commit-action-item-commit"
        disabled={disabled}
        variant={secondary ? "outline" : "default"}
        onClick={() => {
          if (!disabled) onSubmit();
        }}
        className="h-auto min-h-8 max-w-full gap-3 whitespace-normal rounded-lg text-left"
      >
        {pending ? (
          <LoaderIcon className="size-4 animate-spin" />
        ) : (
          <GitCommitIcon className="size-4" />
        )}
        <span className="min-w-0 flex-1">{label}</span>
        <span className="shrink-0 font-mono text-ui-xs opacity-70">
          {formatCommandShortcutLabel("Enter")}
        </span>
      </Button>
    </ReviewActionBar>
  );
}
