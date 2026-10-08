import type { WorktreeIntegration } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ReviewDetails } from "@/git-action-menu/ReviewDetails.js";

export function WorktreeValidationResults({
  results,
  commands = [],
}: {
  results: WorktreeIntegration["validationResults"];
  commands?: string[];
}) {
  const { intl } = useLCodeIntl();
  const preparation = (command: string) =>
    /^(?:pnpm|npm|yarn|bun) (?:install|ci)(?:\s|$)/u.test(command);
  const checks = results.filter((result) => !preparation(result.command));
  const passed = checks.filter((result) => result.exitCode === 0).length;
  const failed = checks.length - passed;
  const prepared = results.filter(
    (result) => preparation(result.command) && result.exitCode === 0,
  ).length;
  const preparationFailures = results.filter(
    (result) => preparation(result.command) && result.exitCode !== 0,
  ).length;
  const pending = Math.max(
    0,
    commands.filter((command) => !preparation(command)).length - checks.length,
  );
  return (
    <>
      <p className="text-ui-sm" data-testid="worktree-check-summary">
        {intl.formatMessage({ id: "worktree.checks.summary" }, { passed, failed, pending })}
      </p>
      {prepared ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.checks.preparation" }, { count: prepared })}
        </p>
      ) : null}
      {preparationFailures ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage(
            { id: "worktree.checks.preparationFailed" },
            { count: preparationFailures },
          )}
        </p>
      ) : null}
      <ReviewDetails
        title={intl.formatMessage({ id: "worktree.details.validation" })}
        // 依赖准备失败也必须直接展开日志，不能只按后续检查的失败数量决定。
        defaultOpen={failed > 0 || preparationFailures > 0}
      >
        {commands.length ? (
          <pre
            data-testid="worktree-validation-plan"
            className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm"
          >
            {commands.join("\n")}
          </pre>
        ) : null}
        {results.map((result, index) => (
          <ReviewDetails
            key={index}
            title={`${result.command} · ${intl.formatMessage({ id: result.exitCode === 0 ? "worktree.checks.passed" : "worktree.checks.failed" })}`}
            defaultOpen={result.exitCode !== 0}
          >
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
              {result.output}
            </pre>
          </ReviewDetails>
        ))}
      </ReviewDetails>
    </>
  );
}
