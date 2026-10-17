import { useCallback, useEffect, useRef, useState } from "react";
import { executionSetRepositoryViewsSchema, type ExecutionSetRepositoryView } from "@lcode/shared";
import type {
  SidebarExecutionSetEntry,
  SidebarExecutionSetsResult,
} from "./useSidebarExecutionSets.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { scopeKey } from "@/WorkspaceSidebar/sidebarReferences.js";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";

/** 只持有展开视图和在途命令；资源状态唯一来源是目标 Host 的工作集 owner。 */
export function useExecutionSetDetails(
  entry: SidebarExecutionSetEntry,
  sets: SidebarExecutionSetsResult,
  expanded: boolean,
) {
  const { snapshot, origin } = entry;
  const lifecycleRevision = useWorktreeLifecycleStore((state) =>
    [
      scopeKey(origin),
      ...snapshot.repositories.map((repository) =>
        origin.workspaceIdentity
          ? (replaceRemoteWorkspaceIdentityPath(
              origin.workspaceIdentity,
              repository.repositoryRoot,
            ) ?? repository.repositoryRoot)
          : repository.repositoryRoot,
      ),
    ].reduce((sum, key) => sum + (state.revisions[key] ?? 0), 0),
  );
  const service = sets.lookup.get(scopeKey(origin))?.services.projectExecutionSetService;
  const available = Boolean(service && sets.supported.includes(scopeKey(origin)));
  const [views, setViews] = useState<ExecutionSetRepositoryView[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const admission = useRef(false);
  const operations = useRef(new Map<string, string>());
  const request = {
    workspacePath: origin.workspacePath,
    workspaceIdentity: origin.workspaceIdentity,
    executionSetId: snapshot.id,
  };
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    if (!service || !available) return;
    try {
      const next = executionSetRepositoryViewsSchema.parse(
        await service.bindings({
          workspacePath: origin.workspacePath,
          workspaceIdentity: origin.workspaceIdentity,
          executionSetId: snapshot.id,
        }),
      );
      if (token === generation.current) {
        setViews(next);
        setError("");
      }
    } catch (failure) {
      if (token === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [service, available, origin.workspacePath, origin.workspaceIdentity, snapshot.id]);
  useEffect(() => {
    if (expanded) void refresh();
    return () => {
      generation.current++;
    };
  }, [expanded, refresh, snapshot.revision, lifecycleRevision]);
  const run = async (
    kind: "retry" | "archive" | "restore" | "rename",
    name?: string,
    acknowledgeIgnoredFiles?: boolean,
  ) => {
    if (!service || !available || admission.current) return false;
    admission.current = true;
    setPending(true);
    setError("");
    const key =
      kind === "rename" ? `${kind}:${snapshot.revision}:${name}` : `${kind}:${snapshot.id}`;
    const operationId =
      kind === "retry"
        ? snapshot.requestId
        : kind === "archive" && snapshot.archiveOperationId
          ? snapshot.archiveOperationId
          : kind === "restore" && snapshot.restoreOperationId
            ? snapshot.restoreOperationId
            : (operations.current.get(key) ?? crypto.randomUUID());
    operations.current.set(key, operationId);
    try {
      if (kind === "rename")
        await service.rename({
          ...request,
          operationId,
          name: name!,
          expectedRevision: snapshot.revision,
        });
      else if (kind === "archive")
        await service.archive({ ...request, operationId, acknowledgeIgnoredFiles });
      else await service[kind]({ ...request, operationId });
      operations.current.delete(key);
      useWorktreeLifecycleStore
        .getState()
        .invalidate(origin.workspacePath, origin.workspaceIdentity);
      await sets.refresh(scopeKey(origin));
      return true;
    } catch (failure) {
      // 中文依据：失败可能发生在副作用后；保留原 operationId，重试必须先对账原工作集。
      await sets.refresh(scopeKey(origin));
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      admission.current = false;
      setPending(false);
    }
  };
  return { views, error, pending, available, refresh, run };
}
