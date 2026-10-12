import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import {
  appUsageSnapshotSchema,
  appUsageSummarySchema,
  type AppUsageRequest,
  type LCodeAutomation,
  type LCodeElicitationRequest,
  type LCodePermissionRequest,
} from "@lcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { GitGraphPane } from "@/git-graph/GitGraphPane.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { UsageStatsTabs } from "@/settings/usage-stats/UsageStatsTabs.js";
import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import type { UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import { applyTheme, THEME_OPTIONS, type Theme } from "@/useTheme.js";
import { platform, services as baseServices, workspacePath } from "./mobile-layout-data.js";
import "@lcode/ui/styles.css";

const query = new URLSearchParams(location.search);
const initialTheme =
  THEME_OPTIONS.find((option) => option.id === query.get("theme"))?.id ?? "zai-dark";
applyTheme(initialTheme);
const automation: LCodeAutomation = {
  automationId: "selection-fixture-automation",
  title: "Fixture scheduled task",
  cronExpr: "0 9 * * *",
  prompt: "Fixture prompt",
  workspaceKey: workspacePath,
  workspacePath,
  locationKind: "local",
  recurring: true,
  runCount: 0,
  enabled: true,
  lifecycleStatus: "active",
  dispatchStatus: "idle",
  dispatchAttempts: 0,
  createdAt: 1,
  updatedAt: 1,
};
const services = {
  ...baseServices,
  lcodeAgentService: {
    ...baseServices.lcodeAgentService,
    listAllAutomations: async () => [automation],
  },
  clientScenesService: { list: async () => ({ code: 0, msg: "", data: [] }) },
  codingPlanSubscriptionService: {
    getOffPeakClientConfig: async () => ({ enabled: true, codingPlanActive: false }),
  },
  offPeakTaskService: {
    list: async () => [],
    getCodingPlanSupport: async () => ({ supported: false }),
  },
  usageStatsService: {
    getAppUsageSnapshot: async ({ range }: AppUsageRequest) =>
      appUsageSnapshotSchema.parse({
        source: "agent-db",
        range,
        generatedAt: 1,
        timeZone: "UTC",
        summary: Object.fromEntries(
          Object.entries(appUsageSummarySchema.shape).map(([key, schema]) => [
            key,
            schema.isNullable() ? null : 0,
          ]),
        ),
        heatmap: {
          startDate: "2026-10-11",
          endDate: "2026-10-11",
          maxTokens: 0,
          weeks: [
            {
              weekIndex: 0,
              days: [
                { date: "2026-10-11", level: 0, totalTokens: 0, turnCount: 0, toolCallCount: 0 },
              ],
            },
          ],
        },
        dailyModelUsage: [],
        models: [],
        tools: [],
      }),
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  const [search, setSearch] = useState("");
  const [usage, setUsage] = useState<UsageStatsSectionTab>("app");
  const [history, setHistory] = useState("recent");
  const [answer, setAnswer] = useState<unknown>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>("fixture-commit");
  const request: LCodeElicitationRequest = {
    type: "elicitation_request",
    taskId: "selection-fixture-task",
    traceId: "selection-fixture-trace",
    requestId: "selection-fixture-question",
    header: "Coverage",
    message: "Which ecosystems should be supported?",
    multiSelect: !query.has("single"),
    options: [
      { value: "rust", label: "Rust + Node.js", description: "Cargo.toml and package.json" },
      { value: "java", label: "Java", description: "Maven and Gradle" },
      { value: "python", label: "Python", description: "pyproject.toml" },
    ],
  };
  return (
    <main className="h-full overflow-y-auto bg-background-win-alt p-4 text-ui-base text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <label>
          Theme
          <select
            aria-label="Fixture theme"
            value={theme}
            onChange={(event) => {
              const value = event.target.value as Theme;
              setTheme(value);
              applyTheme(value);
            }}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id}
              </option>
            ))}
          </select>
        </label>
        <section data-testid="selection-plugin" className="rounded-xl bg-background p-3">
          <PluginStoreListView
            items={[]}
            marketplaces={[]}
            loading={false}
            query={search}
            onQueryChange={setSearch}
            segment={segment}
            onSegmentChange={setSegment}
            onOpenManage={() => {}}
            actions={{
              onOpenDetail() {},
              onInstall() {},
              onUninstall() {},
              onUpdate() {},
              operationId: null,
              togglingPluginId: null,
            }}
          />
        </section>
        <section data-testid="selection-automation" className="rounded-xl bg-background">
          <AutomationsSection workspacePath={workspacePath} />
        </section>
        <section data-testid="selection-usage" className="rounded-xl bg-background p-3">
          <UsageStatsTabs activeTab={usage} onTabChange={setUsage} />
          <AppUsagePanel />
        </section>
        <section
          data-testid="selection-shared"
          className="flex flex-wrap gap-3 rounded-xl bg-popover p-3"
        >
          <SettingsSegmentedTabs
            value={history}
            onValueChange={setHistory}
            items={[
              { value: "recent", label: "Recent" },
              { value: "all", label: "All history" },
            ]}
          />
          <Checkbox aria-label="Shared checkbox" />
          <Input aria-label="Shared input" placeholder="Answer" />
          <Tabs defaultValue="one">
            <TabsList variant="line">
              <TabsTrigger value="one">Line one</TabsTrigger>
              <TabsTrigger value="two">Line two</TabsTrigger>
            </TabsList>
          </Tabs>
        </section>
        <section data-testid="selection-question">
          <ElicitationDialog
            request={request}
            onRespond={(_id, action, content) => setAnswer({ action, content })}
          />
          <output data-testid="selection-answer">{JSON.stringify(answer)}</output>
        </section>
        {query.has("extras") ? (
          <>
            <section data-testid="selection-git" className="h-64 overflow-hidden rounded-xl">
              <GitGraphPane
                commits={[
                  {
                    hash: "fixture-commit",
                    parents: [],
                    refs: [],
                    subject: "Fixture commit",
                    authorName: "Fixture",
                    authoredAtMs: 1,
                  },
                ]}
                selectedCommitHash={selectedCommit}
                onSelectCommit={setSelectedCommit}
              />
            </section>
            <section data-testid="selection-permission">
              <PermissionDialog
                workspacePath={workspacePath}
                request={
                  {
                    type: "permission_request",
                    taskId: "fixture-task",
                    traceId: "fixture-trace",
                    requestId: "fixture-permission",
                    description: "Fixture permission",
                    title: "Bash",
                    kind: "execute",
                    freeText: true,
                    options: [
                      {
                        optionId: "allow_once",
                        kind: "allowOnce",
                        name: "Allow once",
                        response: { decision: "allow" },
                      },
                      {
                        optionId: "deny_once",
                        kind: "rejectOnce",
                        name: "Deny once",
                        response: { decision: "deny" },
                      },
                    ],
                    raw: { toolName: "Bash", input: { command: "pwd" } },
                  } satisfies LCodePermissionRequest
                }
                onRespond={() => {}}
              />
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={services.broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={query.get("lang") === "en" ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
