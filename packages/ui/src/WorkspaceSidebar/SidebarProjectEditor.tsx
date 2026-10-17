import { useState } from "react";
import { Folder, LoaderCircle } from "lucide-react";
import { isSameLocalProjectPath, type ProjectMember } from "@lcode/shared";
import {
  useSidebarOrganization,
  type SidebarProjectEditorTarget,
} from "@/hooks/useSidebarOrganization.js";
import { useProjectEditor } from "@/hooks/useProjectEditor.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { ProjectSourceFolders } from "./ProjectSourceFolders.js";
import { useProjectFolderDrop } from "@/hooks/useProjectFolderDrop.js";
import { ProjectDialogContent } from "./ProjectDialogContent.js";
import { ProjectEditorFooter } from "./ProjectEditorFooter.js";
import {
  formatProjectMemberPurpose,
  useProjectEditorText,
  useProjectRoleText,
} from "./projectEditorText.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarProjectEditor({ target }: { target: SidebarProjectEditorTarget }) {
  const organization = useSidebarOrganization()!;
  const platform = usePlatform();
  const text = useProjectEditorText();
  const roleText = useProjectRoleText();
  const sidebar = useSidebarText();
  const editor = useProjectEditor(target, () => organization.editProject(null, target));
  const { draft, setDraft } = editor;
  const [browsing, setBrowsing] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [folderTab, setFolderTab] = useState("folders");
  const [selecting, setSelecting] = useState(false);
  const remote = Boolean(target.workspaceIdentity);
  const drop = useProjectFolderDrop({
    enabled: !remote && folderTab === "folders" && editor.ready,
    busy: editor.checking || editor.saving || selecting,
    services: editor.services,
    onFolders: async (paths) => {
      await editor.addFolders(paths);
    },
    onError: editor.reportFolderError,
  });
  const busy = editor.saving || editor.checking || selecting || drop.checking;
  const close = () => {
    // 中文依据：取消明确表示丢弃草稿，不再增加确认层；已发送命令的迟到回执仍由原 owner 处理。
    organization.editProject(null);
  };
  const setMembers = (members: ProjectMember[]) => {
    if (!draft) return;
    setDraft({
      ...draft,
      members,
      memberOrder: members.map((member) => member.id),
      sourceFolderPaths: [
        draft.primaryFolderPath,
        ...members
          .filter((member) => !isSameLocalProjectPath(member.path, draft.primaryFolderPath))
          .map((member) => member.path),
      ],
    });
  };
  const members = draft?.members
    ? [...draft.members].sort(
        (a, b) => draft.memberOrder!.indexOf(a.id) - draft.memberOrder!.indexOf(b.id),
      )
    : [];
  const availableFolders = editor.projects
    .filter(
      (project) =>
        project.id !== draft?.id && project.workspaceIdentity === draft?.workspaceIdentity,
    )
    .flatMap((project) =>
      project.sourceFolderPaths.map((path) => ({
        projectId: project.id,
        name: project.name,
        path,
      })),
    );
  const add = async () => {
    if (remote || !platform.canSelectFilePath) {
      setBrowserPath("");
      setBrowsing(true);
    } else {
      setSelecting(true);
      try {
        const paths = platform.selectDirectories
          ? await platform.selectDirectories()
          : [await platform.selectDirectory()].filter((path): path is string => Boolean(path));
        if (paths.length) await editor.addFolders(paths);
      } catch (failure) {
        editor.reportFolderError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setSelecting(false);
      }
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <ProjectDialogContent
        data-testid="sidebar-project-editor"
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <DialogHeader>
          <DialogTitle className="pr-8 text-ui-lg font-semibold">{text("title")}</DialogTitle>
          <DialogDescription className="sr-only">
            {target.label} · {target.workspacePath}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {editor.loading ? (
            <div className="flex items-center gap-2 py-8 text-ui-sm text-foreground-subtle">
              <LoaderCircle className="size-4 animate-spin" />
              {text("checking")}
            </div>
          ) : null}
          {draft ? (
            <>
              <label className="block space-y-2 text-ui-sm">
                <span>{text("name")}</span>
                <div className="relative">
                  <Folder className="absolute left-3 top-3 size-4 text-foreground-subtle" />
                  <Input
                    autoFocus
                    className="pl-10"
                    size="lg"
                    value={draft.name}
                    maxLength={100}
                    disabled={editor.saving}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
              </label>
              <Tabs value={folderTab} onValueChange={setFolderTab} className="min-w-0 gap-3">
                <TabsList className="w-full" aria-label={text("folders")}>
                  <TabsTrigger value="folders" disabled={busy}>
                    {text("folders")}
                  </TabsTrigger>
                  <TabsTrigger value="projects" disabled={busy || !editor.ready}>
                    {text("fromProject")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="folders" className="min-w-0 space-y-3">
                  <ProjectSourceFolders
                    members={members}
                    primaryPath={draft.primaryFolderPath}
                    primaryLocked
                    disabled={busy}
                    checking={busy && !editor.saving}
                    remote={remote}
                    ready={editor.ready}
                    errors={editor.folderErrors}
                    dragging={drop.dragging}
                    canDrop={drop.canDrop}
                    onAdd={() => void add()}
                    onChange={(next) =>
                      setMembers(members.map((member) => (member.id === next.id ? next : member)))
                    }
                    onRemove={(id) => setMembers(members.filter((member) => member.id !== id))}
                    onMove={(index, delta) => {
                      const moved = [...members];
                      const [member] = moved.splice(index, 1);
                      moved.splice(index + delta, 0, member!);
                      setMembers(moved);
                    }}
                  />
                  {browsing ? (
                    <div className="max-h-80 space-y-3 overflow-y-auto rounded-xl border border-border p-3">
                      {/* 中文依据：嵌入式浏览器只报告成功浏览的路径，由本编辑器显式确认，不能把未读取的输入路径当成已选择目录。 */}
                      <DirectoryBrowser
                        services={editor.services}
                        embedded
                        onPathChange={setBrowserPath}
                        onCancel={() => setBrowsing(false)}
                        onSelect={() => {}}
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setBrowsing(false)}>
                          {sidebar("cancel")}
                        </Button>
                        <Button
                          disabled={!browserPath || editor.checking}
                          onClick={() => {
                            setBrowsing(false);
                            void editor.addFolder(browserPath);
                          }}
                        >
                          {text("chooseFolder")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </TabsContent>
                <TabsContent value="projects" className="min-w-0">
                  <div className="h-48 space-y-1 overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-2">
                    {availableFolders.length ? (
                      availableFolders.map(({ projectId, name, path }) => (
                        <Button
                          key={`${projectId}:${path}`}
                          variant="ghost"
                          className="h-auto w-full justify-start py-2 text-left"
                          disabled={
                            busy ||
                            !editor.ready ||
                            draft.sourceFolderPaths.some((existing) =>
                              isSameLocalProjectPath(existing, path),
                            )
                          }
                          onClick={async () => {
                            // 中文依据：目录校验由同一草稿 owner 完成，成功后才切回设置页；失败不隐藏错误或丢失已有草稿。
                            if (await editor.addFolder(path)) setFolderTab("folders");
                          }}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{name}</span>
                            <span className="block truncate text-ui-sm text-foreground-subtle">
                              {path}
                            </span>
                          </span>
                        </Button>
                      ))
                    ) : (
                      <p className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
                        {text("noAvailableFolders")}
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
              <p className="rounded-lg bg-surface p-3 text-ui-sm text-foreground-subtle">
                {text("scopeHint")}
              </p>
            </>
          ) : null}
          {editor.error ? (
            <div
              className="space-y-2 rounded-lg border border-border bg-surface p-3 text-ui-sm"
              role="alert"
            >
              <p className="whitespace-pre-wrap break-words">{editor.error}</p>
              {editor.latest ? (
                <div className="space-y-2" data-testid="project-conflict-latest">
                  <p>
                    {text("latest")}: {editor.latest.name} ·{" "}
                    {editor.latest.sourceFolderPaths.length} {text("affected")}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{editor.latest.description}</p>
                  <ul className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                    {[
                      ...(editor.latest.members ??
                        editor.latest.sourceFolderPaths.map((path) => ({
                          id: path,
                          path,
                          label: "",
                          role: "",
                          description: "",
                          enabled: true,
                        }))),
                    ]
                      .sort(
                        (a, b) =>
                          (editor.latest!.memberOrder?.indexOf(a.id) ?? 0) -
                          (editor.latest!.memberOrder?.indexOf(b.id) ?? 0),
                      )
                      .map((member) => (
                        <li key={member.id} className="space-y-1 break-words">
                          <p className="font-medium">
                            {member.path.split(/[\\/]/).filter(Boolean).at(-1)}
                          </p>
                          <p className="break-all text-foreground-subtle">{member.path}</p>
                          {member.description || member.role ? (
                            <p className="whitespace-pre-wrap">
                              {formatProjectMemberPurpose(member, roleText)}
                            </p>
                          ) : null}
                          <p className="text-foreground-subtle">
                            {text("defaultMember")} ·{" "}
                            {text(member.enabled ? "included" : "excluded")}
                          </p>
                        </li>
                      ))}
                  </ul>
                  {editor.latest.id === draft?.id ? (
                    <Button variant="outline" size="sm" onClick={editor.reviewLatest}>
                      {sidebar("reviewLatest")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        organization.editProject({
                          ...target,
                          localProjectId: editor.latest!.id,
                          label: editor.latest!.name,
                        })
                      }
                    >
                      {text("editExisting")}
                    </Button>
                  )}
                </div>
              ) : editor.latest === null ? (
                <p>{text("missing")}</p>
              ) : !draft ? (
                <Button variant="outline" onClick={() => void editor.load()}>
                  {text("reload")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
        <ProjectEditorFooter
          saving={editor.saving}
          canSave={Boolean(
            draft?.name.trim() &&
            draft.members?.some((member) => member.enabled) &&
            editor.changed &&
            !busy &&
            editor.latest === undefined,
          )}
          onCancel={close}
          onSave={() => void editor.save()}
        />
      </ProjectDialogContent>
    </Dialog>
  );
}
