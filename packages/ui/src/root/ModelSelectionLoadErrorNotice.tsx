import { RefreshCw } from "lucide-react";
import { isGitUnavailableError } from "@lcode/shared";
import { GitInstallationNotice } from "@/GitDependencyNotice.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ModelSelectionLoadErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry(): void;
}) {
  const { intl } = useLCodeIntl();
  // 同一依赖错误经 RPC 进入模型首读时也应提示安装 Git；不能掩盖真正的模型配置错误。
  if (isGitUnavailableError(error)) return <GitInstallationNotice onRetry={onRetry} />;
  return (
    <div
      role="alert"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg"
    >
      <span className="min-w-0 flex-1">
        {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {intl.formatMessage({ id: "common.retry" })}
      </Button>
    </div>
  );
}
