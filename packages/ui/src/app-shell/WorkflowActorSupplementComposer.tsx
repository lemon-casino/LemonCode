import { useMemo, useState, type MutableRefObject } from "react";
import { RotateCcwIcon, XIcon } from "lucide-react";
import {
  Attachment,
  Attachments,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ChatComposerPasteEvent, LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";

export function WorkflowActorSupplementComposer({
  attachments,
  attachmentError,
  canSubmit,
  disabled,
  draftKey,
  inputApiRef,
  onAddImage,
  onChange,
  onPaste,
  onRemoveImage,
  onRetryImage,
  onSubmit,
  parentSessionId,
  pending,
  value,
  workspaceIdentity,
  workspacePath,
}: {
  attachments: readonly ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  canSubmit: boolean;
  disabled: boolean;
  draftKey: string;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  onAddImage: () => void;
  onChange: (value: string) => void;
  onPaste: (event: ChatComposerPasteEvent) => void;
  onRemoveImage: (id: string) => void;
  onRetryImage: (id: string) => void;
  onSubmit: (value: string) => boolean | void;
  parentSessionId: string;
  pending: boolean;
  value: string;
  workspaceIdentity?: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewItems = useMemo(
    () =>
      attachments.flatMap((attachment) =>
        attachment.objectUrl
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [attachments],
  );
  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.addImage" }),
      onSelect: onAddImage,
    }),
    [intl, onAddImage],
  );
  const previewLabel = intl.formatMessage({ id: "chat.attachments.preview.open" });
  const topContent =
    attachments.length === 0 && !attachmentError ? null : (
      <div className="flex max-w-full flex-col items-start gap-2">
        {attachments.length > 0 ? (
          <Attachments
            className="flex max-w-full flex-wrap gap-2"
            data-testid="workflow-actor-images"
            variant="inline"
          >
            {attachments.map((attachment) => {
              const showUploadStatus =
                !attachment.localZeroCopy &&
                (attachment.uploadStatus !== "ready" || attachment.showComplete);
              const uploadStatusLabel =
                attachment.uploadStatus === "uploading"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.uploading" },
                      { progress: String(attachment.uploadProgress) },
                    )
                  : attachment.uploadStatus === "failed"
                    ? intl.formatMessage(
                        { id: "chat.attachments.upload.failed" },
                        { message: attachment.uploadError ?? "unknown" },
                      )
                    : intl.formatMessage({
                        id: `chat.attachments.upload.${attachment.uploadStatus}`,
                      });
              return (
                <Attachment
                  key={attachment.id}
                  className="relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                  data={{
                    id: attachment.id,
                    type: "file",
                    filename: attachment.filename,
                    mediaType: attachment.objectUrl
                      ? attachment.mimeType
                      : "application/octet-stream",
                    url: attachment.objectUrl ?? "",
                  }}
                  data-upload-status={attachment.uploadStatus}
                  data-workflow-actor-image={attachment.id}
                  onOpen={
                    attachment.objectUrl
                      ? () => {
                          const nextIndex = previewItems.findIndex(
                            (item) => item.src === attachment.objectUrl,
                          );
                          if (nextIndex < 0) return;
                          setPreviewIndex(nextIndex);
                          setPreviewOpen(true);
                        }
                      : undefined
                  }
                  openLabel={attachment.objectUrl ? previewLabel : undefined}
                  variant="grid"
                >
                  <div className="relative size-full shrink-0">
                    <AttachmentPreview className="size-full rounded-none" />
                    {showUploadStatus ? (
                      <span
                        aria-label={uploadStatusLabel}
                        className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                        role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      >
                        <svg
                          aria-hidden="true"
                          className="absolute inset-0 size-full -rotate-90 text-brand"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="stroke-border"
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeWidth="2"
                          />
                          <circle
                            className={
                              attachment.uploadStatus === "failed"
                                ? "stroke-destructive"
                                : "stroke-current"
                            }
                            cx="12"
                            cy="12"
                            fill="none"
                            pathLength="100"
                            r="9"
                            strokeDasharray={`${attachment.uploadProgress} 100`}
                            strokeLinecap="round"
                            strokeWidth="2"
                          />
                        </svg>
                        <span className="relative">
                          {attachment.uploadStatus === "failed"
                            ? "!"
                            : `${attachment.uploadProgress}%`}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  {attachment.uploadStatus === "failed" ? (
                    <button
                      aria-label={intl.formatMessage({ id: "chat.attachments.upload.retry" })}
                      className="absolute bottom-0.5 left-0.5 z-20 grid size-5 place-items-center rounded-md bg-background/90 text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRetryImage(attachment.id);
                      }}
                      type="button"
                    >
                      <RotateCcwIcon className="size-3" />
                    </button>
                  ) : null}
                  <Button
                    aria-label={intl.formatMessage({
                      id: "chat.toolCall.workflow.run.actor.removeImage",
                    })}
                    className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onRemoveImage(attachment.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon className="size-2.5" />
                  </Button>
                </Attachment>
              );
            })}
          </Attachments>
        ) : null}
        {attachmentError ? (
          <p className="text-ui-xs text-warning" role="status">
            {attachmentError}
          </p>
        ) : null}
      </div>
    );

  return (
    <>
      <ChatPromptEditor
        key={draftKey}
        allowSubmitWhenEmpty={attachments.length > 0}
        attachmentAction={attachmentAction}
        disabled={disabled}
        enableActionMenuQuickCommands={false}
        enableMentionPanel={false}
        enableSlashPanel={false}
        enterSubmits={false}
        initialValue={value}
        inputApiRef={inputApiRef}
        inputTestId="workflow-actor-supplement"
        onChange={onChange}
        onModifiedSubmit={onSubmit}
        onPaste={onPaste}
        onSubmit={onSubmit}
        placeholder={intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.supplement" })}
        shellTestId="workflow-actor-composer-shell"
        submitDisabled={!canSubmit}
        submitLabel={intl.formatMessage({
          id: "chat.toolCall.workflow.run.actor.sendSupplement",
        })}
        submitting={pending}
        taskId={parentSessionId}
        topContent={topContent}
        workspaceIdentity={workspaceIdentity}
        workspacePath={workspacePath}
      />
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onOpenChange={setPreviewOpen}
        open={previewOpen}
      />
    </>
  );
}
