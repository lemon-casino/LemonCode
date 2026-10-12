import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import type {
  AppUsageRequest,
  IPlatformService,
  LCodeProvider,
  ProviderAccountQuota,
  ProviderAccountView,
  ProviderUsageRequest,
  ProviderUsageSnapshot,
} from "@lcode/shared";
import type { ContextTrend, ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { UsageStatsSection, type UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import { UsageStatsTabs } from "@/settings/usage-stats/UsageStatsTabs.js";
import { consumePendingSettingsUsageTab } from "@/lib/settingsNavigation.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { ReadOnlySessionTokenStats } from "@/v4/composer/ReadOnlySessionTokenStats.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import { LiveOutputRateRegistry } from "@/v4/composer/liveOutputRateRegistry.js";
import { applyTheme } from "@/useTheme.js";
import { first, second, now, view, snapshot } from "./usage-analytics-data.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
applyTheme(query.get("theme") === "light" ? "zai-light" : "zai-dark");
const fixture = {
  apiCalls: [] as AppUsageRequest[],
  lifetimeCalls: [] as ProviderUsageRequest[],
  last: null as ProviderUsageRequest | null,
  pending: false,
  release: () => {},
  switchSession: () => {},
  quotaCalls: [] as Array<{ id: string; force: boolean }>,
  holdNextQuota: false,
  quotaPending: false,
  releaseQuota: () => {},
  touchAccounts: () => {},
  removeProvider: (_channel: string) => {},
};
const accountListeners = new Set<(view: ProviderAccountView) => void>();
fixture.touchAccounts = () => {
  view.revision++;
  for (const listener of accountListeners) listener({ ...view });
};
fixture.removeProvider = (channel) => {
  view.accounts = view.accounts.filter((account) => account.channelId !== channel);
  fixture.touchAccounts();
};
Object.assign(window, { __analytics: fixture });
const services = {
  providerAccountService: {
    onDidChange: (listener: (view: ProviderAccountView) => void) => {
      accountListeners.add(listener);
      return { dispose: () => accountListeners.delete(listener) };
    },
    getView: async () => view,
    getQuota: async (id: string, force = false): Promise<ProviderAccountQuota> => {
      fixture.quotaCalls.push({ id, force });
      if (fixture.holdNextQuota) {
        fixture.holdNextQuota = false;
        fixture.quotaPending = true;
        await new Promise<void>((resolve) => {
          fixture.releaseQuota = () => {
            fixture.quotaPending = false;
            resolve();
          };
        });
      }
      if (query.get("scenario") === "quota-rich") {
        if (id === second)
          return {
            connectionId: id,
            source: "upstream",
            status: "unknown",
            stale: false,
            windows: [],
            plan: "Team plan",
            renewal: "off",
            planExpiresAt: new Date(now + 86400000).toISOString(),
          };
        const retries = fixture.quotaCalls.filter((call) => call.id === id && call.force).length;
        return {
          connectionId: id,
          source: "upstream",
          status: retries === 1 ? "error" : "ready",
          stale: retries === 1,
          partial: retries < 2,
          plan: "Pro plan",
          balance: "$12.50 USD",
          renewal: "auto",
          planExpiresAt: new Date(now + 86400000).toISOString(),
          checkedAt: new Date(now).toISOString(),
          windows: [
            {
              id: "credits",
              name: "Daily quota",
              remainingPercent: 75,
              usedPercent: 25,
              used: 10,
              remaining: 30,
              limit: 40,
              unit: "USD",
              display: "$30.00 remaining of $40.00",
              pool: "shared-pool",
              modelId: "long-model-name-for-mobile-window-readability",
              resetAt: new Date(now + 86400000).toISOString(),
            },
            {
              id: "tokens",
              name: "Daily quota",
              remaining: 0,
              unit: "tokens",
              pool: "model-pool",
              modelId: "model-b",
            },
            {
              id: "count",
              name: "Request count",
              used: 0,
              unit: "requests",
              expiresAt: new Date(now + 3600000).toISOString(),
            },
          ],
        };
      }
      return {
        connectionId: id,
        source: "upstream",
        status: id === first ? (force ? "error" : "ready") : "unsupported",
        stale: Boolean(force),
        checkedAt: new Date(now).toISOString(),
        windows:
          id === first
            ? [
                {
                  id: "daily",
                  name: "Daily quota",
                  remainingPercent: 75,
                  resetAt: new Date(now + 86400000).toISOString(),
                },
              ]
            : [],
      };
    },
  },
  usageStatsService: {
    getProviderUsageSnapshot: async (request: ProviderUsageRequest) => {
      if (request.range === "all") fixture.lifetimeCalls.push(request);
      if (request.limit !== 1) fixture.last = request;
      if (query.get("scenario") === "unavailable") throw new Error("no_active_workspace");
      if (query.get("scenario") === "quota-refresh")
        return await new Promise<ProviderUsageSnapshot>(() => {});
      if (query.get("scenario") === "deferred" && request.providerId === "oauth:codex") {
        fixture.pending = true;
        return await new Promise<ProviderUsageSnapshot>((resolve) => {
          fixture.release = () => {
            fixture.pending = false;
            resolve(snapshot(request));
          };
        });
      }
      const result = snapshot(request);
      const cacheCase = query.get("cache-write-case");
      if (cacheCase) {
        result.summary.cacheWriteTokens =
          cacheCase === "positive" || cacheCase === "partial" ? 30 : 0;
        result.summary.cacheWriteKnownRequests =
          cacheCase === "legacy"
            ? undefined
            : cacheCase === "unknown"
              ? 0
              : cacheCase === "partial"
                ? 1
                : result.summary.requestCount;
      }
      return result;
    },
    getAppUsageSnapshot: async (request: AppUsageRequest) => {
      fixture.apiCalls.push(request);
      throw new Error("fixture-app-empty");
    },
  },
} as unknown as IServiceAccessor;
const context = {
  layer: { liveOutputRates: new LiveOutputRateRegistry() },
} as unknown as V4ConversationContextValue;
const trend: ContextTrend = {
  truncated: true,
  samples: [
    {
      id: "a",
      timestamp: now - 3000,
      kind: "request",
      usedTokens: 8000,
      maxTokens: 16000,
      modelId: "old-model",
    },
    {
      id: "b",
      timestamp: now - 2000,
      kind: "compact",
      usedTokens: 2000,
      maxTokens: null,
      tokensBefore: 8000,
    },
    {
      id: "c",
      timestamp: now,
      kind: "request",
      usedTokens: 3000,
      maxTokens: 32000,
      modelId: "current-model",
    },
  ],
};
const child = {
  sessionId: "child",
  logEpoch: "child-epoch",
  control: { phase: "completedSuccess" },
  rows: { window: [] },
  usage: {
    contextWindow: null,
    cumulative: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    contextTrend: {
      truncated: false,
      samples: [
        {
          id: "child",
          timestamp: now,
          kind: "request",
          usedTokens: 100,
          maxTokens: 10000,
          modelId: "child-model",
        },
      ],
    },
  },
} as unknown as ConversationSnapshot;
function App() {
  const { intl, locale } = useLCodeIntl();
  const [activeTab, setTab] = useState<UsageStatsSectionTab>(() => {
    if (query.has("legacy-intent"))
      sessionStorage.setItem("lcode-settings-usage-tab-intent", "codingPlan");
    return consumePendingSettingsUsageTab() ?? "oauth";
  });
  const [currentTrend, setTrend] = useState(trend);
  fixture.switchSession = () =>
    setTrend({
      truncated: false,
      samples: [
        {
          id: "new",
          timestamp: now + 3000,
          kind: "request",
          usedTokens: 900,
          maxTokens: null,
          modelId: "new-model",
        },
      ],
    });
  return (
    <main className="h-full min-w-0 space-y-4 overflow-y-auto bg-background p-4 text-foreground">
      <div data-testid="main-context">
        <ChatContextUsage
          taskUsage={{ used: 3000, size: 32000 }}
          contextTrend={currentTrend}
          selectedProvider={{} as LCodeProvider}
          intl={intl}
          locale={locale}
        />
      </div>
      <ReadOnlySessionTokenStats snapshot={child} />
      <UsageStatsTabs activeTab={activeTab} onTabChange={setTab} />
      <UsageStatsSection activeTab={activeTab} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={{ openExternal: async () => {} } as unknown as IPlatformService}>
    <ServiceProvider services={services}>
      <LCodeIntlProvider initialLocale={query.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
        <TooltipProvider>
          <V4ConversationContext value={context}>
            <App />
          </V4ConversationContext>
        </TooltipProvider>
      </LCodeIntlProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
