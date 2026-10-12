import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@lcode/shared";
import type { IProviderAccountService } from "@lcode/services";
import {
  fixture,
  service,
  services,
  templates,
  navigationScenario,
  scrollScenario,
} from "./provider-accounts-service.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProviderTemplatePicker } from "@/settings/model-provider-section/ProviderTemplatePicker.js";
import { ModelProviderSectionDetail } from "@/settings/model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "@/settings/model-provider-section/SectionLayout.js";
import { useProviderDetailFeedback } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { useModelProviderNavigation } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useProviderAccountsDialog } from "@/hooks/useProviderAccountsDialog.js";
import { ProviderAccountsDialog } from "@/settings/model-provider-section/ProviderAccountsDialog.js";
import { applyTheme } from "@/useTheme.js";
import "@/styles.css";

applyTheme(
  new URLSearchParams(location.search).get("theme") === "light" ? "zai-light" : "zai-dark",
);

function FixtureNavigation() {
  const { intl } = useLCodeIntl();
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const providers = useModelProviders({ workspacePath: "/fixture/provider-accounts" });
  const { navigationGroups, selectedNavItem } = useModelProviderNavigation({
    modelProviders: providers.modelProviders,
    presetProviders: [],
    selectedNodeKey,
    setSelectedNodeKey,
    intl,
  });
  return (
    <ModelProviderSectionLayout
      description="Fixture model providers"
      refreshLabel="刷新"
      loadingLabel="加载中"
      addProviderLabel="添加供应商"
      onRefresh={() => {}}
      onAddProvider={() => {}}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      presetLoading={false}
      customLoading={providers.loading}
      onSelectNavItem={(item) => {
        setSelectedNodeKey(item.key);
      }}
    >
      <section className="min-w-0">
        {scrollScenario ? <FixtureFeedback /> : null}
        <output data-testid="fixture-has-personal-config">
          {String(providers.modelProviders[0]?.hasPersonalConfig)}
        </output>
        <ModelProviderSectionDetail
          selectedNavItem={selectedNavItem}
          presetLoading={false}
          presetSubscriptionProviderId={null}
          codingPlanStatusSyncProviderId={null}
          codingPlanDisconnectProviderId={null}
          onSave={providers.saveProvider}
          onAddPersonalModel={providers.addPersonalModel}
          onSavePersonalModelDraft={providers.savePersonalModelDraft}
          onSetPersonalModelEnabled={providers.setPersonalModelEnabled}
          onDeletePersonalModel={providers.deletePersonalModel}
          onListRemoteModels={providers.listRemoteModels}
          onDelete={async () => {}}
          onTestModel={providers.testModelConnectivity}
          onCodingPlanLogin={() => {}}
          onCodingPlanDisconnect={() => {}}
          onOpenApiKeyUrl={() => {}}
          onOpenBigModelRegistration={() => {}}
          onCodingPlanPurchaseComplete={() => {}}
          providerSettingsView={providers.providerSettingsView}
        />
      </section>
    </ModelProviderSectionLayout>
  );
}
function FixtureFeedback() {
  const { showFeedback } = useProviderDetailFeedback();
  return (
    <button
      type="button"
      onClick={() =>
        showFeedback({
          key: "scroll-fixture",
          message: "Fixture feedback",
          state: "success",
          durationMs: 0,
        })
      }
    >
      Show fixture feedback
    </button>
  );
}
function FixturePicker() {
  const dialog = useProviderAccountsDialog();
  return (
    <>
      <ProviderTemplatePicker
        templates={templates}
        creating={false}
        onBack={() => {}}
        onManageOAuthAccounts={dialog.openChannel}
        onCreateCustom={async (name) => {
          fixture.apiCreates.push(name);
        }}
        onCreateFromTemplate={async (id) => {
          fixture.apiCreates.push(id);
        }}
      />
      {dialog.selection ? (
        <ProviderAccountsDialog {...dialog.selection} onClose={dialog.close} />
      ) : null}
    </>
  );
}
function FixtureApp() {
  const [alternateHost, setAlternateHost] = useState(false);
  fixture.switchHost = () => setAlternateHost(true);
  const [alternateServices] = useState(() => ({
    ...services,
    providerAccountService: {
      ...service,
      startAuthorization: async (
        input: Parameters<IProviderAccountService["startAuthorization"]>[0],
      ) => {
        fixture.alternateHostReads++;
        return service.startAuthorization(input);
      },
    },
  }));
  return (
    <PlatformProvider
      platform={
        {
          openExternal: (url: string) => {
            fixture.opened.push(url);
          },
        } as IPlatformService
      }
    >
      <ServiceProvider services={alternateHost ? alternateServices : services}>
        <LCodeIntlProvider
          initialLocale={
            new URLSearchParams(location.search).get("locale") === "en-US" ? "en-US" : "zh-CN"
          }
        >
          <TooltipProvider>
            <div
              className="h-full overflow-y-auto bg-background text-foreground"
              data-testid="fixture-settings-scroll"
            >
              <main className="mx-auto max-w-4xl p-4">
                {navigationScenario ? <FixtureNavigation /> : <FixturePicker />}
              </main>
              {/* 留出真实外层可滚动空间，验证子栏滚到边界后不会继续带动设置页。 */}
              {scrollScenario ? <div className="h-screen" aria-hidden="true" /> : null}
            </div>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<FixtureApp />);
