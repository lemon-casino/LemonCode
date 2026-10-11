import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import type { IPlatformService, RemoteTarget } from "@lcode/shared";
import { RemoteConnectionDialog } from "@/SSHDialog.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
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
const services = {} as IServiceAccessor;
Object.assign(window, {
  remoteConnectionFixture: {
    attempts,
    cancelled,
    disposed,
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
      <ServiceProvider services={services}>
        <LCodeIntlProvider initialLocale="en-US">
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
