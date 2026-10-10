import type { GoalEvidenceSummary } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GoalEvidenceSummaryView({ summary }: { summary?: GoalEvidenceSummary }) {
  const { intl } = useLCodeIntl();
  if (!summary || summary.policy !== "strict") return null;
  const passed = summary.requirements.filter((item) => item.status === "passed").length;
  return (
    <div
      data-testid="goal-evidence-summary"
      data-evidence-outcome={summary.outcome}
      className="space-y-1 px-2 py-2 text-ui-sm text-foreground-subtle"
    >
      <p className="flex items-start justify-between gap-2">
        <span>{intl.formatMessage({ id: `chat.goalEvidence.outcome.${summary.outcome}` })}</span>
        <span className="shrink-0 tabular-nums">
          {passed}/{summary.requirements.length}
        </span>
      </p>
      <ul className="space-y-1">
        {summary.requirements.map((item) => (
          <li
            key={item.requirementId}
            data-evidence-status={item.status}
            className="flex min-w-0 justify-between gap-2"
          >
            <span className="min-w-0 break-words">{item.requirementId}</span>
            <span className="shrink-0">
              {intl.formatMessage({ id: `chat.goalEvidence.status.${item.status}` })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
