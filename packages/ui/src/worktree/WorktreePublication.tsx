import { useState, type ReactNode } from "react";
import type { WorktreeIntegration } from "@lcode/services";
import { GitFailureAction } from "@/git-action-menu/GitFailureAction.js";
import { publicationFailureContext } from "@/git-action-menu/gitFailureDraft.js";
import { useWorktreePublication } from "@/hooks/useWorktreePublication.js";
import { GitPublishOptionsPanel } from "@/git-action-menu/GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "@/git-action-menu/GitPublishFeedback.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useReviewWorkspaceState } from "@/hooks/useReviewWorkspaceState.js";
import { WorktreeCompletionSummary } from "./WorktreeCompletionSummary.js";
import { Button } from "@/components/ui/button.js";

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
  const shared = useReviewWorkspaceState(originWorkspacePath, workspaceIdentity, sessionId);
  const view =
    shared.data.publicationView?.operationId === operation.id
      ? shared.data.publicationView.view
      : "result";
  const [skipped, setSkipped] = useState(false);
  const changeView = (next: "push" | "result") =>
    shared.patch({ publicationView: { operationId: operation.id, view: next } });
  const [showPreview, setShowPreview] = useState(false);
  const content = (
    <section data-testid="worktree-push-form">
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
  // 浏览切换仅替换可见内容；发布 hook 留在同一挂载控制器，不能重复执行或丢失在途结果。
  const workflow = (
    <section className="space-y-3" data-testid="worktree-remote-publication">
      <nav
        className="flex flex-wrap gap-1 border-b border-border pb-2"
        aria-label={intl.formatMessage({ id: "git.review.stages" })}
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            shared.patch({
              mergeView: { operationId: operation.id, source: true },
              worktreeView: { key: `${operation.id}/3`, stage: 0 },
            })
          }
        >
          {intl.formatMessage({ id: "worktree.flow.commitMerge" })}
        </Button>
        {(["push", "result"] as const).map((next) => (
          <Button
            key={next}
            type="button"
            variant={view === next ? "secondary" : "ghost"}
            className={view === next ? "border-b-2 border-primary" : ""}
            aria-current={view === next ? "page" : undefined}
            data-testid={`worktree-flow-${next}`}
            disabled={shared.status !== "ready"}
            onClick={() => changeView(next)}
          >
            {intl.formatMessage({ id: `worktree.flow.${next}` })}
          </Button>
        ))}
      </nav>
      {view === "result" ? (
        <>
          <WorktreeCompletionSummary
            operation={operation}
            run={publish.run}
            error={publish.error}
            skipped={skipped}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || shared.status !== "ready"}
            data-testid="git-publish-toggle"
            onClick={() => {
              changeView("push");
              if (!publish.expanded) publish.toggle();
            }}
          >
            {intl.formatMessage(
              { id: "worktree.publishBranch" },
              { branch: operation.targetBranch },
            )}
          </Button>
        </>
      ) : (
        <>
          {publish.plan && publish.plan.state.headCommitHash !== operation.candidateHead ? (
            <p className="text-ui-sm text-warning">
              {intl.formatMessage({ id: "worktree.result.newHead" })}
            </p>
          ) : null}
          {content}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              data-testid="worktree-skip-push"
              disabled={
                Boolean(publish.run?.running) || publish.pending || shared.status !== "ready"
              }
              onClick={() => {
                setSkipped(!publish.run);
                changeView("result");
              }}
            >
              {intl.formatMessage({
                id: publish.run ? "worktree.flow.result" : "worktree.flow.skipPush",
              })}
            </Button>
          </div>
        </>
      )}
    </section>
  );
  return renderReview ? renderReview(workflow) : workflow;
}
