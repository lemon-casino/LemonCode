import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RotateCcwIcon, SquareIcon } from "lucide-react";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowActorSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { WorkflowActorSupplementComposer } from "./WorkflowActorSupplementComposer.js";
import {
  resolveWorkflowActorSupplementChange,
  selectWorkflowActorTask,
  updateWorkflowActorTaskError,
  workflowActorTaskActionState,
} from "./workflowActorTaskState.js";

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
  const [errorsByDraft, setErrorsByDraft] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const supplementInputApiRef = useRef<LexicalChatInputHandle | null>(null);
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
    setErrorsByDraft({});
  }, [tab.openedAt, tab.focusPhaseName]);
  const selected = selectWorkflowActorTask(asks, selectedKey, tab.focusPhaseName);
  const actions = workflowActorTaskActionState(run, selected);
  const draftKey = selected === undefined ? "" : keyOf(selected);
  const supplement = drafts[draftKey] ?? "";
  const error = errorsByDraft[draftKey];
  const activeDraftKeyRef = useRef(draftKey);
  activeDraftKeyRef.current = draftKey;
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

  const send = async (
    action: "stop" | "retry" | "revise",
    text = "",
    clearSubmittedDraft = false,
  ) => {
    if (selected === undefined || pending) return;
    if (action === "stop" && !actions.canStop) return;
    if (action === "retry" && !actions.canRetry) return;
    if (action === "revise" && !actions.canRevise) return;
    setPending(true);
    setErrorsByDraft((current) => updateWorkflowActorTaskError(current, draftKey, undefined));
    try {
      const attachmentIds = action === "stop" ? [] : images.attachments.map((image) => image.id);
      const attachments = action === "stop" ? [] : await images.prepareForSend();
      if (attachments === null) {
        setErrorsByDraft((current) =>
          updateWorkflowActorTaskError(
            current,
            draftKey,
            intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.imagesNotReady" }),
          ),
        );
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
        // ACK 可能在外部 phase focus 已切到另一 ask 后返回；错误必须归属发出命令的草稿，
        // 不能像单值状态那样污染当前任务。
        setErrorsByDraft((current) =>
          updateWorkflowActorTaskError(
            current,
            draftKey,
            intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.actionRejected" }),
          ),
        );
        return;
      }
      if (clearSubmittedDraft) {
        // 输入框提交在 Host 接受前必须保留本地草稿；仅 accepted/duplicate ACK 后同步清空
        // React 草稿与 Lexical 内部状态，避免失败重试时出现“外层有值、编辑器已空”的分叉。
        const nextDrafts = { ...draftsRef.current, [draftKey]: "" };
        draftsRef.current = nextDrafts;
        setDrafts(nextDrafts);
        // ACK 返回期间侧栏可能被外部 phase focus 切到另一任务；共享 ref 此时已经指向
        // 新编辑器，旧任务的 ACK 不能清掉新任务草稿。
        if (activeDraftKeyRef.current === draftKey) supplementInputApiRef.current?.clear();
      }
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
      setErrorsByDraft((current) =>
        updateWorkflowActorTaskError(
          current,
          draftKey,
          intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.actionRejected" }),
        ),
      );
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
        <input
          ref={images.attachmentInputRef}
          accept="image/*"
          className="hidden"
          multiple
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
          type="file"
        />
        <WorkflowActorSupplementComposer
          attachments={images.attachments}
          attachmentError={images.attachmentError}
          canSubmit={canSubmit}
          disabled={!(actions.canRetry || actions.canRevise) || pending}
          draftKey={draftKey}
          inputApiRef={supplementInputApiRef}
          onAddImage={() => images.attachmentInputRef.current?.click()}
          onChange={(value) => {
            const previousValue = draftsRef.current[draftKey] ?? "";
            const acceptedValue = resolveWorkflowActorSupplementChange(previousValue, value);
            if (acceptedValue === value) {
              const nextDrafts = { ...draftsRef.current, [draftKey]: acceptedValue };
              draftsRef.current = nextDrafts;
              setDrafts(nextDrafts);
              return;
            }
            // contenteditable 没有原生 maxLength；超限变更必须恢复上一次完整草稿，
            // 不能截断尾部，否则在满额文本中间插字会静默删除原有内容。
            queueMicrotask(() => {
              if (activeDraftKeyRef.current !== draftKey) return;
              const inputApi = supplementInputApiRef.current;
              if (inputApi?.getMarkdown() === value) inputApi.setText(previousValue);
            });
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (files.length === 0) return;
            if (files.some((file) => !file.type.startsWith("image/"))) {
              event.preventDefault();
              event.stopPropagation?.();
              images.setAttachmentError(
                intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.imagesOnly" }),
              );
              return;
            }
            // 通用粘贴会在图片附带表格 HTML 时优先生成文本附件；actor 协议只接受图片，
            // 因此在完成 MIME 校验后直接进入同一附件上传事务。
            event.preventDefault();
            event.stopPropagation?.();
            images.addAttachmentFiles(files);
          }}
          onRemoveImage={images.removeAttachment}
          onRetryImage={images.retryAttachment}
          onSubmit={(value) => {
            if (!canSubmit) return false;
            void send(actions.canRevise ? "revise" : "retry", value.trim(), true);
            return false;
          }}
          parentSessionId={tab.parentSessionId}
          pending={pending}
          value={supplement}
          workspaceIdentity={tab.workspaceIdentity}
          workspacePath={tab.workspacePath}
        />
      </div>
    </div>
  );
}
