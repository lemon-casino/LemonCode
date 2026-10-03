import { useState } from "react";
import type { WorktreeIntegration, WorktreeSnapshot } from "@lcode/services";
import { parseRemoteWorkspaceIdentity } from "@lcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

export function WorktreeIntegrationEvidence({
  operation,
  workspaceIdentity,
}: {
  operation: WorktreeIntegration;
  workspaceIdentity?: string;
}) {
  const { intl } = useLCodeIntl();
  const platform = useOptionalPlatform();
  const [error, setError] = useState<string | null>(null);
  const values: readonly (readonly [string, string | undefined])[] = [
    ["worktree.sourceCommit", operation.sourceHead],
    ["worktree.targetBaseline", `${operation.targetBranch} · ${operation.targetHead}`],
    ["worktree.mergeBase", operation.mergeBase],
    ["worktree.integrationDirectory", operation.checkoutPath],
  ];
  return (
    <div className="space-y-2 text-ui-sm" data-testid="worktree-integration-evidence">
      {operation.sourceReceipts?.length ? (
        <div className="space-y-1" data-testid="worktree-source-receipts">
          <p>
            {intl.formatMessage(
              { id: "worktree.sourceReceiptCount" },
              { count: operation.sourceReceipts.length },
            )}
          </p>
          {operation.sourceReceipts.map((receipt) => (
            <div key={`${receipt.reviewId}:${receipt.groupId}`}>
              <p className="break-all font-mono">{receipt.commitHash}</p>
              {receipt.warning ? (
                <p role="alert" className="break-words text-destructive">
                  {receipt.warning}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <dl className="space-y-2">
        {values.map(([label, value]) =>
          value ? (
            <div key={label}>
              <dt className="text-foreground-subtle">{intl.formatMessage({ id: label })}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {platform && (!workspaceIdentity || !parseRemoteWorkspaceIdentity(workspaceIdentity)) ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="worktree-open-integration"
          onClick={() => {
            setError(null);
            void platform
              .openInFileManager(operation.checkoutPath)
              .then((result) => {
                if (!result.success)
                  setError(
                    result.error || intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }),
                  );
              })
              .catch((error) => setError(error instanceof Error ? error.message : String(error)));
          }}
        >
          {intl.formatMessage({ id: "appHeader.openInFileManager" })}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function WorktreeSnapshotSummary({ snapshot }: { snapshot?: WorktreeSnapshot }) {
  const { intl } = useLCodeIntl();
  if (!snapshot?.ignoredPaths.length) return null;
  return (
    <details className="text-ui-sm" data-testid="worktree-ignored-omissions">
      <summary className="cursor-pointer">
        {intl.formatMessage(
          { id: "worktree.ignoredOmissions" },
          { count: snapshot.ignoredPaths.length },
        )}
      </summary>
      <ul className="list-inside list-disc break-all font-mono">
        {snapshot.ignoredPaths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </details>
  );
}
