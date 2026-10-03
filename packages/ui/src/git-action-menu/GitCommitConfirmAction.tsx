import { GitCommitIcon, LoaderIcon } from "lucide-react";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import { formatCommandShortcutLabel } from "@/lib/keyboardShortcuts.js";

export function GitCommitConfirmAction({
  disabled,
  pending,
  label,
  onSubmit,
}: {
  disabled: boolean;
  pending: boolean;
  label: string;
  onSubmit: () => void;
}) {
  return (
    <div className="border-t border-border px-2.5 py-2">
      <Command
        data-testid="git-commit-action-command"
        value="commit"
        shouldFilter={false}
        className="bg-transparent"
      >
        <CommandList className="max-h-none">
          <CommandItem
            value="commit"
            data-testid="git-commit-action-item-commit"
            disabled={disabled}
            onSelect={() => {
              if (!disabled) onSubmit();
            }}
            className="min-h-9"
          >
            {pending ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <GitCommitIcon className="size-4" />
            )}
            <span className="min-w-0 flex-1">{label}</span>
            <CommandShortcut>{formatCommandShortcutLabel("⏎")}</CommandShortcut>
          </CommandItem>
        </CommandList>
      </Command>
    </div>
  );
}
