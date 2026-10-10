import type { WorktreeBinding } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { GitFailureAction } from "@/git-action-menu/GitFailureAction.js";
import { environmentActionAvailable } from "@/hooks/runtimeEnvironmentModel.js";
import { useRuntimeEnvironment } from "@/hooks/useRuntimeEnvironment.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { RuntimeEnvironmentServices } from "./RuntimeEnvironmentServices.js";

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
      className="min-w-0 space-y-3 rounded-xl border border-border p-3"
      data-testid="runtime-environment-details"
      aria-label={text("title")}
    >
      <h3 className="text-ui-base font-medium">{text("title")}</h3>
      <p className="break-all font-mono text-ui-sm">{binding.checkoutPath}</p>
      {environment ? (
        <>
          <p role="status" className="text-ui-sm" data-testid="runtime-environment-status">
            {text(`status.${environment.status}`)}
          </p>
          <dl className="space-y-2 text-ui-sm">
            <div>
              <dt className="text-foreground-subtle">{text("revision")}</dt>
              <dd data-testid="runtime-environment-revision">{environment.currentRevision}</dd>
            </div>
            <div>
              <dt className="text-foreground-subtle">{text("source")}</dt>
              <dd>
                {environment.toolSource
                  ? text(`source.${environment.toolSource}`)
                  : text("unknown")}
              </dd>
            </div>
            {environment.installStrategy ? (
              <div>
                <dt className="text-foreground-subtle">{text("installStrategy")}</dt>
                <dd>{text(`strategy.${environment.installStrategy}`)}</dd>
              </div>
            ) : null}
            {environment.manifestDigest ? (
              <div>
                <dt className="text-foreground-subtle">{text("manifest")}</dt>
                <dd className="break-all font-mono">{environment.manifestDigest}</dd>
              </div>
            ) : null}
          </dl>
          {environment.tools.length ? (
            <ul className="space-y-1 text-ui-sm" data-testid="runtime-environment-tools">
              {environment.tools.map((tool) => (
                <li className="break-words" key={tool.key}>
                  <span className="font-mono">
                    {tool.key} {tool.version}
                  </span>
                  {" · "}
                  {text(`source.${tool.source}`)}
                  {tool.installStrategy === "system-path" ? (
                    <span> · {text("hostTool")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {environment.toolSource === "partial-host" ||
          environment.tools.some((tool) => tool.installStrategy === "system-path") ? (
            <p className="text-ui-sm text-foreground-subtle">{text("partialHost")}</p>
          ) : null}
        </>
      ) : (
        <p
          className="text-ui-sm text-foreground-subtle"
          data-testid="runtime-environment-unmanaged"
        >
          {text(binding.environmentRef ? "notLoaded" : "unmanaged")}
        </p>
      )}
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
      <p className="text-ui-sm text-foreground-subtle">{text("upgradeHint")}</p>
      {runtime.loading || runtime.pending ? (
        <p role="status" className="text-ui-sm" data-testid="runtime-environment-pending">
          {text(runtime.loading ? "loading" : "pending")}
        </p>
      ) : null}
      <div className="space-y-1 text-ui-sm" data-testid="runtime-environment-resources">
        <h4 className="font-medium">{text("resources")}</h4>
        {binding.environmentRef ? (
          <p className="text-foreground-subtle">{text("lifecycleData")}</p>
        ) : null}
        <p>{text(`resources.${summary?.status ?? "not-scanned"}`)}</p>
        {summary?.bytes !== undefined ? (
          <p>
            {text("bytes")} {numberFormat.format(summary.bytes)}
          </p>
        ) : null}
        {summary?.fileCount !== undefined ? (
          <p>
            {text("fileCount")} {numberFormat.format(summary.fileCount)}
          </p>
        ) : null}
        {summary?.reason ? (
          <p className="break-words text-foreground-subtle">{summary.reason}</p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !environment || !canScan}
          data-testid="runtime-environment-scan"
          onClick={() => void runtime.scan()}
        >
          {text("scan")}
        </Button>
      </div>
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
