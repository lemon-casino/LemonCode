import { useEffect, useState } from "react";
import { executionSetSnapshotSchema, type ExecutionSetSnapshot } from "@lcode/shared";
import { Layers, LoaderCircle } from "lucide-react";
import { useServices } from "@/hooks/useServices.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { Button } from "@/components/ui/button.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import { SidebarSourceReadError } from "@/WorkspaceSidebar/SidebarSourceReadError.js";

export function DraftExecutionSetPreparation({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { projectExecutionSetService: service } = useServices();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const draft = useDraftExecutionStore((state) => state.drafts[scope]);
  const operationId = draft?.creationEnvelope?.commandId ?? draft?.requestId;
  const [snapshot, setSnapshot] = useState<ExecutionSetSnapshot>();
  const [error, setError] = useState("");
  const text = useSidebarText();
  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setError("");
    if (!service || !operationId) return;
    const accept = (value: ExecutionSetSnapshot) => {
      if (
        !active ||
        (value.origin.workspaceIdentity?.trim() || value.origin.workspacePath) !== scope ||
        (value.requestId !== operationId && value.id !== draft?.executionSetId)
      )
        return;
      setSnapshot((previous) =>
        previous && previous.revision > value.revision
          ? previous
          : executionSetSnapshotSchema.parse(value),
      );
    };
    const subscription = service.onDidChange(accept);
    void service.list({ workspacePath, workspaceIdentity }).then(
      (sets) => sets.forEach(accept),
      (failure) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [service, operationId, scope, workspacePath, workspaceIdentity, draft?.executionSetId]);
  return (
    <div
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
      data-testid="draft-execution-set-preparation"
    >
      <div className="flex items-center gap-2 text-ui-base font-medium">
        <Layers className="size-4" />
        {text("executionSet")}
        {draft?.requestId ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      </div>
      <p className="text-ui-sm text-foreground-subtle">{text("executionSetHeads")}</p>
      {snapshot ? (
        <>
          <p className="text-ui-sm">
            {snapshot.repositories.filter((repository) => repository.status === "ready").length}/
            {snapshot.repositories.length} · {text(`executionSetStatus_${snapshot.status}`)}
          </p>
          {snapshot.repositories.map((repository) => (
            <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={repository.id}>
              <span className="min-w-0 flex-1 truncate" title={repository.repositoryRoot}>
                {repository.repositoryRoot}
              </span>
              {repository.error ? (
                <SidebarSourceReadError
                  label={repository.repositoryRoot}
                  workspacePath={repository.repositoryRoot}
                  error={repository.error}
                />
              ) : null}
            </div>
          ))}
          {snapshot.preflightFailure ? (
            <div className="flex min-w-0 items-center gap-2 text-ui-sm">
              <span
                className="min-w-0 flex-1 truncate"
                title={snapshot.preflightFailure.sourcePath}
              >
                {snapshot.preflightFailure.sourcePath}
              </span>
              <SidebarSourceReadError
                label={snapshot.preflightFailure.sourcePath}
                workspacePath={snapshot.preflightFailure.sourcePath}
                error={snapshot.preflightFailure.error}
              />
            </div>
          ) : null}
        </>
      ) : null}
      {error || snapshot?.error || draft?.error ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {error || snapshot?.error || draft?.error}
        </p>
      ) : null}
      {draft?.error && !draft.requestId ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => useDraftExecutionStore.getState().retry(scope)}
        >
          {text("retryExecutionSet")}
        </Button>
      ) : null}
    </div>
  );
}
