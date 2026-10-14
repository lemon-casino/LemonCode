import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@lcode/services";
import { appSettingsSchema, type AppSettings } from "@lcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { SessionConfigurationSection } from "@/settings/SessionConfigurationSection.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { captureComposerRecentSubmission } from "@/lib/composerRecent.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { applyTheme } from "@/useTheme.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const locale = query.has("english") ? "en-US" : "zh-CN";
applyTheme(query.has("dark") ? "zai-dark" : "zai-light");
const initial = () =>
  appSettingsSchema.parse({
    locale,
    localePreference: locale,
    recentProjects: ["/fixture/repo"],
    localProjects: [
      {
        id: "project-one",
        name: "Project One",
        primaryFolderPath: "/fixture/repo",
        sourceFolderPaths: ["/fixture/repo"],
      },
      {
        id: "project-two",
        name: "Project Two",
        primaryFolderPath: "/fixture/other",
        sourceFolderPaths: ["/fixture/other"],
      },
    ],
    projectExecutionPreferences: { "/fixture/repo": { setupCommands: ["pnpm install"] } },
  });
const models = (id: string, speeds = true) => [
  {
    modelId: id,
    config: {
      optionSpecs: {
        reasoningLevel: { values: ["low", "high"], map: "{}" },
        ...(speeds ? { speed: { values: ["standard", "fast"], map: "{}" } } : {}),
      },
    },
  },
];
let view = {
  revision: 1,
  providers: [
    {
      providerId: "oauth-provider",
      providerName: "OAuth Provider",
      config: { access: { type: "oauth-account" } },
      models: models("oauth-model"),
    },
    {
      providerId: "host-fallback",
      providerName: "Host Fallback",
      config: { access: { type: "api-key" } },
      models: models("fallback-model"),
    },
    {
      providerId: "api-provider",
      providerName: "API Provider",
      config: { access: { type: "api-key" } },
      models: [...models("api-model"), ...models("basic-model", false)],
    },
    {
      providerId: "empty-provider",
      providerName: "Empty Provider",
      config: { access: { type: "api-key" } },
      models: [],
    },
  ],
} as unknown as ModelSelectionView;
const fixture = {
  calls: [] as Array<{ owner: string; patch: Partial<AppSettings> }>,
  fail: false,
  failedWrites: 0,
  hold: false,
  release: () => {},
  resetDraft: () => {},
  existing: () => {},
  selectManual: (_thought = "high") => {},
  selectModelManually: (_provider: string, _model: string) => {},
  typeDraft: (_text: string) => {},
  switchProject: (_path: string, _identity?: string) => {},
  holdRemoteRead: (_restore = true) => {},
  notifySettings: () => {},
  heldReads: new Set<string>(),
  pendingReads: new Set<string>(),
  releaseReads: new Map<string, () => void>(),
  removeProvider: () => {},
  removeDefault: () => {},
  removeRecentModel: () => {},
  seedRecent: () => {},
  disconnect: () => {},
  settings: {} as Record<string, AppSettings>,
};
const settingsListeners = new Set<() => void>();
const modelListeners = new Set<(value: ModelSelectionView) => void>();
function createServices(owner: string): IServiceAccessor {
  const storageKey = `session-configuration-fixture:${owner}`;
  fixture.settings[owner] = JSON.parse(localStorage.getItem(storageKey) || "null") || initial();
  return {
    settingService: {
      get: async () => {
        const snapshot = structuredClone(fixture.settings[owner]);
        if (fixture.heldReads.has(owner)) {
          fixture.pendingReads.add(owner);
          await new Promise<void>((resolve) => fixture.releaseReads.set(owner, resolve));
          fixture.pendingReads.delete(owner);
        }
        return snapshot;
      },
      update: async (patch: Partial<AppSettings>) => {
        fixture.calls.push({ owner, patch: structuredClone(patch) });
        if (fixture.hold)
          await new Promise<void>((resolve) => {
            fixture.release = resolve;
          });
        if (fixture.fail) {
          fixture.failedWrites += 1;
          throw new Error("fixture-save-failed");
        }
        const current = fixture.settings[owner];
        fixture.settings[owner] = appSettingsSchema.parse({
          ...current,
          ...patch,
          projectExecutionPreferences: Object.fromEntries(
            Object.entries({
              ...current.projectExecutionPreferences,
              ...patch.projectExecutionPreferences,
            }).map(([scope, preference]) => [
              scope,
              { ...current.projectExecutionPreferences?.[scope], ...preference },
            ]),
          ),
        });
        localStorage.setItem(storageKey, JSON.stringify(fixture.settings[owner]));
      },
    },
    modelSelectionService: {
      getView: async (input?: { selection: unknown }) => ({
        ...view,
        effectiveSelection: input?.selection ?? view.preferredSelection ?? null,
      }),
      onDidChange: (listener: (value: ModelSelectionView) => void) => {
        modelListeners.add(listener);
        return { dispose: () => modelListeners.delete(listener) };
      },
    },
    worktreeService: { list: async () => [] },
    lcodeSessionService: {},
    lcodeAgentService: {},
    broadcastService: { onMessage: () => ({ dispose() {} }), send: async () => {} },
  } as unknown as IServiceAccessor;
}
const base = createServices("local");
const remotes = useRemoteWorkspaceSessionStore.getState();
remotes.registerBaseServices(base);
remotes.registerSession({ sessionId: "attachment-a", services: createServices("remote-a") });
remotes.bindWorkspaceIdentity("remote-a", "attachment-a");
const tabs: WorkspaceTabState[] = [
  { id: "one", kind: "workspace", label: "Project One", workspacePath: "/fixture/repo" },
  {
    id: "remote-a",
    kind: "workspace",
    label: "Remote A",
    workspacePath: "/fixture/repo",
    workspaceIdentity: "remote-a",
    remoteSessionId: "attachment-a",
  },
  {
    id: "remote-b",
    kind: "workspace",
    label: "Remote B",
    workspacePath: "/fixture/repo",
    workspaceIdentity: "remote-b",
  },
];
fixture.disconnect = () =>
  useRemoteWorkspaceSessionStore.getState().unregisterSession("attachment-a");
fixture.removeProvider = () => {
  view = {
    ...view,
    providers: view.providers.filter((provider) => provider.providerId !== "api-provider"),
    revision: view.revision + 1,
  };
  for (const listener of modelListeners) listener(view);
};
const emitModels = () => {
  for (const listener of modelListeners) listener(view);
};
fixture.notifySettings = () => {
  for (const listener of settingsListeners) listener();
};
fixture.holdRemoteRead = (restore = true) => {
  const owner = "remote-cold";
  const services = createServices(owner);
  const modelSelection = {
    providerId: "api-provider",
    modelId: "api-model",
    options: { reasoningLevel: "low", speed: "standard" },
  };
  fixture.settings[owner].projectExecutionPreferences = {
    "remote-a": {
      defaultSessionModelSelection: modelSelection,
      defaultSessionApprovalMode: "edit",
    },
  };
  fixture.heldReads.add(owner);
  if (restore)
    persistV4ComposerDraft("/fixture/repo", "remote-a", V4_DRAFT_SCOPE_ROOT, {
      text: "",
      mode: "edit",
      modelSelection,
    });
  else clearV4ComposerDraft("/fixture/repo", "remote-a", V4_DRAFT_SCOPE_ROOT);
  useRemoteWorkspaceSessionStore
    .getState()
    .registerSession({ sessionId: "attachment-a", services });
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity("remote-a", "attachment-a");
};
fixture.seedRecent = () =>
  captureComposerRecentSubmission("/fixture/repo", {
    mode: "build",
    modelSelection: {
      providerId: "api-provider",
      modelId: "api-model",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  })();
fixture.removeDefault = () => {
  view = {
    ...view,
    providers: view.providers.filter((provider) => provider.providerId !== "oauth-provider"),
    revision: view.revision + 1,
  };
  emitModels();
};
fixture.removeRecentModel = () => {
  view = {
    ...view,
    providers: view.providers.map((provider) =>
      provider.providerId === "api-provider"
        ? { ...provider, models: provider.models.filter((model) => model.modelId !== "api-model") }
        : provider,
    ),
    revision: view.revision + 1,
  };
  emitModels();
};
Object.assign(window, { __sessionConfiguration: fixture });

type ProbeTarget = { workspacePath: string; workspaceIdentity?: string; sessionId: string | null };
function DraftProbeOwner() {
  const [target, setTarget] = useState<ProbeTarget>({
    workspacePath: "/fixture/repo",
    sessionId: null,
  });
  fixture.switchProject = (workspacePath, workspaceIdentity) =>
    setTarget({ workspacePath, workspaceIdentity, sessionId: null });
  const { services, rpcReady } = useWorkspaceServicesResolution(
    target.workspacePath,
    undefined,
    target.workspaceIdentity,
  );
  return rpcReady ? (
    <ServiceProvider services={services}>
      <DraftProbe
        target={target}
        onSessionChange={(sessionId) => setTarget({ ...target, sessionId })}
      />
    </ServiceProvider>
  ) : null;
}

function DraftProbe({
  target,
  onSessionChange,
}: {
  target: ProbeTarget;
  onSessionChange: (sessionId: string | null) => void;
}) {
  const [version, setVersion] = useState(0);
  const { workspacePath, workspaceIdentity, sessionId } = target;
  const { modelSelectionService } = useServices();
  const control = useDraftConfigControl({
    workspacePath,
    workspaceIdentity,
    sessionId,
    sessionConfig: sessionId
      ? {
          mode: "build",
          modelSelection: {
            providerId: "oauth-provider",
            modelId: "oauth-model",
            options: { reasoningLevel: "high", speed: "fast" },
          },
        }
      : null,
    agentStartupAllowed: false,
    modelSelectionService,
  });
  fixture.resetDraft = () => {
    clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
    control.replaceComposerDraft({ text: "" });
    onSessionChange(null);
    setVersion((value) => value + 1);
  };
  fixture.existing = () => {
    clearV4ComposerDraft(workspacePath, workspaceIdentity, "existing");
    onSessionChange("existing");
  };
  fixture.selectManual = (thought = "high") =>
    control.handleDraftSelectThought(thought, {
      provider: control.draftConfig.provider!,
      model: control.draftConfig.model!,
    });
  fixture.typeDraft = (text) => control.updateComposerContent({ text });
  fixture.selectModelManually = control.handleDraftSelectModel;
  return (
    <pre data-testid="draft-probe" className="whitespace-pre-wrap break-all text-ui-sm">
      {JSON.stringify({
        draft: control.draftConfig,
        composer: control.composerDraft,
        scope: target,
        catalogRevision: control.modelCatalogView?.revision,
        submission: createComposerSubmissionConfig(control.draftConfig, control.modelCatalogView),
        version,
      })}
    </pre>
  );
}
function FixturePage() {
  const [showProbe, setShowProbe] = useState(false);
  return (
    <PlatformProvider
      platform={{
        ...platform,
        onSettingsChanged: (listener) => {
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        },
      }}
    >
      <ServiceProvider services={base}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={locale}>
            <TooltipProvider>
              <main className="mx-auto h-screen max-w-4xl overflow-y-auto p-4">
                <h1 className="mb-4 text-ui-lg">{locale === "zh-CN" ? "配置" : "Configuration"}</h1>
                <SessionConfigurationSection workspaceTabs={tabs} />
                <button
                  data-testid="show-probe"
                  onClick={() => {
                    clearV4ComposerDraft("/fixture/repo", undefined, V4_DRAFT_SCOPE_ROOT);
                    setShowProbe(true);
                  }}
                  className="mt-4 text-ui-base"
                >
                  Open new session
                </button>
                {showProbe ? <DraftProbeOwner /> : null}
              </main>
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<FixturePage />);
