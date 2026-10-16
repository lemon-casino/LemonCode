import { createRoot } from "react-dom/client";
import type { ProviderSettingsView, IServiceAccessor } from "@lcode/services";
import type { ProviderRoutingPolicy } from "@lcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ProviderRoutingEditor } from "@/settings/ProviderRoutingEditor.js";
import { applyTheme } from "@/useTheme.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("lcode-locale-preference", params.get("locale") ?? "zh-CN");
applyTheme(params.get("theme") === "light" ? "zai-light" : "zai-dark");
const fixture = {
  policy: (params.get("seed") === "advanced"
    ? {
        version: 1,
        strategy: "reliable-first",
        maxInFlightPerCandidate: 7,
        cacheMode: "turn-only",
        order: ["key-2", "key-1"],
        weights: { "key-2": 3 },
        reserveRules: [{ resourceId: "fixture-window", mode: "hard", minRemainingPercent: 15 }],
      }
    : undefined) as ProviderRoutingPolicy | null | undefined,
  keyMetadata: {
    quotaPoolId: "existing-pool",
    cacheGroupId: "existing-cache",
    cacheTtlMs: 60000,
    weight: 3,
    priority: 1,
  },
  saves: 0,
  metadataSaves: 0,
  pageReads: 0,
  secretReads: 0,
  attempts: [] as { expected: number; actual: number }[],
  bumpRevision: () => {},
};
Object.assign(window, { __routingFixture: fixture });
let revision = 1;
const listeners = new Set<(view: ProviderSettingsView) => void>();
const view = (): ProviderSettingsView => ({
  revision,
  providerOrder: ["fixture"],
  providerTemplates: [],
  providers: [
    {
      providerId: "fixture",
      providerName: "Fixture",
      enabled: true,
      executable: true,
      effectiveConfig: {
        routing: fixture.policy,
        access: {
          type: "api-key",
          apiKey: params.get("seed") === "empty" ? "" : "synthetic-fixture",
        },
      },
      issues: [],
      models: [],
    },
  ],
});
fixture.bumpRevision = () => {
  revision++;
  for (const listener of listeners) listener(view());
};
const services = {
  providerSettingsService: {
    readApiKeyRoutingPage: async () => {
      fixture.pageReads++;
      throw new Error("Strategy settings must not read Key pages");
    },
    setApiKeyRoutingMetadata: async () => {
      fixture.metadataSaves++;
      throw new Error("Strategy settings must not rewrite Key metadata");
    },
    getApiKeysJson: async () => {
      fixture.secretReads++;
      throw new Error("Strategy settings must not read secret Keys");
    },
    getView: async () => view(),
    onDidChange: (listener: (view: ProviderSettingsView) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setProviderRouting: async (input: {
      expectedRevision: number;
      routing: ProviderRoutingPolicy | null;
    }) => {
      fixture.attempts.push({ expected: input.expectedRevision, actual: revision });
      if (input.expectedRevision !== revision) throw new Error("policy-conflict");
      fixture.policy = input.routing;
      fixture.saves++;
      revision++;
      const next = view();
      for (const listener of listeners) listener(next);
      return next;
    },
  },
} as unknown as IServiceAccessor;
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <LCodeIntlProvider>
      <main className="m-4 max-w-xl">
        <ProviderRoutingEditor providerId="fixture" />
      </main>
    </LCodeIntlProvider>
  </ServiceProvider>,
);
