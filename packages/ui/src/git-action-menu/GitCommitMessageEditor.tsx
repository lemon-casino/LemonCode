import { useEffect, useRef } from "react";
import { CopyIcon, LoaderIcon, SparklesIcon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { commitSubjectLength, insertConventionalType } from "./commitDraft.js";

export function GitCommitMessageEditor({
  message,
  previousMessage,
  disabled,
  generationPending,
  canGenerate,
  onMessageChange,
  onGenerate,
  onCopy,
  onRestore,
}: {
  message: string;
  previousMessage: string | null;
  disabled: boolean;
  generationPending: boolean;
  canGenerate: boolean;
  onMessageChange: (message: string) => void;
  onGenerate: () => void;
  onCopy: () => void;
  onRestore: () => void;
}) {
  const { intl } = useLCodeIntl();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  const length = commitSubjectLength(message);
  const generateLabel = intl.formatMessage({
    id: message.trim()
      ? "git.actionMenu.commitDialog.regenerate"
      : "git.actionMenu.commitDialog.generate",
  });
  return (
    <div className="min-w-0 space-y-2 px-4 pb-3">
      <label htmlFor="git-action-menu-commit-message" className="sr-only">
        {intl.formatMessage({ id: "git.actionMenu.commitDialog.messageLabel" })}
      </label>
      <div className="relative">
        <Textarea
          ref={textareaRef}
          id="git-action-menu-commit-message"
          data-testid="git-commit-message-input"
          value={message}
          disabled={disabled}
          placeholder={intl.formatMessage({ id: "git.actionMenu.commitDialog.messagePlaceholder" })}
          className="field-sizing-fixed min-h-28 w-full rounded-lg border-input-border bg-input pr-10 text-mobile-input-safe md:text-ui-base"
          onChange={(event) => onMessageChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-1 text-foreground-subtle"
          data-testid="git-commit-generate-button"
          aria-label={generateLabel}
          title={generateLabel}
          disabled={disabled || !canGenerate}
          onClick={onGenerate}
        >
          {generationPending ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : (
            <SparklesIcon className="size-4" />
          )}
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span
          data-testid="git-message-subject-length"
          className={length > 72 ? "text-ui-sm text-warning" : "text-ui-sm text-foreground-subtle"}
        >
          {intl.formatMessage({ id: "git.message.subjectLength" }, { count: length, limit: 72 })}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            data-testid="git-message-copy"
            variant="ghost"
            size="sm"
            disabled={!message}
            onClick={onCopy}
          >
            <CopyIcon className="size-3.5" />
            {intl.formatMessage({ id: "git.message.copy" })}
          </Button>
          <Button
            type="button"
            data-testid="git-message-restore"
            variant="ghost"
            size="sm"
            disabled={disabled || previousMessage === null}
            onClick={onRestore}
          >
            <Undo2Icon className="size-3.5" />
            {intl.formatMessage({ id: "git.message.restore" })}
          </Button>
        </div>
      </div>
      <div
        className="flex flex-wrap gap-1"
        aria-label={intl.formatMessage({ id: "git.message.types" })}
      >
        {["feat", "fix", "docs", "refactor", "test", "chore"].map((type) => (
          <Button
            key={type}
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            data-testid={`git-message-type-${type}`}
            disabled={disabled}
            onClick={() => onMessageChange(insertConventionalType(message, type))}
          >
            {type}
          </Button>
        ))}
      </div>
    </div>
  );
}
