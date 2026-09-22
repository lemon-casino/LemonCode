import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpIcon, ImagePlusIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowActorSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { selectWorkflowActorTask, workflowActorTaskActionState } from "./workflowActorTaskState.js";

function keyOf(node: WorkflowRunNode): string {
  return `${node.siteId}@${node.ordinal}`;
}

export function WorkflowActorTaskControls({
  run,
  tab,
  children,
  onOpenWorkflowRun,
}: {
  run: WorkflowRunState | undefined;
  tab: WorkflowActorSessionSidePaneTab;
  children: ReactNode;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { sendCommand, attachmentPut, onRuntimeRestart, onRuntimeLifecycle } = useV4Conversation();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const asks = useMemo(
    () =>
      run?.nodes.filter(
        (node) =>
          node.kind === "ask" &&
          node.actorSiteId === tab.siteId &&
          node.actorOrdinal === tab.ordinal,
      ) ?? [],
    [run?.nodes, tab.siteId, tab.ordinal],
  );
  useEffect(() => {
    setSelectedKey(undefined);
    setError(undefined);
  }, [tab.openedAt, tab.focusPhaseName]);
  const selected = selectWorkflowActorTask(asks, selectedKey, tab.focusPhaseName);
  const actions = workflowActorTaskActionState(run, selected);
  const draftKey = selected === undefined ? "" : keyOf(selected);
  const supplement = drafts[draftKey] ?? "";
  const images = useComposerAttachments({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    scopeId: `workflow-ask:${tab.runId}:${draftKey}`,
    attachmentSessionId: tab.parentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled: pending || selected === undefined,
    listenAddToChatEvents: false,
  });
  const canSubmit =
    (actions.canRetry || actions.canRevise) &&
    (Boolean(supplement.trim()) || images.hasAttachments) &&
    !images.hasUnreadyAttachments &&
    !pending;

  const send = async (action: "stop" | "retry" | "revise", text = "") => {
    if (selected === undefined || pending) return;
    if (action === "stop" && !actions.canStop) return;
    if (action === "retry" && !actions.canRetry) return;
    if (action === "revise" && !actions.canRevise) return;
    setPending(true);
    setError(undefined);
    try {
      const attachmentIds = action === "stop" ? [] : images.attachments.map((image) => image.id);
      const attachments = action === "stop" ? [] : await images.prepareForSend();
      if (attachments === null) {
        setError(intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.imagesNotReady" }));
        return;
      }
      const ack = await sendCommand(
        createCommandEnvelope({
          type: action === "revise" ? "reviseWorkflowAsk" : "controlWorkflowAsk",
          sessionId: tab.parentSessionId,
          payload:
            action === "revise"
              ? {
                  runId: tab.runId,
                  siteId: selected.siteId,
                  ordinal: selected.ordinal,
                  ...(text ? { supplement: text } : {}),
                  ...(attachments.length ? { attachments } : {}),
                }
              : {
                  runId: tab.runId,
                  siteId: selected.siteId,
                  ordinal: selected.ordinal,
                  attempt: selected.attempt ?? 1,
                  action,
                  ...(text ? { supplement: text } : {}),
                  ...(attachments.length ? { attachments } : {}),
                },
        }),
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        setError(intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.actionRejected" }));
        return;
      }
      if (text) setDrafts((current) => ({ ...current, [draftKey]: "" }));
      if (attachmentIds.length) {
        await images.adoptSentAttachments(attachmentIds);
        images.clearAttachments(attachmentIds);
      }
      if (ack.result?.type === "reviseWorkflowAsk" && run?.toolCallId) {
        onOpenWorkflowRun?.({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
          parentSessionId: tab.parentSessionId,
          toolCallId: run.toolCallId,
          runId: ack.result.runId,
        });
      }
    } catch {
      // 准备附件或发命令失败时保留草稿，释放提交门以便重试。
      setError(intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.actionRejected" }));
    } finally {
      setPending(false);
    }
  };

  if (asks.length === 0) return <div className="flex h-full min-h-0 flex-col">{children}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workflow-actor-task-controls">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Select
            disabled={pending}
            onValueChange={setSelectedKey}
            value={selected === undefined ? undefined : keyOf(selected)}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.task" })}
              className="min-w-0 flex-1"
              size="sm"
              variant="outline"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {asks.map((node) => (
                <SelectItem key={keyOf(node)} value={keyOf(node)}>
                  {node.instructionsHead?.slice(0, 64) ?? keyOf(node)}
                  {node.attempt && node.attempt > 1 ? ` · #${node.attempt}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.stop" })}
          >
            <Button
              aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.stop" })}
              data-testid="workflow-actor-stop"
              disabled={!actions.canStop || pending}
              onClick={() => {
                void send("stop");
              }}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.retry" })}
          >
            <Button
              aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.retry" })}
              data-testid="workflow-actor-retry"
              disabled={!(actions.canRetry || actions.canRevise) || pending}
              onClick={() => {
                void send(actions.canRevise ? "revise" : "retry");
              }}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <RotateCcwIcon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        </div>
        {error === undefined ? null : (
          <p className="mt-1 text-ui-xs text-warning" role="status">
            {error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <div className="shrink-0 border-t border-border bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        {actions.waitingForRun ? (
          <p className="mb-2 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.waitForRun" })}
          </p>
        ) : null}
        {images.hasAttachments ? (
          <div
            className="mb-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto"
            data-testid="workflow-actor-images"
          >
            {images.attachments.map((item) => (
              <div
                key={item.id}
                className="flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-1 text-ui-xs"
              >
                <ImagePlusIcon className="size-3 shrink-0" />
                <span className="max-w-32 truncate" title={item.filename}>
                  {item.filename}
                </span>
                {item.uploadStatus === "failed" ? (
                  <Button
                    aria-label={intl.formatMessage({ id: "chat.attachments.upload.retry" })}
                    onClick={() => images.retryAttachment(item.id)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcwIcon className="size-3" />
                  </Button>
                ) : item.uploadStatus !== "ready" ? (
                  <span>{item.uploadProgress}%</span>
                ) : null}
                <Button
                  aria-label={intl.formatMessage({
                    id: "chat.toolCall.workflow.run.actor.removeImage",
                  })}
                  onClick={() => images.removeAttachment(item.id)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {images.attachmentError ? (
          <p role="status" className="mb-1 text-ui-xs text-warning">
            {images.attachmentError}
          </p>
        ) : null}
        <div className="flex min-w-0 items-end gap-2">
          <input
            ref={images.attachmentInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (
                Array.from(event.currentTarget.files ?? []).every((file) =>
                  file.type.startsWith("image/"),
                )
              )
                images.handleAttachmentInputChange(event);
              else {
                event.currentTarget.value = "";
                images.setAttachmentError(
                  intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.imagesOnly" }),
                );
              }
            }}
          />
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.addImage" })}
          >
            <Button
              aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.addImage" })}
              disabled={!(actions.canRetry || actions.canRevise) || pending}
              onClick={() => images.attachmentInputRef.current?.click()}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ImagePlusIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <Textarea
            aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.supplement" })}
            className="max-h-36 min-h-16 min-w-0 flex-1 resize-y"
            data-testid="workflow-actor-supplement"
            disabled={!(actions.canRetry || actions.canRevise) || pending}
            maxLength={32_768}
            onChange={(event) =>
              setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canSubmit) {
                event.preventDefault();
                void send(actions.canRevise ? "revise" : "retry", supplement.trim());
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              if (files.some((file) => !file.type.startsWith("image/"))) {
                event.preventDefault();
                images.setAttachmentError(
                  intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.imagesOnly" }),
                );
                return;
              }
              images.handlePaste(event);
            }}
            placeholder={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.supplement" })}
            value={supplement}
          />
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.sendSupplement" })}
          >
            <Button
              aria-label={intl.formatMessage({
                id: "chat.toolCall.workflow.run.actor.sendSupplement",
              })}
              disabled={!canSubmit}
              onClick={() => {
                void send(actions.canRevise ? "revise" : "retry", supplement.trim());
              }}
              size="icon-sm"
              type="button"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </div>
  );
}
