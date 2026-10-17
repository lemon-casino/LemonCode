import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { appSettingsSchema, type AppSettings, type IPlatformService } from "@lcode/shared";
import { ServiceProvider } from "../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.js";
import { LCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../ui/src/components/ui/tooltip.js";
import { StartupAnimationSettingsSection } from "../../ui/src/settings/StartupAnimationSettingsSection.js";
import { WallpaperSettingsSection } from "../../ui/src/settings/WallpaperSettingsSection.js";
import { WorkspaceShellSurface } from "../../ui/src/app-shell/WorkspaceShellSurface.js";
import {
  getBuiltinWallpaperUrl,
  getStartupAnimationPresets,
} from "../src/renderer/src/startup/media.js";
import { previewStartupAnimation } from "../src/renderer/src/startup/bridge.js";
import { mountStartupScenePreview } from "../src/renderer/src/startup/scene.js";
import { mountAemeathWallpaper } from "../src/renderer/src/startup/aemeathWallpaper.js";
import { validateStartupSceneMedia } from "../src/renderer/src/startup/sceneResource.js";
import { saveStartupSceneImage } from "../src/renderer/src/startup/sceneImages.js";
import "../../ui/src/styles.css";

let settings = appSettingsSchema.parse(
  JSON.parse(localStorage.getItem("startup-settings-fixture") ?? "{}"),
);
const services = {
  settingService: {
    get: async () => settings,
    update: async (patch: Partial<AppSettings>) => {
      if ((globalThis as typeof globalThis & { startupSettingsFail?: boolean }).startupSettingsFail)
        throw new Error("Simulated settings failure");
      settings = appSettingsSchema.parse({ ...settings, ...patch });
      localStorage.setItem("startup-settings-fixture", JSON.stringify(settings));
    },
  },
  broadcastService: { send: async () => {} },
} as unknown as IServiceAccessor;
const platform = {
  mountStartupScenePreview,
  mountAemeathWallpaper,
  validateStartupSceneMedia,
  saveStartupSceneImage,
  previewStartupAnimation,
  getBuiltinWallpaperUrl,
  getStartupAnimationPresets,
} as IPlatformService;
if (new URLSearchParams(location.search).get("web") === "1") {
  delete platform.getBuiltinWallpaperUrl;
  delete platform.mountStartupScenePreview;
  delete platform.mountAemeathWallpaper;
  delete platform.validateStartupSceneMedia;
  delete platform.saveStartupSceneImage;
}

function AppearanceFixture() {
  const [project, setProject] = useState(false);
  return (
    <div className="p-6 bg-background text-foreground min-h-dvh">
      <button type="button" onClick={() => setProject(!project)}>
        {project ? "打开外观设置" : "返回项目"}
      </button>
      <div hidden={project} className="space-y-6 mt-6">
        <StartupAnimationSettingsSection />
        <WallpaperSettingsSection />
      </div>
      <div
        hidden={!project}
        style={{ height: 600 }}
        className="mt-6"
        data-testid="wallpaper-project"
      >
        <WorkspaceShellSurface isNativeDesktop isNarrowWebLayout={false} wallpaperVisible={project}>
          <section data-workspace-conversation-frame="true" className="h-full w-full bg-background">
            <div className="h-full bg-background">
              <main className="h-full bg-background p-6">
                <p>Project</p>
                <textarea aria-label="Wallpaper project input" className="bg-input" />
              </main>
            </div>
          </section>
        </WorkspaceShellSurface>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <AppearanceFixture />
        </TooltipProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
