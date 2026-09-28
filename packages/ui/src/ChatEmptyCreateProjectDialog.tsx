import { useState } from "react";
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
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { getPathLeaf } from "@/lib/path.js";
import { Folder, FolderPlus, X } from "lucide-react";

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
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [sourceFolderPaths, setSourceFolderPaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setNameTouched(false);
    setSourceFolderPaths([]);
    setSubmitting(false);
    setError(null);
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
    const pathKey = localProjectPathKey(path);
    setSourceFolderPaths((current) =>
      current.some((candidate) => localProjectPathKey(candidate) === pathKey)
        ? current
        : [...current, path],
    );
    if (!nameTouched && !name.trim()) {
      setName(getPathLeaf(path));
    }
    setError(null);
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
            <div className="grid min-h-36 gap-2 rounded-xl border border-card-border bg-surface p-3">
              {sourceFolderPaths.length > 0 ? (
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
                  {intl.formatMessage({ id: "chat.empty.createProject.addFromComputer" })}
                </div>
              )}
              <div className="flex items-end justify-center">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid={TID_CREATE_PROJECT_ADD_FOLDER}
                  disabled={
                    submitting || sourceFolderPaths.length >= LOCAL_PROJECT_SOURCE_FOLDER_MAX_COUNT
                  }
                  onClick={() => void handleAddFolder()}
                >
                  <FolderPlus className="size-4" />
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
            disabled={!name.trim() || sourceFolderPaths.length === 0 || submitting}
            onClick={() => void handleSubmit()}
          >
            {intl.formatMessage({ id: "chat.empty.createProject.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
