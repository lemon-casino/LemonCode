import type { WorktreeIntegration } from "@lcode/services";
import type { PublishRun } from "@/git-action-menu/publishExecution.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { integrationOutcome } from "./integrationOutcome.js";

export function WorktreeCompletionSummary({
  operation,
  run,
  error,
  skipped,
}: {
  operation: WorktreeIntegration;
  run: PublishRun | null;
  error: string | null;
  skipped: boolean;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `worktree.result.${key}` }, values);
  const outcome = integrationOutcome(operation);
  const hasRemoteSteps = run?.outcomes.some((row) => row.kind === "branch" || row.kind === "tag");
  return (
    <section
      className="space-y-3 rounded-xl border border-card-border bg-surface p-4"
      data-testid="worktree-completion-summary"
    >
      <h2 className="text-ui-base font-medium">{text("title")}</h2>
      <dl className="space-y-3 text-ui-base">
        <div>
          <dt className="text-foreground-subtle">{text("commit")}</dt>
          <dd>
            {operation.sourceReceipts?.length
              ? text("committed", { count: operation.sourceReceipts.length })
              : text("noCommit")}
          </dd>
        </div>
        <div>
          <dt className="text-foreground-subtle">{text("merge")}</dt>
          <dd className="break-words font-medium">
            {text(outcome, {
              branch: operation.targetBranch,
              count: operation.mergeResult?.changedFiles ?? 0,
            })}
          </dd>
          <dd className="mt-1 font-mono text-foreground-subtle" title={operation.candidateHead}>
            {operation.targetBranch} · {operation.candidateHead?.slice(0, 8)}
          </dd>
        </div>
        {operation.mergeResult?.uncommittedFileCount ? (
          <div className="text-warning">
            <dt className="sr-only">{text("merge")}</dt>
            <dd>{text("excluded", { count: operation.mergeResult.uncommittedFileCount })}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-foreground-subtle">{text("push")}</dt>
          <dd>
            {run
              ? run.running
                ? text("running")
                : run.stopReason || run.outcomes.some((item) => item.status !== "success")
                  ? text("partial")
                  : text(hasRemoteSteps ? "pushed" : "localTagOnly")
              : text(skipped ? "skipped" : "unverified")}
          </dd>
          {run ? (
            <dd>
              <ul className="mt-2 space-y-1">
                {run.outcomes.map((row) => (
                  <li key={row.id} className="flex min-w-0 flex-wrap justify-between gap-2">
                    <span className="min-w-0 break-all font-mono">
                      {row.remote ? `${row.remote} → ` : ""}
                      {row.target}
                    </span>
                    <span>{intl.formatMessage({ id: `git.publish.status.${row.status}` })}</span>
                  </li>
                ))}
              </ul>
            </dd>
          ) : null}
        </div>
      </dl>
      {error ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-ui-sm text-foreground-subtle">{text("historical")}</p>
    </section>
  );
}
