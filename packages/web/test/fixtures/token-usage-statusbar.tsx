/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings } from "@lcode/shared";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Button } from "@/components/ui/button.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import { TokenUsageStatusBarSection } from "@/settings/TokenUsageStatusBarSection.js";
import { TokenUsageStatusBar } from "@/v4/composer/TokenUsageStatusBar.js";
import { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { applyTheme, type Theme } from "@/useTheme.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  conversation,
  conversationContext,
  layer,
  modelView,
  noop,
  platform,
  selection,
  services,
  workspacePath,
} from "./mobile-layout-data.js";
import "@lcode/ui/styles.css";

// 只 mock 服务边界；UI、编辑器、设置保存、portal 和工具行全部使用生产组件。
const originalGet = services.settingService.get;
services.settingService.get = async () => ({
  ...(await originalGet()),
  ...JSON.parse(localStorage.getItem("fixture-token-settings") ?? "{}"),
});
const originalUpdate = services.settingService.update;
services.settingService.update = async (patch: Partial<AppSettings>) => {
  await originalUpdate(patch);
  localStorage.setItem("fixture-token-settings", JSON.stringify(await originalGet()));
};
const providerConnection = connectProviderSettingsSnapshot(services.providerSettingsService);
void providerConnection.ready;
type Scenario = "average" | "pending" | "live" | "other" | "empty" | "draft" | "first-request";
function makeSnapshot(scenario: Scenario, count = 13): ConversationSnapshot {
  const turnId = conversation.rows.window.at(-1)!.turnId;
  if (scenario === "empty" || scenario === "first-request") {
    const base = makeSnapshot("average");
    const started = scenario === "first-request";
    return {
      ...base,
      control: { ...base.control, phase: started ? "prewarming" : "draft", sessionEnded: false },
      rows: {
        window: started ? conversation.rows.window.slice(0, 1) : [],
        totalCount: started ? 1 : 0,
        firstRowId: started ? 1 : null,
      },
      usage: {
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextWindow: null,
      },
    };
  }
  return {
    ...conversation,
    sessionId:
      scenario === "draft"
        ? "draft-composer"
        : scenario === "other"
          ? "another-session"
          : conversation.sessionId,
    control: {
      ...conversation.control,
      phase: scenario === "average" ? "completedSuccess" : "running",
      canStop: scenario !== "average",
      stopState: scenario === "average" ? "idle" : "stoppable",
    },
    rows: {
      ...conversation.rows,
      window:
        scenario === "live"
          ? [
              {
                ...conversation.rows.window.at(-1)!,
                kind: "assistantText",
                state: "streaming",
                assistantResponseId: "response-live",
                text: "x".repeat(count * 3),
              } as ConversationSnapshot["rows"]["window"][number],
            ]
          : conversation.rows.window,
    },
    usage: {
      ...conversation.usage,
      cumulative:
        scenario === "other"
          ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
          : conversation.usage.cumulative,
      contextWindow: scenario === "other" ? null : conversation.usage.contextWindow,
      modelOutput: {
        turnId,
        activeRequestId: scenario === "average" ? null : "request-two",
        lastRequest:
          scenario === "other"
            ? null
            : { requestId: "request-one", outputTokens: 100, durationMs: 2000, completedAt: 100 },
      },
    },
  };
}
function App() {
  const [screen, setScreen] = useState("conversation");
  const { setLocale } = useLCodeIntl();
  const [snapshot, setSnapshot] = useState(() => makeSnapshot("average"));
  const [draft, setDraft] = useState<V4ComposerDraft>({
    text: "",
    mode: "build",
    modelSelection: selection,
    updatedAt: 1,
  });
  Object.assign(globalThis, {
    __tokenFixture: {
      locale: setLocale,
      theme: (theme: Theme) => applyTheme(theme),
      scenario: (scenario: Scenario) => {
        if (scenario === "live") layer.liveOutputRates.observe(makeSnapshot("live", 1), 1000);
        const next = makeSnapshot(scenario);
        layer.liveOutputRates.observe(next, 1600);
        setSnapshot(next);
      },
      nav: createSettingsPageConfig().settingsSectionGroups.map((group) => ({
        id: group.id,
        sections: group.sections.map((section) => section.id),
      })),
    },
  });
  return (
    <main className="mx-auto flex h-dvh w-full max-w-5xl flex-col gap-4 overflow-hidden p-3">
      <nav className="flex shrink-0 gap-2">
        <Button onClick={() => setScreen("conversation")}>Conversation view</Button>
        <Button onClick={() => setScreen("settings")}>Settings view</Button>
      </nav>
      <div
        data-testid="production-composer"
        hidden={screen !== "conversation"}
        className="shrink-0"
      >
        <ConversationComposer
          snapshot={snapshot}
          sessionId={snapshot.sessionId}
          draftMode={snapshot.sessionId === "draft-composer"}
          contextHeader={<span className="px-2 py-1 text-ui-base">Workspace · Branch</span>}
          composerDraft={draft}
          draftConfig={{ ...snapshot.config, modelSelection: draft.modelSelection }}
          updateComposerContent={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          replaceComposerDraft={(next) => setDraft({ ...next, updatedAt: 1 })}
          disabled={false}
          autoFocusEnabled={false}
          workspacePath={workspacePath}
          provider="glm"
          modelSelectionView={modelView}
          modelSelectionState={{ status: "ready", view: modelView }}
          attachmentSessionId={snapshot.sessionId}
          attachmentPut={conversationContext.attachmentPut}
          onSendText={async () => {}}
          onStop={noop}
          onSelectModel={noop}
          onSelectThought={noop}
          onSelectSpeed={noop}
          onSwitchMode={noop}
          listenAddToChatEvents={false}
        />
      </div>
      <div data-testid="subagents-sample" hidden={screen !== "conversation"} className="shrink-0">
        <TokenUsageStatusBar
          usage={snapshot.usage}
          childCount={2}
          childUsage={{ inputTokens: 300, outputTokens: 20, unknownCount: 1 }}
          childCurrentOutputTokens={12}
          childOutputSpeed={{ liveRate: 20, average: null, pending: true }}
        />
      </div>
      <section
        hidden={screen !== "settings"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <TokenUsageStatusBarSection />
      </section>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={services.broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale="zh-CN">
            <TooltipProvider>
              <V4ConversationContext value={conversationContext}>
                <App />
              </V4ConversationContext>
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    providerConnection.dispose();
    layer.dispose();
  });
