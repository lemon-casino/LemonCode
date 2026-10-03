import type { LCodeProvider } from "@lcode/shared";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";

/** 修复 projection 仍由原 Host 管理，权限交互在父会话显示，命令路由到隐藏修复会话。 */
export function WorktreeRepairPanel({
  lease,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  provider,
  onStop,
}: {
  lease: SessionLease;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  provider?: LCodeProvider;
  onStop: () => void;
}) {
  const state = useConversationProjection(lease);
  const { intl } = useLCodeIntl();
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="worktree-repair-panel"
    >
      <p role="status" className="text-ui-sm">
        {intl.formatMessage({ id: "worktree.repairRunning" })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={state.snapshot?.control.phase !== "running"}
        onClick={onStop}
      >
        {intl.formatMessage({ id: "worktree.stopRepair" })}
      </Button>
      <V4InteractionDialogs
        sessionId={lease.sessionId}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId}
        provider={provider}
        snapshot={state.snapshot}
      />
    </section>
  );
}
