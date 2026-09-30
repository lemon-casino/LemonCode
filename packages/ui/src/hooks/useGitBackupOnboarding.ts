import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitBackupWorkspaceTarget, IGitBackupService } from "@lcode/services";
import {
  clearLegacyGitBackupOnboarding,
  getGitBackupLegacyStorage,
  hasLegacyGitBackupOnboarding,
  type GitBackupLegacyStorage,
} from "./gitBackupLegacyConfig.js";

export async function loadGitBackupOnboarding(
  service: IGitBackupService,
  storage: GitBackupLegacyStorage | null,
): Promise<{ complete: boolean }> {
  const complete = await service.hasCompletedOnboarding();
  if (!complete && hasLegacyGitBackupOnboarding(storage)) {
    // 旧标记只迁移“已看过引导”；配置草稿和凭据留给设置页显式确认，不能开启上传。
    await completeGitBackupOnboarding(service, storage);
    return { complete: true };
  }
  return { complete };
}

export async function completeGitBackupOnboarding(
  service: IGitBackupService,
  storage: GitBackupLegacyStorage | null,
): Promise<void> {
  // 欢迎入口仅记录引导完成；配置、目的地开关和工作区注册全部由设置页负责。
  await service.markOnboardingComplete();
  clearLegacyGitBackupOnboarding(storage);
}

export function useGitBackupOnboarding(
  service: IGitBackupService,
  workspace: GitBackupWorkspaceTarget,
  allowLegacyMigration: boolean,
  onOpenSettings?: () => void,
) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storage = allowLegacyMigration ? getGitBackupLegacyStorage() : null;
  const scope = useMemo(
    () => ({ active: false, generation: 0, admitted: false, completed: false }),
    [service, storage, workspace.workspacePath, workspace.workspaceIdentity],
  );
  const currentScope = useRef(scope);
  const openSettings = useRef(onOpenSettings);
  currentScope.current = scope;
  openSettings.current = onOpenSettings;
  const isCurrent = useCallback(
    (version: number) =>
      scope.active && currentScope.current === scope && scope.generation === version,
    [scope],
  );

  const reload = useCallback(async () => {
    if (!scope.active || currentScope.current !== scope) return;
    const version = ++scope.generation;
    scope.admitted = false;
    setLoading(true);
    setReady(false);
    setBusy(false);
    setError(null);
    try {
      const result = await loadGitBackupOnboarding(service, storage);
      if (!isCurrent(version)) return;
      scope.completed = result.complete;
      setReady(true);
      setOpen(!result.complete);
    } catch (cause) {
      if (!isCurrent(version)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setOpen(true);
    } finally {
      if (isCurrent(version)) setLoading(false);
    }
  }, [isCurrent, scope, service, storage]);

  useEffect(() => {
    scope.active = true;
    void reload();
    return () => {
      scope.active = false;
      scope.generation += 1;
    };
  }, [reload, scope]);

  const complete = useCallback(
    async (action: "settings" | "skip") => {
      if (
        !scope.active ||
        currentScope.current !== scope ||
        scope.admitted ||
        scope.completed ||
        loading ||
        (action === "settings" && !ready)
      )
        return;
      const version = scope.generation;
      scope.admitted = true;
      setBusy(true);
      setError(null);
      try {
        await completeGitBackupOnboarding(service, storage);
      } catch (cause) {
        if (isCurrent(version)) setError(cause instanceof Error ? cause.message : String(cause));
        return;
      } finally {
        if (isCurrent(version)) {
          scope.admitted = false;
          setBusy(false);
        }
      }
      // active 布尔值不能识别同组件切换工作区/Host 后的晚到结果；同时校验作用域和请求代次。
      if (!isCurrent(version)) return;
      scope.completed = true;
      setOpen(false);
      if (action === "settings") openSettings.current?.();
    },
    [isCurrent, loading, ready, scope, service, storage],
  );

  return { open, ready, loading, busy, error, complete, reload };
}
