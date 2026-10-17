import { useRef, useState } from "react";
import {
  LOCAL_PROJECT_NAME_MAX_LENGTH,
  TID_CREATE_PROJECT_ADD_FOLDER,
  TID_CREATE_PROJECT_DIALOG,
  TID_CREATE_PROJECT_NAME,
  TID_CREATE_PROJECT_SUBMIT,
  isSameLocalProjectPath,
  type LocalProjectCreateRequest,
  type ProjectMember,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useProjectFolderDrop } from "@/hooks/useProjectFolderDrop.js";
import { getPathLeaf } from "@/lib/path.js";
import { mergeLocalProjectFolderPaths } from "@/createProjectFolderDrop.js";
import { ProjectDialogContent } from "@/WorkspaceSidebar/ProjectDialogContent.js";
import { ProjectSourceFolders } from "@/WorkspaceSidebar/ProjectSourceFolders.js";
import { useProjectEditorText } from "@/WorkspaceSidebar/projectEditorText.js";

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
  const text = useProjectEditorText();
  const platform = usePlatform();
  const services = useBaseWorkspaceServices();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const sourceFolderPaths = members.map((member) => member.path);
  const reset = () => {
    generation.current++;
    setName("");
    setNameTouched(false);
    setMembers([]);
    setSubmitting(false);
    setSelecting(false);
    setError(null);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };
  const mergeFolders = (paths: string[]) => {
    const merged = mergeLocalProjectFolderPaths(sourceFolderPaths, paths);
    setMembers(
      merged.paths.map(
        (path) =>
          members.find((member) => isSameLocalProjectPath(member.path, path)) ?? {
            id: crypto.randomUUID(),
            path,
            role: "",
            label: "",
            description: "",
            enabled: true,
          },
      ),
    );
    if (!nameTouched && !name.trim() && merged.addedPaths.length)
      setName(getPathLeaf(merged.addedPaths[0]!));
    if (merged.discardedForLimitCount) setError(text("limit"));
  };
  const drop = useProjectFolderDrop({
    enabled: open,
    busy: submitting || selecting,
    services,
    onFolders: mergeFolders,
    onError: setError,
  });
  const busy = submitting || selecting || drop.checking;
  const handleAddFolders = async () => {
    const token = generation.current;
    setSelecting(true);
    setError(null);
    try {
      const paths = platform.selectDirectories
        ? await platform.selectDirectories()
        : [await platform.selectDirectory()].filter((path): path is string => Boolean(path));
      if (token === generation.current && paths.length) mergeFolders(paths);
    } catch (failure) {
      if (token === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === generation.current) setSelecting(false);
    }
  };
  const canSubmit = Boolean(name.trim() && members.some((member) => member.enabled) && !busy);
  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name, sourceFolderPaths, members });
      reset();
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setSubmitting(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <ProjectDialogContent
        data-testid={TID_CREATE_PROJECT_DIALOG}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <DialogHeader>
          <DialogTitle className="pr-8 text-ui-lg font-semibold">
            {intl.formatMessage({ id: "chat.empty.createProject.title" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {intl.formatMessage({ id: "chat.empty.createProject.description" })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label className="block space-y-2 text-ui-sm">
            <span>{text("name")}</span>
            <Input
              autoFocus
              size="lg"
              value={name}
              maxLength={LOCAL_PROJECT_NAME_MAX_LENGTH}
              data-testid={TID_CREATE_PROJECT_NAME}
              disabled={busy}
              placeholder={text("name")}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
                setError(null);
              }}
            />
          </label>
          <ProjectSourceFolders
            members={members}
            primaryPath={sourceFolderPaths[0]}
            primaryLocked={false}
            disabled={busy}
            checking={selecting || drop.checking}
            dragging={drop.dragging}
            canDrop={drop.canDrop}
            addTestId={TID_CREATE_PROJECT_ADD_FOLDER}
            onAdd={() => void handleAddFolders()}
            onChange={(next) =>
              setMembers((current) =>
                current.map((member) => (member.id === next.id ? next : member)),
              )
            }
            onRemove={(id) => {
              setMembers(members.filter((member) => member.id !== id));
              setError(null);
            }}
          />
          {members.length > 0 && !members.some((member) => member.enabled) ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {text("noSelection")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => handleOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            data-testid={TID_CREATE_PROJECT_SUBMIT}
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {intl.formatMessage({ id: "chat.empty.createProject.submit" })}
          </Button>
        </DialogFooter>
      </ProjectDialogContent>
    </Dialog>
  );
}
