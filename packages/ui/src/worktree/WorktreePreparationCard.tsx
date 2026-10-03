import { useEffect, useState } from "react";
import { useWorktreePreparation } from "@/hooks/useWorktreePreparation.js";
import type { WorktreeBinding } from "@lcode/services";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  LoaderIcon,
} from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function LiveWorktreePreparationCard({
  binding,
  onSettled,
}: {
  binding: WorktreeBinding;
  onSettled?: () => Promise<void>;
}) {
  const state = useWorktreePreparation(
    binding.originalWorkspacePath,
    binding.originalWorkspaceIdentity,
    binding.status === "preparing" ? binding.requestId : undefined,
  );
  useEffect(() => {
    if (binding.status === "preparing" && state.binding && state.binding.status !== "preparing")
      void onSettled?.();
  }, [binding.status, state.binding?.status, onSettled]);
  return <WorktreePreparationCard binding={state.binding ?? binding} error={state.error} />;
}

export function WorktreePreparationCard({
  binding,
  error,
  pending = false,
  onCancel,
  onLocal,
  onRetry,
  actionPending = false,
}: {
  binding: WorktreeBinding | null;
  error?: string;
  pending?: boolean;
  actionPending?: boolean;
  onCancel?: () => void;
  onLocal?: () => void;
  onRetry?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const text = (key: string) => intl.formatMessage({ id: `worktree.preparation.${key}` });
  const stage = binding?.preparation?.stage ?? "workspace";
  const ready = stage === "ready";
  const cancelled = binding?.status === "cancelled";
  const failed = binding?.status === "failed" || Boolean(error);
  const steps = ["workspace", "checkout", "environment"] as const;
  const current = steps.indexOf(
    (binding?.preparation?.activeStep ?? stage) as (typeof steps)[number],
  );
  const cancelling = binding?.preparation?.cancelRequested && !cancelled;
  const log = binding?.preparation?.log ?? "";
  return (
    <section
      className="basis-full min-w-0 w-full rounded-xl border border-border px-3 py-2 text-ui-sm"
      data-testid="worktree-preparation-card"
      aria-label={text("title")}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FolderGit2Icon className="size-4 shrink-0" />
        <span role="status">
          {text(cancelled ? "cancelled" : ready ? "ready" : failed ? "failed" : "title")}
        </span>
        <Button
          className="ml-auto h-7"
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
          {text("details")}
        </Button>
      </div>
      {!ready && !cancelled ? (
        <ol className="mt-2 space-y-1" aria-label={text("steps")}>
          {steps.map((step, index) => (
            <li
              key={step}
              className="flex items-center gap-2"
              data-step={step}
              data-state={index < current ? "done" : index === current ? "running" : "pending"}
            >
              {index < current ? (
                <CheckCircle2Icon className="size-4" />
              ) : index === current && !failed ? (
                <LoaderIcon className="size-4 animate-spin" />
              ) : (
                <span className="size-4 rounded-full border border-border" />
              )}
              {text(step)}
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-foreground-subtle">
          {text(cancelled ? "cancelledDescription" : "readyDescription")}
        </p>
      )}
      {binding?.preparation?.environmentSource === "none" && (ready || stage === "environment") ? (
        <p className="mt-1 text-foreground-subtle">{text("noEnvironment")}</p>
      ) : null}
      {expanded ? (
        <div className="mt-2 min-w-0 space-y-1">
          {binding ? <p className="break-all font-mono">{binding.checkoutPath}</p> : null}
          {binding?.preparation?.logTruncated ? <p>{text("truncated")}</p> : null}
          <pre
            className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background-alt p-2 font-mono text-ui-sm"
            data-testid="worktree-preparation-log"
          >
            {log || text("waiting")}
          </pre>
        </div>
      ) : null}
      {error || binding?.error ? (
        <p role="alert" className="mt-1 break-words text-destructive">
          {error ?? binding?.error}
        </p>
      ) : null}
      {cancelling ? (
        <p role="status" className="mt-1">
          {text("cancelling")}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap justify-end gap-1">
        {failed && onRetry && !cancelling ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={actionPending}
            onClick={onRetry}
          >
            {text("retry")}
          </Button>
        ) : null}
        {onLocal && !ready ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!binding || actionPending || Boolean(cancelling)}
            onClick={onLocal}
          >
            {text("local")}
          </Button>
        ) : null}
        {onCancel && pending && !ready && !cancelled ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!binding || actionPending || Boolean(cancelling)}
            onClick={onCancel}
          >
            {text("cancel")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
