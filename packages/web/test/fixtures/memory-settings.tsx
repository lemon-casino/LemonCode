/// <reference types="vite/client" />
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Locale } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { MemorySettingsSectionController } from "@/settings/MemorySettingsSectionController.js";
import { applyTheme, THEME_OPTIONS, type Theme } from "@/useTheme.js";
import { memoryFixture } from "./memory-settings-service.js";
import "@lcode/ui/styles.css";

function ConcurrentReadProbe() {
  const { refresh } = useSettings();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="fixture-concurrent-refresh"
      onClick={async () => {
        setDone(false);
        await Promise.all([refresh({ afterPending: true }), refresh({ afterPending: true })]);
        setDone(true);
      }}
    >
      Concurrent refresh: {String(done)}
    </Button>
  );
}

function FixturePage() {
  const state = useSyncExternalStore(memoryFixture.subscribe, memoryFixture.snapshot);
  const [locale, setLocale] = useState<Locale>("zh-CN");
  const [theme, setTheme] = useState<Theme>("zai-dark");
  const [held, setHeld] = useState(false);
  const [available, setAvailable] = useState(true);
  const [mounted, setMounted] = useState(true);
  return (
    <PlatformProvider platform={memoryFixture.platform}>
      <ServiceProvider services={memoryFixture.services}>
        <LCodeIntlProvider initialLocale={locale} key={locale}>
          <TooltipProvider>
            <main className="fixture-page text-ui-base">
              <h1 className="text-ui-lg font-medium">Memory settings fixture</h1>
              <div className="fixture-controls" aria-label="Fixture controls">
                <label>
                  Language
                  <select
                    aria-label="Language"
                    value={locale}
                    onChange={(event) => setLocale(event.target.value as Locale)}
                  >
                    <option value="zh-CN">中文</option>
                    <option value="en-US">English</option>
                  </select>
                </label>
                <label>
                  Theme
                  <select
                    aria-label="Theme"
                    value={theme}
                    onChange={(event) => {
                      const next = event.target.value as Theme;
                      setTheme(next);
                      applyTheme(next);
                    }}
                  >
                    {THEME_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Catalog
                  <select
                    aria-label="Catalog"
                    value={state.catalog}
                    onChange={(event) =>
                      memoryFixture.setCatalog(event.target.value as typeof state.catalog)
                    }
                  >
                    <option value="ready">Ready</option>
                    <option value="empty">Empty</option>
                    <option value="error">Error</option>
                  </select>
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-hold"
                  onClick={() => {
                    const next = !held;
                    setHeld(next);
                    memoryFixture.setHeld(next);
                  }}
                >
                  Hold: {String(held)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-release"
                  disabled={!state.pending}
                  onClick={memoryFixture.release}
                >
                  Release
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-fail"
                  onClick={memoryFixture.failNext}
                >
                  Fail next copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-fail-sync"
                  onClick={memoryFixture.failSync}
                >
                  Fail next settings broadcast
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-fail-saved-read"
                  onClick={memoryFixture.failSavedReads}
                >
                  Fail saved settings reads
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-resume-read"
                  onClick={memoryFixture.resumeReads}
                >
                  Resume settings reads
                </Button>
                <ConcurrentReadProbe />
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-hold-read"
                  onClick={memoryFixture.holdRead}
                >
                  Hold next settings read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-release-read"
                  disabled={!state.pendingRead}
                  onClick={memoryFixture.releaseRead}
                >
                  Release settings read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-external-profile"
                  onClick={() => memoryFixture.externalLocation("profile")}
                >
                  External profile setting
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-other-window-workspace"
                  onClick={() => memoryFixture.commitOtherWindowLocation("workspace")}
                >
                  Other window commits workspace
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-settings-notification"
                  onClick={memoryFixture.notifySettingsChanged}
                >
                  Platform settings changed notification
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-unmount"
                  onClick={() => setMounted((value) => !value)}
                >
                  Mounted: {String(mounted)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="fixture-availability"
                  onClick={() => setAvailable((value) => !value)}
                >
                  Local desktop: {String(available)}
                </Button>
              </div>
              <div className="fixture-state" aria-label="Service state">
                <span data-testid="fixture-committed-location">{state.location}</span>
                <span data-testid="fixture-change-count">{state.calls}</span>
                <span data-testid="fixture-catalog-reads">{state.reads}</span>
                <span data-testid="fixture-settings-reads">{state.settingsReads}</span>
                <span data-testid="fixture-settings-syncs">{state.syncs}</span>
              </div>
              {mounted ? (
                <MemorySettingsSectionController
                  memoryEnabled={state.enabled}
                  memoryService={memoryFixture.memoryService}
                  onMemoryEnabledChange={memoryFixture.setEnabled}
                  onSessionRecallEnabledChange={async () => undefined}
                  projectMemoryViewerAvailable={available}
                  sessionRecallEnabled={false}
                />
              ) : null}
            </main>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root is missing");
createRoot(root).render(<FixturePage />);
