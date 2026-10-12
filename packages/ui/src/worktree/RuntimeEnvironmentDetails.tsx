import type { WorktreeBinding } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { GitFailureAction } from "@/git-action-menu/GitFailureAction.js";
import { environmentActionAvailable } from "@/hooks/runtimeEnvironmentModel.js";
import { useRuntimeEnvironment } from "@/hooks/useRuntimeEnvironment.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { RuntimeEnvironmentServices } from "./RuntimeEnvironmentServices.js";
import { WorktreeDetailsTable, WorktreeDetailsRow } from "./WorktreeDetailsTable.js";
import { ReviewDetails } from "@/git-action-menu/ReviewDetails.js";

export function RuntimeEnvironmentDetails({
  binding,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  sessionId,
  disabled,
  onTransferred,
  onSettled,
}: {
  binding: WorktreeBinding;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId?: string;
  disabled?: boolean;
  onTransferred?: () => void;
  onSettled?: () => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const numberFormat = new Intl.NumberFormat(locale);
  const text = (key: string) => intl.formatMessage({ id: `runtimeEnvironment.${key}` });
  const runtime = useRuntimeEnvironment({
    // 子目录工作树的公开身份属于执行目录；checkout 根目录只能由 Host 授权后映射。
    workspacePath: binding.workspacePath,
    workspaceIdentity: binding.workspaceIdentity ?? workspaceIdentity,
    routingWorkspacePath: workspacePath,
    workspaceRemoteSessionId,
    bindingId: binding.id,
    binding,
    environmentId: binding.environmentRef?.environmentId,
  });
  const environment = runtime.environment;
  const error = runtime.diagnostic ?? runtime.operation?.error ?? environment?.error;
  const failure = runtime.error ?? binding.error;
  const busy = Boolean(disabled || runtime.pending || runtime.loading);
  const canPrepare = environmentActionAvailable(runtime.capabilities, "prepare");
  const canScan = environmentActionAvailable(runtime.capabilities, "resourceSummary");
  const summary = environment?.resourceSummary;
  const upgrade = () => void runtime.prepare("upgrade").then(() => onSettled?.());
  const explanation =
    runtime.error === "remote-waiting"
      ? text("remoteWaiting")
      : (runtime.capabilities?.missingReason ??
        // 能力未知可能是读取失败，不能据此宣称目标 Host 不支持托管环境。
        (runtime.capabilities && !canPrepare ? text("capabilityUnavailable") : undefined));
  return (
    <section
      className="min-w-0 space-y-3"
      data-testid="runtime-environment-details"
      aria-label={text("title")}
    >
      <h3 className="text-ui-base font-medium">{text("title")}</h3>
      <WorktreeDetailsTable label={text("title")}>
        <WorktreeDetailsRow label={intl.formatMessage({ id: "settings.worktrees.directory" })}>
          <span className="break-all font-mono">{binding.checkoutPath}</span>
        </WorktreeDetailsRow>
        <WorktreeDetailsRow label={intl.formatMessage({ id: "settings.worktrees.status" })}>
          {environment ? (
            <span role="status" data-testid="runtime-environment-status">
              {text(`status.${environment.status}`)}
            </span>
          ) : (
            <span className="text-foreground-subtle" data-testid="runtime-environment-unmanaged">
              {text(binding.environmentRef ? "notLoaded" : "unmanaged")}
            </span>
          )}
        </WorktreeDetailsRow>
        {environment ? (
          <>
            <WorktreeDetailsRow label={text("revision")}>
              <span data-testid="runtime-environment-revision">{environment.currentRevision}</span>
            </WorktreeDetailsRow>
            <WorktreeDetailsRow label={text("source")}>
              {environment.toolSource ? text(`source.${environment.toolSource}`) : text("unknown")}
            </WorktreeDetailsRow>
          </>
        ) : null}
      </WorktreeDetailsTable>
      {environment &&
      (environment.toolSource === "partial-host" ||
        environment.tools.some((tool) => tool.installStrategy === "system-path")) ? (
        <p className="text-ui-sm text-foreground-subtle">{text("partialHost")}</p>
      ) : null}
      {explanation ? (
        <p
          className="break-words text-ui-sm text-foreground-subtle"
          data-testid="runtime-environment-capability"
        >
          {explanation}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            busy || !canPrepare || ["archived", "deleted", "deleting"].includes(binding.status)
          }
          data-testid="runtime-environment-upgrade"
          onClick={upgrade}
        >
          {text("upgrade")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={Boolean(runtime.pending)}
          onClick={() => void runtime.refresh()}
        >
          {text("refresh")}
        </Button>
        {runtime.canCancel ? (
          <Button
            size="sm"
            variant="outline"
            disabled={runtime.pending === "cancel"}
            data-testid="runtime-environment-cancel"
            onClick={() => void runtime.cancel().then(() => onSettled?.())}
          >
            {text("cancel")}
          </Button>
        ) : null}
      </div>
      {runtime.loading || runtime.pending ? (
        <p role="status" className="text-ui-sm" data-testid="runtime-environment-pending">
          {text(runtime.loading ? "loading" : "pending")}
        </p>
      ) : null}
      <WorktreeDetailsTable label={text("resources")} testId="runtime-environment-resources">
        <WorktreeDetailsRow label={text("resources")}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span>{text(`resources.${summary?.status ?? "not-scanned"}`)}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !environment || !canScan}
              data-testid="runtime-environment-scan"
              onClick={() => void runtime.scan()}
            >
              {text("scan")}
            </Button>
          </div>
          {summary?.reason ? (
            <p className="break-words text-foreground-subtle">{summary.reason}</p>
          ) : null}
        </WorktreeDetailsRow>
        {summary?.bytes !== undefined ? (
          <WorktreeDetailsRow label={text("bytes")}>
            {numberFormat.format(summary.bytes)}
          </WorktreeDetailsRow>
        ) : null}
        {summary?.fileCount !== undefined ? (
          <WorktreeDetailsRow label={text("fileCount")}>
            {numberFormat.format(summary.fileCount)}
          </WorktreeDetailsRow>
        ) : null}
      </WorktreeDetailsTable>
      <ReviewDetails title={text("details")} testId="runtime-environment-technical-details">
        <p className="text-foreground-subtle">{text("upgradeHint")}</p>
        {binding.environmentRef ? (
          <p className="text-foreground-subtle">{text("lifecycleData")}</p>
        ) : null}
        {environment?.installStrategy || environment?.manifestDigest ? (
          <WorktreeDetailsTable label={text("details")}>
            {environment.installStrategy ? (
              <WorktreeDetailsRow label={text("installStrategy")}>
                {text(`strategy.${environment.installStrategy}`)}
              </WorktreeDetailsRow>
            ) : null}
            {environment.manifestDigest ? (
              <WorktreeDetailsRow label={text("manifest")}>
                <span className="break-all font-mono">{environment.manifestDigest}</span>
              </WorktreeDetailsRow>
            ) : null}
          </WorktreeDetailsTable>
        ) : null}
        {environment?.tools.length ? (
          <WorktreeDetailsTable label={text("tools")} testId="runtime-environment-tools">
            {environment.tools.map((tool) => (
              <WorktreeDetailsRow
                key={tool.key}
                label={
                  <span className="font-mono">
                    {tool.key} {tool.version}
                  </span>
                }
              >
                {text(`source.${tool.source}`)}
                {tool.installStrategy === "system-path" ? <span> · {text("hostTool")}</span> : null}
              </WorktreeDetailsRow>
            ))}
          </WorktreeDetailsTable>
        ) : null}
      </ReviewDetails>
      {environment ? (
        <RuntimeEnvironmentServices
          environment={environment}
          capabilities={runtime.capabilities}
          pending={busy}
          remote={runtime.isRemoteTarget}
          onAction={runtime.serviceAction}
        />
      ) : null}
      {error ||
      (failure && failure !== "remote-waiting" && failure !== "capability-unavailable") ? (
        <div className="min-w-0 space-y-2">
          <p role="alert" className="break-words text-ui-sm text-destructive">
            {error?.message ?? failure}
          </p>
          {error ? (
            <p className="break-words font-mono text-ui-sm">
              {error.code} · {error.stage}
            </p>
          ) : null}
          {runtime.canRetry && (!error || error.retryable) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="runtime-environment-retry"
              onClick={() => void runtime.retry().then(() => onSettled?.())}
            >
              {text("retry")}
            </Button>
          ) : null}
          <GitFailureAction
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={sessionId}
            disabled={Boolean(runtime.pending)}
            onTransferred={onTransferred}
            context={{
              phase: "runtime-environment",
              workspacePath: binding.checkoutPath,
              workspaceIdentity: binding.workspaceIdentity ?? workspaceIdentity,
              sessionId,
              sourceBranch: binding.branch,
              operationId: runtime.operation?.operationId,
              error: error?.message ?? failure ?? "",
              environmentError: error,
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
