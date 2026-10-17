import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import type { IPlatformService } from "@lcode/shared";
import { WelcomeScreen, type LoginCompleteReason } from "../../ui/src/WelcomeScreen.js";
import { resolveStartupSurface } from "../../ui/src/root/startupSurface.js";
import { ServiceProvider } from "../../ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.js";
import { StoreProvider } from "../../ui/src/store/StoreProvider.js";
import { LCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.js";
import { notifyStartupSurface } from "../src/renderer/src/startup/bridge.js";
import "../../ui/src/styles.css";

const reasons: LoginCompleteReason[] = [];
const services = {
  oauthService: { getProviders: async () => [], getActiveProvider: async () => null },
  broadcastService: { send: async () => {}, onMessage: () => () => {} },
} as unknown as IServiceAccessor;
let finishPreparation = () => {};
Object.assign(window, {
  welcomeFixture: { reasons, finishPreparation: () => finishPreparation() },
});

function WelcomeFixture() {
  const [phase, setPhase] = useState<"welcome" | "loading" | "ready">("welcome");
  const [error, setError] = useState(false);
  useEffect(() => {
    notifyStartupSurface(
      resolveStartupSurface({
        welcome: phase === "welcome",
        attention: error,
        blocked: phase !== "ready",
        hasWorkspace: phase === "ready",
      }),
    );
  }, [phase, error]);
  Object.assign(window, { welcomeAttention: () => setError(true) });
  const complete = async (reason: LoginCompleteReason) => {
    reasons.push(reason);
    await new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    setPhase("loading");
    finishPreparation = () => setPhase("ready");
  };
  return (
    <>
      {error ? <div role="alert">Welcome error</div> : null}
      {phase === "welcome" ? (
        <WelcomeScreen startupWelcome onComplete={complete} />
      ) : (
        <main>
          <p>{phase}</p>
          <textarea aria-label="Welcome project input" disabled={phase !== "ready"} />
        </main>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={{} as IPlatformService}>
      <StoreProvider broadcastService={services.broadcastService}>
        <LCodeIntlProvider initialLocale="zh-CN">
          <WelcomeFixture />
        </LCodeIntlProvider>
      </StoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
