import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme } from "@lcode/ui/useTheme";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { SavedWorkflowsSection } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { SavedWorkflowListCardFixture } from "./saved-workflow-list-card.js";
import {
  releaseOldEmptyResults,
  selectScenario,
  services,
  workspacePath,
  type ListScenario,
} from "./saved-workflow-list-service.js";
import "@lcode/ui/styles.css";

function Fixture() {
  const { locale, setLocale } = useLCodeIntl();
  const tabs = useTabStoreApi();
  const [ready, setReady] = useState(false);
  const [scenario, setScenario] = useState<ListScenario>("error");
  const [dark, setDark] = useState(false);
  const [released, setReleased] = useState(0);
  useEffect(() => {
    tabs.getState().addTab(workspacePath);
    setReady(true);
  }, [tabs]);
  const control = "rounded-lg border border-border bg-input px-2 py-1 text-ui-sm";
  return (
    <main className="h-full overflow-auto bg-background p-4 text-ui-base text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <h1 className="text-ui-xl font-semibold">工作流模板列表回归场景</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className={control}
            type="button"
            onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
          >
            {locale}
          </button>
          <button
            className={control}
            type="button"
            onClick={() => {
              const next = !dark;
              setDark(next);
              applyTheme(next ? "zai-dark" : "zai-light");
            }}
          >
            {dark ? "Light" : "Dark"}
          </button>
          <label className="text-ui-sm">
            管理页响应{" "}
            <select
              aria-label="管理页响应"
              value={scenario}
              className={control}
              onChange={(event) => {
                const next = event.target.value as ListScenario;
                selectScenario(next);
                setScenario(next);
              }}
            >
              {["error", "empty", "invalid", "success", "pending"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            className={control}
            type="button"
            onClick={() => setReleased(releaseOldEmptyResults())}
          >
            返回旧空结果
          </button>
          <output aria-label="旧请求数">{released}</output>
        </div>
        <p className="text-ui-sm text-foreground-subtle">
          选择下一次服务响应后，点击管理页的刷新。pending 保持请求等待；返回旧空结果可检查刷新乱序。
        </p>
        <SavedWorkflowListCardFixture />
        <section aria-label="模板管理页" className="min-w-0 rounded-xl border border-border">
          {ready ? <SavedWorkflowsSection workspacePath={workspacePath} /> : null}
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!, {
  onUncaughtError(error) {
    const notice = document.getElementById("fixture-error")!;
    notice.hidden = false;
    notice.textContent =
      error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  },
}).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </TabStoreProvider>
    </ServiceProvider>
  </LCodeIntlProvider>,
);
