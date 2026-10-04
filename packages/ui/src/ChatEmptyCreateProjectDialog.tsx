import { useRef, useState, type DragEvent } from "react";
import {
  LOCAL_PROJECT_NAME_MAX_LENGTH,
  LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT,
  TID_CREATE_PROJECT_ADD_FOLDER,
  TID_CREATE_PROJECT_DIALOG,
  TID_CREATE_PROJECT_NAME,
  TID_CREATE_PROJECT_SUBMIT,
  localProjectPathKey,
  type LocalProjectCreateRequest,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  mergeLocalProjectFolderPaths,
  resolveDroppedLocalProjectFolders,
} from "@/createProjectFolderDrop.js";
import { Folder, FolderPlus, LoaderCircle, X } from "lucide-react";

export function ChatEmptyCreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (request: LocalProjectCreateRequest) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const baseServices = useBaseWorkspaceServices();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [sourceFolderPaths, setSourceFolderPaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [checkingDroppedFolders, setCheckingDroppedFolders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropRequestIdRef = useRef(0);
  const dropPendingRef = useRef(false);
  const canDropFolders = Boolean(platform.canSelectFilePath && platform.getPathForFile);

  const reset = () => {
    setName("");
    setNameTouched(false);
    setSourceFolderPaths([]);
    setSubmitting(false);
    setDragActive(false);
    setCheckingDroppedFolders(false);
    setError(null);
    dropPendingRef.current = false;
    dropRequestIdRef.current += 1;
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !submitting) {
      reset();
    }
    onOpenChange(nextOpen);
  };
  const handleAddFolder = async () => {
    const path = await platform.selectDirectory();
    if (!path) {
      return;
    }
    const merged = mergeLocalProjectFolderPaths(sourceFolderPaths, [path]);
    setSourceFolderPaths(merged.paths);
    if (!nameTouched && !name.trim() && merged.addedPaths.length > 0) {
      setName(getPathLeaf(merged.addedPaths[0]!));
    }
    setError(null);
  };
  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!canDropFolders || dropPendingRef.current) return;

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;

    dropPendingRef.current = true;
    const requestId = ++dropRequestIdRef.current;
    setCheckingDroppedFolders(true);
    setError(null);
    try {
      const resolved = await resolveDroppedLocalProjectFolders(
        files,
        (file) => platform.getPathForFile?.(file) ?? null,
        async (path) => (await baseServices.fileService.stat({ path })).type,
      );
      if (requestId !== dropRequestIdRef.current) return;

      const merged = mergeLocalProjectFolderPaths(sourceFolderPaths, resolved.folderPaths);
      setSourceFolderPaths(merged.paths);
      if (!nameTouched && !name.trim() && merged.addedPaths.length > 0) {
        setName(getPathLeaf(merged.addedPaths[0]!));
      }

      if (merged.discardedForLimitCount > 0) {
        setError(
          intl.formatMessage(
            { id: "chat.empty.createProject.folderLimit" },
            { count: LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT },
          ),
        );
      } else if (resolved.rejectedCount > 0) {
        setError(intl.formatMessage({ id: "chat.empty.createProject.dropInvalid" }));
      }
    } finally {
      if (requestId === dropRequestIdRef.current) {
        dropPendingRef.current = false;
        setCheckingDroppedFolders(false);
      }
    }
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  };
  const handleSubmit = async () => {
    if (!name.trim() || sourceFolderPaths.length === 0 || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name, sourceFolderPaths });
      reset();
      onOpenChange(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-full max-w-2xl gap-5 p-6" data-testid={TID_CREATE_PROJECT_DIALOG}>
        <DialogHeader>
          <DialogTitle className="text-ui-lg font-semibold">
            {intl.formatMessage({ id: "chat.empty.createProject.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "chat.empty.createProject.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Input
            autoFocus
            size="lg"
            value={name}
            maxLength={LOCAL_PROJECT_NAME_MAX_LENGTH}
            data-testid={TID_CREATE_PROJECT_NAME}
            disabled={submitting || checkingDroppedFolders}
            placeholder={intl.formatMessage({ id: "chat.empty.createProject.namePlaceholder" })}
            aria-label={intl.formatMessage({ id: "chat.empty.createProject.namePlaceholder" })}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
              setError(null);
            }}
          />

          <section className="grid gap-2">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "chat.empty.createProject.sourceFolders" })}
            </h3>
            <div
              className={cn(
                "grid min-h-36 gap-2 rounded-xl border border-card-border bg-surface p-3 transition-colors",
                dragActive ? "border-border-hover bg-surface-hover" : "",
              )}
              data-testid="create-project-folder-drop-zone"
              aria-label={
                canDropFolders
                  ? intl.formatMessage({ id: "chat.empty.createProject.dropHint" })
                  : undefined
              }
              aria-busy={checkingDroppedFolders}
              onDragOver={canDropFolders ? handleDragOver : undefined}
              onDragLeave={canDropFolders ? handleDragLeave : undefined}
              onDrop={canDropFolders ? (event) => void handleDrop(event) : undefined}
            >
              {dragActive ? (
                <div className="flex items-center justify-center text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "chat.empty.createProject.dropActive" })}
                </div>
              ) : sourceFolderPaths.length > 0 ? (
                <div className="grid content-start gap-1">
                  {sourceFolderPaths.map((path, index) => (
                    <div
                      key={localProjectPathKey(path)}
                      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
                    >
                      <Folder className="size-4 shrink-0 text-foreground-subtle" />
                      <span className="min-w-0 flex-1 truncate font-mono text-ui-sm" title={path}>
                        {path}
                      </span>
                      {index === 0 ? (
                        <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                          {intl.formatMessage({ id: "chat.empty.createProject.primaryFolder" })}
                        </span>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={submitting || checkingDroppedFolders}
                        aria-label={intl.formatMessage({
                          id: "chat.empty.createProject.removeFolder",
                        })}
                        onClick={() => {
                          setSourceFolderPaths((current) =>
                            current.filter((candidate) => candidate !== path),
                          );
                          setError(null);
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center text-ui-base text-foreground-subtle">
                  {intl.formatMessage({
                    id: canDropFolders
                      ? "chat.empty.createProject.dropHint"
                      : "chat.empty.createProject.addFromComputer",
                  })}
                </div>
              )}
              <div className="flex items-center justify-center gap-3">
                {canDropFolders && sourceFolderPaths.length > 0 && !dragActive ? (
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "chat.empty.createProject.dropMoreHint" })}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid={TID_CREATE_PROJECT_ADD_FOLDER}
                  disabled={
                    submitting ||
                    checkingDroppedFolders ||
                    sourceFolderPaths.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT
                  }
                  onClick={() => void handleAddFolder()}
                >
                  {checkingDroppedFolders ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <FolderPlus className="size-4" />
                  )}
                  {intl.formatMessage({ id: "chat.empty.createProject.addFolder" })}
                </Button>
              </div>
            </div>
          </section>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            data-testid={TID_CREATE_PROJECT_SUBMIT}
            disabled={
              !name.trim() || sourceFolderPaths.length === 0 || submitting || checkingDroppedFolders
            }
            onClick={() => void handleSubmit()}
          >
            {intl.formatMessage({ id: "chat.empty.createProject.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
