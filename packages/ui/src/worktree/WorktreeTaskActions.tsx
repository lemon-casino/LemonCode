import { useState } from "react";
import { ArchiveIcon, GitMergeIcon, FolderGit2Icon, LoaderIcon } from "lucide-react";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeTask } from "@/hooks/useWorktreeTask.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { WorktreePublication } from "./WorktreePublication.js";
import { WorktreeTargetSelect } from "./WorktreeTargetSelect.js";
import {
  WorktreeIntegrationEvidence,
  WorktreeSnapshotSummary,
} from "./WorktreeIntegrationEvidence.js";

export function WorktreeTaskActions({
  workspacePath,
  workspaceIdentity,
  sessionId,
  busy,
  revision,
  onResolveConflicts,
  defaultOpen = false,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  busy: boolean;
  revision?: string;
  defaultOpen?: boolean;
  onResolveConflicts?: (operationId: string) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const { policy } = useProjectExecutionPolicy(workspacePath, workspaceIdentity);
  const task = useWorktreeTask(workspacePath, workspaceIdentity, sessionId, revision);
  const [open, setOpen] = useState(defaultOpen);
  const [commands, setCommands] = useState<string | null>(null);
  const [approvedHead, setApprovedHead] = useState<string | null>(null);
  const [skipValidation, setSkipValidation] = useState(false);
  const [acknowledgeIgnoredFiles, setAcknowledgeIgnoredFiles] = useState(false);
  const [target, setTarget] = useState<{ bindingId: string; branch: string } | null>(null);
  const { binding, operation, pending, worktreeService } = task;
  if (!binding || !worktreeService)
    return task.error ? (
      <p role="alert" className="text-ui-sm text-destructive">
        {task.error}
      </p>
    ) : null;
  const locked = busy || pending;
  const targetBranch =
    target?.bindingId === binding.id
      ? target.branch
      : (operation?.targetBranch ?? binding.targetBranch);
  const activeIntegration =
    operation &&
    !["published", "failed", "cancelled", "source-commit-failed"].includes(operation.status);
  const validationCommands = (commands ?? policy.validationCommands.join("\n"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const canPublish =
    (operation?.status === "ready" || operation?.status === "publishing") &&
    operation.candidateHead &&
    approvedHead === operation.candidateHead &&
    (operation.validationCommands.length > 0 || skipValidation);
  const integrate = () =>
    task.perform(async () => {
      const capability = await worktreeService.getCapabilities({
        workspacePath: binding.workspacePath,
        workspaceIdentity: binding.workspaceIdentity,
      });
      if (!capability.head)
        throw new Error(intl.formatMessage({ id: "worktree.sourceUnavailable" }));
      await worktreeService.integrate({
        requestId: crypto.randomUUID(),
        bindingId: binding.id,
        expectedSourceHead: capability.head,
        targetBranch,
        validationCommands,
      });
    });
  return (
    <>
      <div
        className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1 text-ui-sm"
        data-testid="worktree-task-location"
      >
        <FolderGit2Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={binding.workspacePath}>
          {binding.workspacePath}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(true);
            void task.refresh();
          }}
        >
          {intl.formatMessage({ id: "worktree.manage" })}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto"
          data-testid="worktree-task-dialog"
        >
          <DialogTitle>{intl.formatMessage({ id: "worktree.manage" })}</DialogTitle>
          <DialogDescription className="break-all font-mono text-ui-sm">
            {binding.branch} → {targetBranch}
            <br />
            {binding.workspacePath}
          </DialogDescription>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: `worktree.binding.${binding.status}` })}
          </p>
          {binding.status === "archived" ? (
            <Button
              type="button"
              disabled={locked}
              onClick={() =>
                void task.perform(() =>
                  worktreeService.restore({
                    bindingId: binding.id,
                    requestId: crypto.randomUUID(),
                  }),
                )
              }
            >
              {intl.formatMessage({ id: "worktree.restore" })}
            </Button>
          ) : (
            <>
              <WorktreeTargetSelect
                workspacePath={binding.originalWorkspacePath}
                workspaceIdentity={binding.originalWorkspaceIdentity}
                value={targetBranch}
                onChange={(branch) => {
                  setTarget({ bindingId: binding.id, branch });
                  setApprovedHead(null);
                }}
                disabled={locked || Boolean(activeIntegration)}
              />
              <label className="space-y-1 text-ui-sm">
                <span>{intl.formatMessage({ id: "worktree.validationCommands" })}</span>
                <Textarea
                  value={commands ?? policy.validationCommands.join("\n")}
                  onChange={(event) => setCommands(event.target.value)}
                  disabled={
                    locked ||
                    Boolean(
                      operation &&
                      operation.status !== "published" &&
                      operation.status !== "cancelled" &&
                      operation.status !== "failed",
                    )
                  }
                  className="font-mono text-ui-sm"
                  placeholder={intl.formatMessage({ id: "worktree.validationCommandsHint" })}
                />
              </label>
              <Button
                type="button"
                data-testid="worktree-integrate"
                variant="outline"
                disabled={locked || binding.status !== "ready" || Boolean(activeIntegration)}
                onClick={() => void integrate()}
              >
                <GitMergeIcon className="size-4" />
                {intl.formatMessage({ id: "worktree.integrate" })}
              </Button>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.integrateDescription" })}
              </p>
            </>
          )}
          {operation ? (
            <div
              className="min-w-0 space-y-3 rounded-lg border border-border p-3"
              data-testid="worktree-integration-status"
            >
              <p role="status" className="text-ui-sm">
                {intl.formatMessage({ id: `worktree.integration.${operation.status}` })}
              </p>
              <WorktreeIntegrationEvidence
                operation={operation}
                workspaceIdentity={binding.originalWorkspaceIdentity}
              />
              {operation.conflictPaths.length ? (
                <ul className="list-inside list-disc break-all font-mono text-ui-sm">
                  {operation.conflictPaths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              ) : null}
              {operation.status === "conflicted" ? (
                <>
                  <p className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "worktree.conflictInstructions" })}
                  </p>
                  {onResolveConflicts ? (
                    <Button
                      type="button"
                      disabled={pending}
                      onClick={() => void task.perform(() => onResolveConflicts(operation.id))}
                    >
                      {intl.formatMessage({ id: "worktree.resolveWithAI" })}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    disabled={locked}
                    variant="outline"
                    onClick={() =>
                      void task.perform(() =>
                        worktreeService.continueIntegration({ operationId: operation.id }),
                      )
                    }
                  >
                    {intl.formatMessage({ id: "worktree.continue" })}
                  </Button>
                </>
              ) : null}
              {operation.diff ? (
                <details>
                  <summary className="cursor-pointer text-ui-sm">
                    {intl.formatMessage({ id: "worktree.reviewDiff" })}
                  </summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
                    {operation.diff}
                  </pre>
                </details>
              ) : null}
              {operation.validationResults.map((result, index) => (
                <details key={index}>
                  <summary className="break-all font-mono text-ui-sm">
                    {result.command} — {result.exitCode}
                  </summary>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
                    {result.output}
                  </pre>
                </details>
              ))}
              {operation.candidateHead &&
              (operation.status === "awaiting-review" ||
                operation.status === "ready" ||
                operation.status === "validation-failed" ||
                operation.status === "publishing") ? (
                <>
                  <label className="flex items-start gap-2 text-ui-sm">
                    <Checkbox
                      data-testid="worktree-approve-candidate"
                      checked={approvedHead === operation.candidateHead}
                      onCheckedChange={(checked) =>
                        setApprovedHead(checked === true ? operation.candidateHead! : null)
                      }
                    />
                    <span>{intl.formatMessage({ id: "worktree.approveCandidate" })}</span>
                  </label>
                  {!operation.validationCommands.length ? (
                    <label className="flex items-start gap-2 text-ui-sm">
                      <Checkbox
                        checked={skipValidation}
                        onCheckedChange={(checked) => setSkipValidation(checked === true)}
                      />
                      <span>{intl.formatMessage({ id: "worktree.noValidation" })}</span>
                    </label>
                  ) : null}
                  {operation.status === "awaiting-review" ||
                  operation.status === "validation-failed" ? (
                    <Button
                      type="button"
                      data-testid="worktree-validate"
                      disabled={
                        locked ||
                        approvedHead !== operation.candidateHead ||
                        (!operation.validationCommands.length && !skipValidation)
                      }
                      onClick={() =>
                        void task.perform(() =>
                          worktreeService.continueIntegration({
                            operationId: operation.id,
                            approvedCandidateHead: operation.candidateHead,
                          }),
                        )
                      }
                    >
                      {intl.formatMessage({ id: "worktree.validate" })}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      data-testid="worktree-publish"
                      disabled={locked || !canPublish}
                      onClick={() =>
                        void task.perform(() =>
                          worktreeService.publishIntegration({
                            operationId: operation.id,
                            approvedCandidateHead: operation.candidateHead!,
                          }),
                        )
                      }
                    >
                      {intl.formatMessage({
                        id:
                          operation.status === "publishing"
                            ? "worktree.retryPublish"
                            : "worktree.publish",
                      })}
                    </Button>
                  )}
                </>
              ) : null}
              {operation.error ? (
                <p role="alert" className="break-words text-ui-sm text-destructive">
                  {operation.error}
                </p>
              ) : null}
              {!["publishing", "published", "cancelled"].includes(operation.status) ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  data-testid="worktree-cancel-integration"
                  onClick={() =>
                    void task.perform(() =>
                      worktreeService.continueIntegration({
                        operationId: operation.id,
                        cancel: true,
                      }),
                    )
                  }
                >
                  {intl.formatMessage({ id: "worktree.cancelIntegration" })}
                </Button>
              ) : null}
            </div>
          ) : null}
          {operation?.status === "published" ? (
            <WorktreePublication
              key={operation.id}
              operation={operation}
              workspaceIdentity={binding.originalWorkspaceIdentity}
              disabled={locked}
            />
          ) : null}
          <WorktreeSnapshotSummary snapshot={binding.snapshot} />
          {binding.status !== "archived" ? (
            <div className="space-y-2 border-t border-border pt-3">
              <label className="flex items-start gap-2 text-ui-sm">
                <Checkbox
                  checked={acknowledgeIgnoredFiles}
                  onCheckedChange={(checked) => setAcknowledgeIgnoredFiles(checked === true)}
                />
                <span>{intl.formatMessage({ id: "worktree.archiveIgnored" })}</span>
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void task.perform(() =>
                    worktreeService.archive({
                      bindingId: binding.id,
                      requestId: crypto.randomUUID(),
                      acknowledgeIgnoredFiles,
                    }),
                  )
                }
              >
                <ArchiveIcon className="size-4" />
                {intl.formatMessage({ id: "worktree.archive" })}
              </Button>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => void task.refresh()}
          >
            {intl.formatMessage({ id: "worktree.refresh" })}
          </Button>
          {pending ? (
            <span role="status" className="flex items-center gap-2 text-ui-sm">
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage({ id: "worktree.working" })}
            </span>
          ) : null}
          {task.error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {task.error}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
