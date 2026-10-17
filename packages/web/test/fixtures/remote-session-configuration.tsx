import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@lcode/services";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  type AppSettings,
  type RemoteTarget,
} from "@lcode/shared";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  registerRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";
import { SessionConfigurationSection } from "@/settings/SessionConfigurationSection.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { shouldDeferDraftRuntime } from "@/v4/composer/draftRuntimeStartupPolicy.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { applyTheme } from "@/useTheme.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const english = new URLSearchParams(location.search).has("english");
const locale = english ? "en-US" : "zh-CN";
applyTheme(english ? "zai-dark" : "zai-light");
const path = "/fixture/repo";
const targets: Record<string, RemoteTarget> = {
  ssh: { kind: "ssh", host: "fixture.invalid", username: "fixture", sshConfigAlias: "Fixture SSH" },
  wsl: { kind: "wsl", distro: "Fixture WSL" },
  docker: { kind: "docker", container: "fixture-container" },
};
const identity = (kind: string) => buildRemoteWorkspaceIdentity(path, targets[kind]);
const storageKey = "remote-session-configuration-fixture";
const initial = appSettingsSchema.parse({
  locale,
  localePreference: locale,
  recentProjects: [path],
  localProjects: [
    { id: "local", name: "Local Project", primaryFolderPath: path, sourceFolderPaths: [path] },
  ],
  lastWorkspaceSession: ["ssh", "docker"].map((kind) => ({
    kind: "remote",
    workspacePath: path,
    target: targets[kind],
    lastOpenedAt: 1,
    lastConnectionStatus: "failed",
  })),
  projectExecutionPreferences: { [identity("ssh")]: { setupCommands: ["fixture-setup"] } },
});
const settingsListeners = new Set<() => void>();
const modelListeners = new Map<string, Set<(view: ModelSelectionView) => void>>();
const views = new Map<string, ModelSelectionView>();
const counts = {
  reads: 0,
  modelReads: {} as Record<string, number>,
  connects: 0,
  disposes: 0,
  presentations: 0,
  prewarms: 0,
};
const fixture = {
  settings: JSON.parse(localStorage.getItem(storageKey) || "null") || initial,
  writes: [] as Partial<AppSettings>[],
  counts,
  pending: false,
  holdNext: false,
  failed: false,
  release: () => {},
  attach: (_kind: string) => {},
  detach: (_kind: string) => {},
  preview: (_kind: string) => {},
  removeModel: (_kind: string) => {},
  modelSubscriptions: () =>
    Object.fromEntries([...modelListeners].map(([owner, values]) => [owner, values.size])),
};
// 与 Desktop 的 remote accessor 一致：配置 owner 共享，模型目录属于目标 Environment。
const settingService = {
  get: async () => {
    counts.reads++;
    return structuredClone(fixture.settings);
  },
  update: async (patch: Partial<AppSettings>) => {
    fixture.writes.push(structuredClone(patch));
    if (fixture.holdNext) {
      fixture.holdNext = false;
      fixture.pending = true;
      await new Promise<void>((resolve) => {
        fixture.release = resolve;
      });
      fixture.pending = false;
      fixture.failed = true;
      throw new Error("old-generation-save-failed");
    }
    const current = fixture.settings;
    fixture.settings = appSettingsSchema.parse({
      ...current,
      ...patch,
      projectExecutionPreferences: Object.fromEntries(
        Object.entries({
          ...current.projectExecutionPreferences,
          ...patch.projectExecutionPreferences,
        }).map(([key, value]) => [
          key,
          { ...current.projectExecutionPreferences?.[key], ...value },
        ]),
      ),
    });
    localStorage.setItem(storageKey, JSON.stringify(fixture.settings));
    for (const listener of settingsListeners) listener();
  },
};
function createServices(kind: string, generation = 0): IServiceAccessor {
  const owner = `${kind}:${generation}`;
  const view = {
    revision: 1,
    providers: ["oauth", "api"].map((access) => ({
      providerId: `${kind}-${access}`,
      providerName: `${kind.toUpperCase()} ${access.toUpperCase()}`,
      config: { access: { type: access === "oauth" ? "oauth-account" : "api-key" } },
      models: [
        {
          modelId: `${kind}-${access}-model`,
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"], map: "{}" },
              speed: { values: ["standard", "fast"], map: "{}" },
            },
          },
        },
      ],
    })),
  } as unknown as ModelSelectionView;
  views.set(kind, view);
  const listeners = new Set<(value: ModelSelectionView) => void>();
  modelListeners.set(owner, listeners);
  return {
    settingService,
    modelSelectionService: {
      getView: async (input?: { selection: unknown }) => {
        counts.modelReads[kind] = (counts.modelReads[kind] || 0) + 1;
        return { ...views.get(kind), effectiveSelection: input?.selection ?? null };
      },
      onDidChange: (listener: (value: ModelSelectionView) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    worktreeService: { list: async () => [] },
    lcodeSessionService: {
      readWorkspacePresentation: async () => {
        counts.presentations++;
        return { mode: "build", slashCommands: [] };
      },
    },
    lcodeAgentService: {},
    broadcastService: { onMessage: () => ({ dispose() {} }), send: async () => {} },
  } as unknown as IServiceAccessor;
}
const base = createServices("local");
const generations = new Map<string, number>();
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(base);
fixture.attach = (kind) => {
  const generation = (generations.get(kind) ?? -1) + 1;
  generations.set(kind, generation);
  const sessionId = `attachment-${kind}`;
  registerRemoteWorkspaceSession({
    sessionId,
    workspacePath: path,
    workspaceIdentity: identity(kind),
    target: targets[kind],
    services: createServices(kind, generation),
  });
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(identity(kind), sessionId);
};
fixture.detach = (kind) =>
  useRemoteWorkspaceSessionStore.getState().unregisterSession(`attachment-${kind}`);
fixture.removeModel = (kind) => {
  const old = views.get(kind)!;
  const next = {
    ...old,
    revision: old.revision + 1,
    providers: old.providers.filter((item) => item.providerId !== `${kind}-api`),
  };
  views.set(kind, next);
  for (const [owner, listeners] of modelListeners)
    if (owner.startsWith(`${kind}:`)) for (const listener of listeners) listener(next);
};
fixture.attach("wsl");
Object.assign(window, { __remoteSessionConfiguration: fixture });
const tabs: WorkspaceTabState[] = [
  { id: "local", kind: "workspace", label: "Local Project", workspacePath: path },
];

function Preview({ kind }: { kind: string }) {
  const target = useWorkspaceServicesResolution(path, undefined, identity(kind), targets[kind]);
  return target.rpcReady ? (
    <ServiceProvider services={target.services}>
      <DraftProbe key={kind} kind={kind} />
    </ServiceProvider>
  ) : null;
}
function DraftProbe({ kind }: { kind: string }) {
  const { modelSelectionService } = useServices();
  const control = useDraftConfigControl({
    workspacePath: path,
    workspaceIdentity: identity(kind),
    sessionId: null,
    sessionConfig: null,
    agentStartupAllowed: true,
    modelSelectionService,
  });
  Object.assign(fixture, { requestCatalog: () => control.updateComposerContent({ text: "/" }) });
  useDraftSessionPrewarm({
    enabled: !shouldDeferDraftRuntime(null, identity(kind)),
    workspaceKey: identity(kind),
    paneId: "memory-regression",
    invalidationVersion: 0,
    transportIdentity: modelSelectionService,
    resolveInitialConfig: control.resolveInitialDraftConfig,
    dispatchCommand: async () => {
      counts.prewarms++;
      throw new Error("draft-must-not-prewarm");
    },
  });
  return (
    <pre data-testid="remote-draft-probe">
      {JSON.stringify({
        kind,
        submission: createComposerSubmissionConfig(control.draftConfig, control.modelCatalogView),
      })}
    </pre>
  );
}
function Page() {
  const [preview, setPreview] = useState<string | null>(null);
  fixture.preview = setPreview;
  return (
    <PlatformProvider
      platform={{
        ...platform,
        connectRemote: async () => {
          counts.connects++;
          throw new Error("configuration-must-not-connect");
        },
        disposeRemoteSession: async () => {
          counts.disposes++;
        },
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
                <SessionConfigurationSection workspaceTabs={tabs} />
                {preview ? <Preview kind={preview} /> : null}
              </main>
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Page />);
