import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ProviderSettingsView } from "@lcode/services";
import type { IPlatformService, ProxyProfile, RemoteTarget } from "@lcode/shared";
import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import "@lcode/ui/styles.css";

const attempts: {
  target: RemoteTarget;
  requestId?: string;
  resolve(id: string): void;
  reject(error: Error): void;
}[] = [];
const cancelled: (string | undefined)[] = [];
const disposed: string[] = [];
const platform = {
  listSSHConfigAliases: async () => [],
  listWSLDistros: async () => [
    { name: "TestDistro", isDefault: true, state: "Running", version: 2 },
  ],
  isDockerAvailable: async () => true,
  listDockerContainers: async () => [
    { id: "123456789abc", name: "test-container", state: "running" },
  ],
  onRemoteConnectionLog: () => () => {},
  cancelPendingRemoteConnection: async (requestId?: string) => {
    cancelled.push(requestId);
  },
} as unknown as IPlatformService;
let proxyReadError = false;
let proxyView = {
  revision: 1,
  proxyProfiles: [
    {
      id: "fixture-http",
      name: "Office HTTP",
      httpProxy: "http://fixture-user:fixture-secret@proxy.invalid:8080",
    },
    {
      id: "fixture-socks",
      name: "Home SOCKS5",
      httpProxy: "socks5://fixture-user:fixture-secret@proxy.invalid:1080",
    },
  ],
} as ProviderSettingsView;
const proxyListeners = new Set<(view: ProviderSettingsView) => void>();
const services = {
  providerSettingsService: {
    getView: async () => {
      if (proxyReadError) throw new Error("fixture proxy read failure");
      return proxyView;
    },
    onDidChange: (listener: (view: ProviderSettingsView) => void) => {
      proxyListeners.add(listener);
      return { dispose: () => proxyListeners.delete(listener) };
    },
  },
} as unknown as IServiceAccessor;
// 在远端 workspace 的 ServiceProvider 中打开向导，也只能读取本机代理库。
useRemoteWorkspaceSessionStore.setState({ baseServices: services });
const remoteServices = {
  providerSettingsService: {
    getView: async () => {
      throw new Error("must not read remote proxy library");
    },
    onDidChange: () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;
const locale = new URLSearchParams(location.search).get("lang") === "zh" ? "zh-CN" : "en-US";
Object.assign(window, {
  remoteConnectionFixture: {
    attempts,
    cancelled,
    disposed,
    setProxies(proxyProfiles: readonly ProxyProfile[]) {
      proxyView = { ...proxyView, revision: proxyView.revision + 1, proxyProfiles };
      for (const listener of proxyListeners) listener(proxyView);
    },
    setProxyReadError(value: boolean) {
      proxyReadError = value;
    },
    succeed(index: number) {
      attempts[index]!.resolve(`session-${index}`);
    },
    fail(index: number) {
      attempts[index]!.reject(new Error(`fixture failure ${index}`));
    },
  },
});

function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={remoteServices}>
        <LCodeIntlProvider initialLocale={locale}>
          <TooltipProvider>
            <main className="p-4 text-ui-base">
              <output data-testid="fixture-open">{String(open)}</output>
              <RemoteConnectionDialog
                open={open}
                onOpenChange={setOpen}
                isWindowsDesktop
                onConnect={(target, requestId) =>
                  new Promise((resolve, reject) => {
                    attempts.push({ target, requestId, resolve, reject });
                  })
                }
                onCancelSession={async (sessionId) => {
                  disposed.push(sessionId);
                }}
                onSelectProject={async () => {}}
              />
              <ConfirmDialogHost />
            </main>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
