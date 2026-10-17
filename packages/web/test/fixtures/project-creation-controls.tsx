import { useState } from "react";
import { ChatEmptyCreateProjectDialog } from "@/ChatEmptyCreateProjectDialog.js";
import { Button } from "@/components/ui/button.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import type { ProjectMutationRequest, ProjectMutationResult } from "@lcode/shared";

export function createProjectCreationFixture(
  mutate: (request: ProjectMutationRequest) => Promise<ProjectMutationResult>,
) {
  const folders = ["/fixture/frontend", "/fixture/backend"];
  let fail = false;
  let batch: string[] | undefined;
  return {
    selectDirectory: async () => folders.shift() ?? null,
    selectDirectories: async () => {
      if (batch) {
        const result = batch;
        batch = undefined;
        return result;
      }
      const path = folders.shift();
      return path ? [path] : [];
    },
    controls: {
      selectCreationBatch: (paths: string[]) => {
        batch = paths;
      },
      failNextProjectSave: () => {
        fail = true;
      },
      selectCreationFolders: (paths: string[]) => {
        folders.splice(0, folders.length, ...paths);
      },
    },
    mutateProject: async (request: ProjectMutationRequest) => {
      if (fail) {
        fail = false;
        throw new Error("Fixture save failed");
      }
      return mutate(request);
    },
  };
}

export function ProjectCreationControls() {
  const [open, setOpen] = useState(false);
  const services = useBaseWorkspaceServices();
  const platform = usePlatform();
  const { intl } = useLCodeIntl();
  const tabStoreApi = useTabStoreApi();
  const actions = useRootWorkspaceActions({
    intl,
    services,
    platform,
    tabStoreApi,
    addTab: tabStoreApi.getState().addTab,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    supportsSettings: true,
    allowOpenWorkspace: true,
    preferDirectoryBrowser: false,
    refreshProviderState: async () => {},
    updateAppSettings: async () => {},
    setOAuthError: () => {},
    setUser: () => {},
  });
  return (
    <div className="fixed bottom-4 right-4">
      <Button onClick={() => setOpen(true)}>
        {intl.formatMessage({ id: "chat.empty.createProject.menu" })}
      </Button>
      <ChatEmptyCreateProjectDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={actions.handleCreateLocalProject}
      />
    </div>
  );
}
