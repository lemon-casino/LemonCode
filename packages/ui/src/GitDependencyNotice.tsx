import { AlertTriangle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";

export function GitInstallationNotice({
  onRetry,
  inline = false,
}: {
  onRetry?: () => void;
  inline?: boolean;
}) {
  const { intl } = useLCodeIntl();
  return (
    <Alert
      variant="warning"
      className={
        inline
          ? "mx-4 my-2 w-auto shrink-0"
          : "fixed right-4 bottom-4 z-50 w-auto max-w-sm shadow-lg max-md:left-4 max-md:max-w-none"
      }
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{intl.formatMessage({ id: "git.dependency.missingTitle" })}</AlertTitle>
      <AlertDescription>
        {intl.formatMessage({ id: "git.dependency.installDescription" })}
        {onRetry ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function WorkspaceGitDependencyNotice({
  state,
  workspacePath,
  workspaceIdentity,
}: {
  state: Pick<
    GitPaneRepositoryState,
    "workspaceKey" | "summary" | "revision" | "loading" | "error"
  >;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  // 初始化/错误/旧目标的 false 不是 Host 缺少 Git 的事实；仅消费既有成功快照。
  if (
    !workspacePath ||
    state.loading ||
    state.error !== null ||
    state.revision === 0 ||
    state.workspaceKey !== (workspaceIdentity?.trim() || workspacePath) ||
    state.summary.workspacePath !== workspacePath ||
    state.summary.isGitAvailable
  )
    return null;
  return <GitInstallationNotice inline />;
}
