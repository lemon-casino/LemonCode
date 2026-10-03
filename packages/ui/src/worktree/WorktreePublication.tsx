import { useState, type ReactNode } from "react";
import type { WorktreeIntegration } from "@lcode/services";
import { useWorktreePublication } from "@/hooks/useWorktreePublication.js";
import { GitPublishOptionsPanel } from "@/git-action-menu/GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "@/git-action-menu/GitPublishFeedback.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreePublication({
  operation,
  workspaceIdentity,
  disabled,
  renderReview,
}: {
  operation: WorktreeIntegration;
  workspaceIdentity?: string;
  disabled: boolean;
  renderReview?: (publication: ReactNode) => ReactNode;
}) {
  const publish = useWorktreePublication(operation, workspaceIdentity);
  const { intl } = useLCodeIntl();
  const [showPreview, setShowPreview] = useState(false);
  const content = (
    <section data-testid="worktree-remote-publication">
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
