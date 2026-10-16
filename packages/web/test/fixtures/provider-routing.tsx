import { createRoot } from "react-dom/client";
import type { ProviderSettingsView, IServiceAccessor } from "@lcode/services";
import {
  setApiKeyRoutingMetadataSchema,
  type ApiKeyRoutingMetadata,
  type ApiKeyRoutingPage,
} from "@lcode/shared";
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
  policy: undefined as ProviderRoutingPolicy | null | undefined,
  saves: 0,
  metadataSaves: 0,
  lastMetadata: undefined as unknown,
  pageReads: 0,
  attempts: [] as { expected: number; actual: number }[],
  bumpRevision: () => {},
};
Object.assign(window, { __routingFixture: fixture });
const routingKeys = Array.from({ length: 300 }, (_, i) => ({
  id: `key-${i}`,
  routing: undefined as ApiKeyRoutingMetadata | undefined,
}));
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
        access: { type: "api-key", apiKey: "synthetic-fixture" },
      },
      issues: [],
      models: [],
    },
  ],
});
fixture.bumpRevision = () => {
  revision++;
  const next = view();
  for (const listener of listeners) listener(next);
};
const services = {
  providerSettingsService: {
    readApiKeyRoutingPage: async (input: {
      offset?: number;
      limit?: number;
      expectedRevision?: number;
    }): Promise<ApiKeyRoutingPage> => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision)
        throw new Error("policy-conflict");
      fixture.pageReads++;
      const offset = input.offset ?? 0,
        limit = input.limit ?? 25;
      return {
        source: "configuration",
        revision,
        total: routingKeys.length,
        offset,
        nextOffset: offset + limit < routingKeys.length ? offset + limit : undefined,
        summary: {
          enabled: 300,
          sharedPools: new Set(
            routingKeys.flatMap((key) =>
              key.routing?.quotaPoolId ? [key.routing.quotaPoolId] : [],
            ),
          ).size,
          cacheGroups: new Set(
            routingKeys.flatMap((key) =>
              key.routing?.cacheGroupId ? [key.routing.cacheGroupId] : [],
            ),
          ).size,
        },
        rows: routingKeys
          .slice(offset, offset + limit)
          .map((key) => ({ ...key, enabled: true, issues: [] })),
      };
    },
    setApiKeyRoutingMetadata: async (raw: unknown) => {
      const input = setApiKeyRoutingMetadataSchema.parse(raw);
      if (input.expectedRevision !== revision) throw new Error("policy-conflict");
      for (const key of routingKeys) {
        if (input.target.type === "ids" && !input.target.keyIds.includes(key.id)) continue;
        if (input.patch === null) key.routing = undefined;
        else {
          const next = { ...key.routing } as Record<string, unknown>;
          for (const [field, value] of Object.entries(input.patch))
            if (value === null) delete next[field];
            else next[field] = value;
          key.routing = next as ApiKeyRoutingMetadata;
        }
      }
      fixture.lastMetadata = input;
      fixture.metadataSaves++;
      fixture.bumpRevision();
      return view();
    },
    getApiKeysJson: async () => {
      throw new Error("Batch routing must not load secret Keys");
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
