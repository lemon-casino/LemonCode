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
      <p role="status">
        {intl.formatMessage(
          { id: `worktree.integration.${operation.status}` },
          { branch: operation.targetBranch },
        )}
      </p>
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
      {operation.conflictPaths.length ? (
        <p>
          {intl.formatMessage(
            { id: "worktree.conflictFileCount" },
            {
              count: operation.conflictPaths.length,
              shown: Math.min(20, operation.conflictPaths.length),
            },
          )}
        </p>
      ) : null}
      {operation.conflictPaths.length ? (
        <ul className="list-inside list-disc break-all font-mono">
          {operation.conflictPaths.slice(0, 20).map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      ) : null}
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

export function WorktreeSnapshotSummary({
  snapshot,
  onOpenFiles,
}: {
  snapshot?: WorktreeSnapshot;
  onOpenFiles?: () => void;
}) {
  const { intl } = useLCodeIntl();
  // 快照属于工作树而非会话归档；即使没有遗漏文件，也必须展示已保存的快照证据。
  if (!snapshot) return null;
  return (
    <div className="space-y-2 text-ui-sm" data-testid="worktree-snapshot-summary">
      <p>{intl.formatMessage({ id: "worktree.snapshotTitle" })}</p>
      <p className="break-all font-mono">{snapshot.commit}</p>
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.snapshotSavedAt" }, { time: snapshot.createdAt })}
      </p>
      {snapshot.ignoredPaths.length ? (
        <details data-testid="worktree-ignored-omissions">
          <summary className="cursor-pointer">
            {intl.formatMessage(
              { id: "worktree.ignoredOmissions" },
              { count: snapshot.ignoredPaths.length },
            )}
          </summary>
          <p>{intl.formatMessage({ id: "worktree.ignoredListDescription" })}</p>
          {onOpenFiles ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="worktree-open-omissions"
              onClick={onOpenFiles}
            >
              {intl.formatMessage({ id: "worktree.openOmissions" })}
            </Button>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
