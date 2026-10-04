import { useState, type ReactNode } from "react";
import type { WorktreeIntegration } from "@lcode/services";
import { GitFailureAction } from "@/git-action-menu/GitFailureAction.js";
import { publicationFailureContext } from "@/git-action-menu/gitFailureDraft.js";
import { useWorktreePublication } from "@/hooks/useWorktreePublication.js";
import { GitPublishOptionsPanel } from "@/git-action-menu/GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "@/git-action-menu/GitPublishFeedback.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreePublication({
  operation,
  workspaceIdentity,
  disabled,
  renderReview,
  originWorkspacePath,
  sessionId,
  onTransferred,
}: {
  operation: WorktreeIntegration;
  workspaceIdentity?: string;
  disabled: boolean;
  originWorkspacePath: string;
  sessionId: string;
  onTransferred?: () => void;
  renderReview?: (publication: ReactNode) => ReactNode;
}) {
  const publish = useWorktreePublication(
    { ...operation, repositoryPath: operation.repositoryPath ?? originWorkspacePath },
    workspaceIdentity,
  );
  const { intl } = useLCodeIntl();
  const [showPreview, setShowPreview] = useState(false);
  const content = (
    <section data-testid="worktree-remote-publication">
      {publish.error ||
      publish.run?.stopReason ||
      publish.run?.outcomes.some((step) => step.status === "failed") ? (
        <GitFailureAction
          workspacePath={originWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={sessionId}
          disabled={publish.pending || Boolean(publish.run?.running)}
          onTransferred={onTransferred}
          context={publicationFailureContext(
            {
              phase: "target-publication",
              workspacePath: operation.repositoryPath ?? operation.targetPath,
              sessionId,
              workspaceIdentity,
              targetPath: operation.targetPath,
              targetBranch: operation.targetBranch,
              sourceBranch: operation.targetBranch,
              operationId: operation.id,
              error: publish.error ?? "Publication stopped; inspect step outcomes",
              completedSteps: [`merged into ${operation.targetBranch}: ${operation.candidateHead}`],
            },
            publish.plan,
            publish.run,
            publish.options,
          )}
        />
      ) : null}
      {publish.run && !showPreview ? (
        <GitPublishResults
          run={publish.run}
          onRetry={(id) => void publish.retry(id)}
          onReset={() => {
            setShowPreview(false);
            publish.reset();
          }}
          onBack={() => setShowPreview(true)}
        />
      ) : publish.plan ? (
        <GitPublishPreview
          plan={publish.plan}
          disabled={disabled || publish.pending}
          onConfirm={() => void publish.confirm()}
          onCancel={publish.run ? () => setShowPreview(false) : publish.cancelPreview}
          readOnly={Boolean(publish.run)}
        />
      ) : (
        <GitPublishOptionsPanel
          expanded={publish.expanded}
          options={publish.options}
          branchName={operation.targetBranch}
          title={intl.formatMessage(
            { id: "worktree.publishBranch" },
            { branch: operation.targetBranch },
          )}
          previewLabel={intl.formatMessage(
            { id: "worktree.previewPublishBranch" },
            { branch: operation.targetBranch },
          )}
          contextDescription={intl.formatMessage({ id: "worktree.remotePublishHint" })}
          {...publish.catalog}
          loading={publish.pending}
          error={publish.error}
          disabled={disabled || publish.pending}
          canCommit={false}
          allowCommitPreview={false}
          remainingGroups={0}
          presets={publish.presets}
          presetName={publish.presetName}
          selectedPreset={publish.selectedPreset}
          onToggle={publish.toggle}
          onReload={() => void publish.reload()}
          onChange={publish.setOptions}
          onPreview={() => void publish.preview()}
          onPresetNameChange={publish.setPresetName}
          onPresetSelect={publish.setSelectedPreset}
          onPresetSave={publish.savePreset}
          onPresetApply={publish.applyPreset}
          onPresetDelete={publish.deletePreset}
        />
      )}
      {publish.error && (publish.plan || publish.run) ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {publish.error}
        </p>
      ) : null}
    </section>
  );
  return renderReview ? renderReview(content) : content;
}
