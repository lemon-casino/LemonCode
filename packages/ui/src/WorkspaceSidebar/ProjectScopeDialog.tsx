import { Folder, Layers, LoaderCircle } from "lucide-react";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { useProjectScopeInspection } from "@/hooks/useProjectScopeInspection.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { useSidebarText } from "./sidebarText.js";
import { formatProjectMemberPurpose, useProjectRoleText } from "./projectEditorText.js";
export function ProjectScopeDialog() {
  const organization = useSidebarOrganization()!;
  const state = useProjectScopeInspection(organization.scopeTarget!);
  const text = useSidebarText(),
    platform = usePlatform();
  const context = state.context;
  const roleText = useProjectRoleText();
  const copy = async () => {
    try {
      if (!platform.writeClipboardText) throw new Error(text("unavailable"));
      await platform.writeClipboardText(JSON.stringify(context, null, 2));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) organization.inspectScope(null);
      }}
    >
      <DialogContent
        className="flex max-w-xl flex-col max-sm:inset-0 max-sm:max-h-dvh max-sm:translate-0 max-sm:rounded-none"
        data-testid="project-scope-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="size-5" />
            {text("inspectScope")}
          </DialogTitle>
          <DialogDescription>{text("scopeFrozenHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {state.loading ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : state.error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {state.error}
            </p>
          ) : context ? (
            <>
              <div className="rounded-lg bg-surface p-3">
                <p className="text-ui-base font-medium">
                  {context.name} · v{context.revision}
                </p>
                <p className="whitespace-pre-wrap text-ui-sm text-foreground-subtle">
                  {context.description}
                </p>
              </div>
              {context.executionSetId ? (
                <p
                  className="text-ui-sm text-foreground-subtle"
                  data-testid="execution-set-shared-hint"
                >
                  {text("executionSetSharedHint")}
                </p>
              ) : null}
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {context.members.map((member) => (
                  <div key={member.memberId} className="space-y-1 p-3">
                    <p className="flex items-center gap-2 text-ui-sm font-medium">
                      <Folder className="size-4 shrink-0" />
                      {member.sourcePath.split(/[\\/]/).filter(Boolean).at(-1)}
                    </p>
                    <p className="break-all font-mono text-ui-sm">{member.workspacePath}</p>
                    {member.sourcePath !== member.workspacePath ? (
                      <p className="break-all text-ui-xs text-foreground-subtlest">
                        {member.sourcePath}
                      </p>
                    ) : null}
                    <p className="whitespace-pre-wrap text-ui-sm text-foreground-subtle">
                      {formatProjectMemberPurpose(member, roleText)}
                    </p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-ui-sm text-foreground-subtle">{text("scopeUnavailable")}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={!context} onClick={() => void copy()}>
            {text("copyInfo")}
          </Button>
          <Button onClick={() => organization.inspectScope(null)}>{text("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
