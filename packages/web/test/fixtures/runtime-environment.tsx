import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useGitFailureDraftReceiver, useGitFailureHandoff } from "@/hooks/useGitFailureHandoff.js";
import { appendGitFailureDraft } from "@/git-action-menu/gitFailureDraft.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { RuntimeEnvironmentDetails } from "@/worktree/RuntimeEnvironmentDetails.js";
import { ProjectExecutionPolicySettings } from "@/worktree/ExecutionPolicySettings.js";
import { WorktreeTaskActions } from "@/worktree/WorktreeTaskActions.js";
import { createReviewWorkspaceFixture } from "./review-workspace-service.js";
import { createRuntimeEnvironmentFixture, origin } from "./runtime-environment-service.js";
import { createRuntimeCandidateFixture } from "./runtime-environment-candidate.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const { service, controller } = createRuntimeEnvironmentFixture(query.has("subdirectory"));
controller.unsupported = query.has("unsupported");
let settings: AppSettings = {};
const candidate = createRuntimeCandidateFixture(controller.calls);
const services = {
  runtimeEnvironmentService: service,
  settingService: {
    get: async () => structuredClone(settings),
    update: async (patch: Partial<AppSettings>) => {
      controller.calls.push({ method: "settings.update", params: patch });
      settings = {
        ...settings,
        ...patch,
        projectExecutionPreferences: {
          ...settings.projectExecutionPreferences,
          ...Object.fromEntries(
            Object.entries(patch.projectExecutionPreferences ?? {}).map(([key, value]) => [
              key,
              { ...settings.projectExecutionPreferences?.[key], ...value },
            ]),
          ),
        },
      };
    },
  },
  gitService: { ...createReviewWorkspaceFixture() },
  worktreeService: candidate.service,
} as unknown as IServiceAccessor;
const routing = useRemoteWorkspaceSessionStore.getState();
routing.registerBaseServices(services);
for (const identity of ["remote-a", "remote-b"]) {
  routing.registerSession({ sessionId: identity, services });
  routing.bindWorkspaceIdentity(identity, identity);
}
Object.assign(globalThis, {
  __runtimeFixture: controller,
  __candidateFixture: candidate.controller,
});

function Fixture() {
  const [detailsGeneration, setDetailsGeneration] = useState(0);
  const [, updateBinding] = useState(0);
  controller.remountDetails = () => setDetailsGeneration((value) => value + 1);
  const [identity, setIdentity] = useState<string | undefined>(
    query.has("remote") ? "remote-a" : undefined,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({
    local: "已有正文",
    "remote-a": "A原正文",
    "remote-b": "B原正文",
  });
  const [attachments] = useState(["原附件.png"]);
  const sessionId = query.has("existing") ? "fixture-session" : null;
  const scope = identity ?? "local";
  useGitFailureDraftReceiver(origin, identity, sessionId, (text) =>
    setDrafts((old) => ({ ...old, [scope]: appendGitFailureDraft(old[scope] ?? "", text) })),
  );
  const handoff = useGitFailureHandoff(origin, identity, sessionId ?? undefined);
  const [lateTransfer] = useState(() => handoff.transfer);
  controller.lateHandoff = () => lateTransfer("LATE-OLD-SCOPE");
  controller.chooseIdentity = setIdentity;
  controller.setConnected = (connected) => {
    const registry = useRemoteWorkspaceSessionStore.getState();
    if (connected) {
      registry.registerSession({ sessionId: "remote-a", services: { ...services } });
      registry.bindWorkspaceIdentity("remote-a", "remote-a");
    } else registry.unregisterSession("remote-a");
  };
  const binding = {
    ...controller.bindingFacts(),
    workspaceIdentity: identity,
    originalWorkspaceIdentity: identity,
    ...(query.has("legacy") ? { environmentRef: undefined } : {}),
  };
  return (
    <main className="w-full max-w-3xl space-y-4 p-4">
      <h1 className="text-ui-base">Runtime environment UI fixture</h1>
      <ProjectExecutionPolicySettings
        key={scope}
        workspacePath={origin}
        workspaceIdentity={identity}
      />
      <RuntimeEnvironmentDetails
        key={detailsGeneration}
        binding={binding}
        workspacePath={binding.originalWorkspacePath}
        workspaceIdentity={identity}
        sessionId={sessionId ?? undefined}
        onSettled={() => updateBinding((value) => value + 1)}
      />
      <label className="block text-ui-sm">
        Composer draft
        <textarea
          className="min-h-24 w-full rounded-lg border border-border p-2 text-mobile-input-safe"
          data-testid="runtime-draft"
          value={drafts[scope] ?? ""}
          onChange={(event) => setDrafts((old) => ({ ...old, [scope]: event.target.value }))}
        />
      </label>
      <p data-testid="runtime-attachments" className="text-ui-sm">
        {attachments.join(", ")}
      </p>
      <button
        type="button"
        onClick={() => controller.calls.push({ method: "send", params: drafts[scope] })}
      >
        Send
      </button>
      {query.has("candidate") ? (
        <WorktreeTaskActions
          workspacePath={origin}
          sessionId="fixture-session"
          busy={false}
          renderContent={(content) => <section data-testid="runtime-candidate">{content}</section>}
        />
      ) : null}
    </main>
  );
}
const fixturePlatform = {
  ...platform,
  openExternal: (url: string) => controller.calls.push({ method: "openExternal", params: url }),
};
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={fixturePlatform}>
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <LCodeIntlProvider initialLocale={query.has("english") ? "en-US" : "zh-CN"}>
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </LCodeIntlProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
