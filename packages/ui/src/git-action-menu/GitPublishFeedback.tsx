import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { PublishPlan } from "./publishModel.js";
import type { PublishRun } from "./publishExecution.js";

export function GitPublishPreview({
  plan,
  disabled,
  onConfirm,
  onCancel,
}: {
  plan: PublishPlan;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `git.publish.${key}` });
  const creates = plan.options.tagMode === "create" || plan.options.tagMode === "create-and-push";
  return (
    <section
      data-testid="git-publish-summary"
      className="min-w-0 space-y-3 border-t border-border px-4 py-3 text-ui-sm [overflow-wrap:anywhere]"
    >
      <h3 className="text-ui-base font-medium">{text("previewTitle")}</h3>
      <p className={plan.commit ? "text-foreground" : "text-warning"}>
        {plan.commit
          ? intl.formatMessage(
              { id: "git.publish.commitSummary" },
              { files: plan.files.length, groups: 1 },
            )
          : text("noCommit")}
      </p>
      {plan.commit ? (
        <>
          <ul className="max-h-32 overflow-y-auto font-mono">
            {plan.files.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="whitespace-pre-wrap font-mono">{plan.commit.message}</p>
        </>
      ) : null}
      <p>
        {text("sourceBranch")}:{" "}
        <span className="font-mono">
          {plan.state.branchName ?? intl.formatMessage({ id: "git.head.detached" })}
        </span>
      </p>
      <p>
        {text("targetCommit")}:{" "}
        <span className="font-mono">
          {plan.commit ? text("finalHead") : plan.state.headCommitHash}
        </span>
      </p>
      {plan.options.pushBranch ? (
        <div>
          <p className="font-medium">{text("remoteSteps")}</p>
          <ul>
            {plan.options.remotes.map((remote) => (
              <li key={remote.name} className="font-mono">
                {remote.name} → refs/heads/{remote.branch}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {creates ? (
        <p>
          {text("localTag")}: <span className="font-mono">{plan.options.tagName}</span> →{" "}
          {plan.commit ? text("finalHead") : plan.state.headCommitHash}
        </p>
      ) : null}
      {plan.options.tagMode === "create-and-push" ? (
        <ul>
          {plan.options.remotes.map((remote) => (
            <li key={remote.name} className="font-mono">
              {text("remoteTag")}: {remote.name} → refs/tags/{plan.options.tagName}
            </li>
          ))}
        </ul>
      ) : null}
      {plan.options.tagMode === "push-existing" ? (
        <ul>
          {plan.tags.flatMap((tag) =>
            plan.options.remotes.map((remote) => (
              <li key={`${remote.name}:${tag.name}`} className="font-mono">
                {text("remoteTag")}: {remote.name} → refs/tags/{tag.name} ({tag.commitHash})
              </li>
            )),
          )}
        </ul>
      ) : null}
      <p className="text-foreground-subtle">{text("frozen")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-testid="git-publish-back"
          onClick={onCancel}
        >
          {text("back")}
        </Button>
        <Button
          type="button"
          disabled={disabled}
          className="h-auto min-h-8 whitespace-normal"
          data-testid="git-publish-confirm"
          onClick={onConfirm}
        >
          {text("confirm")}
        </Button>
      </div>
    </section>
  );
}

export function GitPublishResults({
  run,
  onRetry,
  onReset,
}: {
  run: PublishRun;
  onRetry: (id: string) => void;
  onReset: () => void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `git.publish.${key}` });
  return (
    <section
      data-testid="git-publish-results"
      aria-busy={run.running}
      aria-live="polite"
      className="min-w-0 space-y-3 border-t border-border px-4 py-3 text-ui-sm [overflow-wrap:anywhere]"
    >
      <h3 className="text-ui-base font-medium">{text("results")}</h3>
      {run.stopReason ? (
        <p role="alert" className="text-warning">
          {text(`stop.${run.stopReason}`)}
        </p>
      ) : null}
      <ul className="space-y-2">
        {run.outcomes.map((row) => (
          <li
            key={row.id}
            data-testid={`git-publish-result-${row.id}`}
            data-status={row.status}
            className="min-w-0 space-y-1 rounded-xl border border-border p-2"
          >
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 font-medium">
                {text(`step.${row.kind}`)} {row.remote ? `${row.remote} → ` : ""}
                <span className="font-mono">{row.target}</span>
              </span>
              <span
                className={
                  row.status === "failed"
                    ? "text-destructive"
                    : row.status === "success"
                      ? "text-success"
                      : "text-foreground-subtle"
                }
              >
                {text(`status.${row.status}`)}
              </span>
            </div>
            {row.kind === "create-tag" &&
            row.status === "success" &&
            row.tagCreated !== undefined ? (
              <p>{text(row.tagCreated ? "tagCreated" : "tagAlreadyExists")}</p>
            ) : null}
            {row.commitHash ? (
              <p className="font-mono text-foreground-subtle">{row.commitHash}</p>
            ) : null}
            {row.message ? <p className="whitespace-pre-wrap break-words">{row.message}</p> : null}
            {row.status === "failed" && (row.kind === "branch" || row.kind === "tag") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={run.running || Boolean(run.stopReason)}
                data-testid={`git-publish-retry-${row.id}`}
                onClick={() => onRetry(row.id)}
              >
                {text("retry")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        disabled={run.running}
        data-testid="git-publish-new-plan"
        onClick={onReset}
      >
        {text("newPlan")}
      </Button>
    </section>
  );
}
