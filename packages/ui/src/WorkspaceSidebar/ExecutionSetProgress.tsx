import type { ExecutionSetRepositoryView } from "@lcode/shared";
import { useSidebarText } from "./sidebarText.js";
const labels = {
  preparing: "integration_preparing",
  "committing-source": "integration_committingSource",
  "source-commit-failed": "integration_sourceCommitFailed",
  conflicted: "integration_conflicted",
  "awaiting-review": "integration_awaitingReview",
  validating: "integration_validating",
  "validation-failed": "integration_validationFailed",
  ready: "integration_ready",
  publishing: "integration_publishing",
  published: "integration_published",
  "up-to-date": "integration_upToDate",
  cancelled: "integration_cancelled",
  failed: "integration_failed",
} as const;
export function ExecutionSetIntegrationStatus({ view }: { view: ExecutionSetRepositoryView }) {
  const text = useSidebarText();
  const receipt = view.integration;
  return (
    <span
      className="block truncate text-ui-xs text-foreground-subtle"
      title={receipt ? `${receipt.targetBranch} · ${receipt.updatedAt}` : undefined}
      data-testid="execution-set-integration-status"
    >
      {receipt
        ? `${text(labels[receipt.status])} · ${receipt.targetBranch}`
        : text("integrationPending")}
    </span>
  );
}
export function ExecutionSetProgress({
  views,
  total,
}: {
  views: ExecutionSetRepositoryView[];
  total: number;
}) {
  const text = useSidebarText();
  const completed = views.filter(
    (view) => view.integration && ["published", "up-to-date"].includes(view.integration.status),
  ).length;
  return (
    <p
      className="ml-7 py-1 text-ui-xs text-foreground-subtle"
      title={text("integrationReceiptHint")}
      data-testid="execution-set-progress"
    >
      {views.length !== total
        ? text("readingProgress")
        : `${text("integrationProgress")} ${completed}/${total}${completed > 0 && completed < total ? ` · ${text("partialIntegration")}` : ""}`}
    </p>
  );
}
