import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings } from "@lcode/shared";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { StoreProvider, useLCodeStore } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { platform } from "./git-backup-platform.js";
import { services as defaults } from "./sidebar-file-tree-service.js";
import { createSidebarProjectCommands } from "./sidebar-project-service.js";
import {
  ProjectCreationControls,
  createProjectCreationFixture,
} from "./project-creation-controls.js";
import "@/styles.css";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";

const params = new URLSearchParams(location.search);
const settings: Partial<AppSettings> = JSON.parse(
  localStorage.getItem("sidebar-fixture-projects") || "null",
) ?? {
  localProjects: [
    {
      id: "initial",
      name: "网站项目",
      primaryFolderPath: "/fixture/repo",
      sourceFolderPaths: ["/fixture/repo"],
    },
  ],
};
const calls: Array<{ method: string; params: unknown }> = [];
const dragCalls = { react: 0, document: 0 };
document.addEventListener("drop", () => {
  dragCalls.document++;
});
const creation = createProjectCreationFixture(createSidebarProjectCommands(settings, calls));
const services = {
  ...defaults,
  settingService: {
    ...defaults.settingService,
    get: async () => ({ ...(await defaults.settingService.get()), ...settings }),
    mutateProject: creation.mutateProject,
  },
  fileService: {
    ...defaults.fileService,
    stat: async ({ path }: { path: string }) => ({
      type: path.endsWith(".txt") ? ("file" as const) : ("directory" as const),
    }),
  },
};
Object.assign(globalThis, {
  __sidebarOrganization: { settings: () => settings, dragCalls, ...creation.controls },
});
const theme = params.get("theme") || "zai-dark";
document.documentElement.classList.toggle("dark", theme === "zai-dark");
document.documentElement.classList.add(`theme-${theme}`);
const noop = () => {};
function Fixture() {
  const api = useTabStoreApi();
  const [ready, setReady] = useState(false);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const drag = usePromptEditorDragState({
    enableWorkspaceFileDrop: true,
    enableExternalFileDrop: true,
  });
  useEffect(() => {
    setTheme(theme as never);
    const tabs = (settings.localProjects ?? []).map((project) => ({
      id: project.id,
      kind: "workspace" as const,
      workspacePath: project.primaryFolderPath,
      localProjectId: project.id,
      label: project.name,
    }));
    api.setState({ tabs, activeTabId: tabs[0]?.id, activeWorkspacePath: tabs[0]?.workspacePath });
    setReady(true);
  }, [api, setTheme]);
  return (
    <main
      className="flex h-dvh bg-background text-foreground"
      onDragOver={() => {
        dragCalls.react++;
      }}
      onDrop={() => {
        dragCalls.react++;
      }}
    >
      <output className="fixed right-4 top-4" data-testid="background-drag-state">
        {drag.externalFileDragging ? "active" : "inactive"}
      </output>
      <ProjectCreationControls />
      <div className="w-80 max-w-full bg-sidebar">
        {ready ? (
          <WorkspaceSidebar
            workspacePath="/fixture/repo"
            theme={theme as never}
            onSelectTask={noop}
            onStartDraftInWorkspace={noop}
            onCreateTask={noop}
            onCreateConversationTask={noop}
            onOpenFolderFromWorkspaceMenu={noop}
            onConnectRemote={async () => undefined}
            onSelectRemoteProject={async () => {}}
            onCancelRemoteProject={async () => {}}
            onReconnectRemoteWorkspace={async () => {}}
            onOpenRemoteWorkspace={noop}
            reconnectingRemoteWorkspaceKeys={[]}
            remoteWorkspaceErrorByWorkspaceKey={{}}
            onOpenCommandCenter={noop}
            hideTopSpacer
          />
        ) : null}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider
    platform={{
      ...platform,
      canSelectFilePath: true,
      selectDirectory: creation.selectDirectory,
      selectDirectories: creation.selectDirectories,
      getPathForFile: (file) => `/fixture/${file.name}`,
    }}
  >
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={services.broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
              <ConfirmDialogHost />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
