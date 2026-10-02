import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderSettingsFacade, ProviderApiKey } from "../../../provider/src/index.js";
import { createProviderSettingsService } from "../../../services/src/model-provider/providerFacadeServices.js";
import { probeProviderApiKeys } from "@/hooks/providerApiKeyProbe.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ProviderApiKeyManagerDialog } from "@/settings/model-provider-section/ProviderApiKeyManagerDialog.js";
import "@/styles.css";

// 真实弹窗、hook、Service、八路检测池和 fetch；只使用合成数据及本地拦截的网络。
let saved: readonly ProviderApiKey[] = [];
let saves = 0;
let inFlight = 0;
const facade = {
  onDidChange: () => () => {},
  waitForProviderOperations: async () => {},
  getView: () => ({
    providers: [
      {
        providerId: "fixture",
        effectiveConfig: {
          group: "standard-personal",
          access: { type: "api-key", apiKeys: saved },
          api: { type: "openai-chat-completions", baseUrl: `${location.origin}/__keyprobe` },
        },
      },
    ],
  }),
} as unknown as ProviderSettingsFacade;
const service = createProviderSettingsService(facade);
const initial = Array.from({ length: 100_000 }, (_, index) => ({
  id: String(index),
  apiKey: `fixture-${index}`,
  label: `Key ${index}`,
  enabled: index % 3 !== 1,
}));
saved = initial;
const lazy = new URLSearchParams(location.search).has("lazy");
const initialJson = JSON.stringify(initial);
let holdLoad = true;
let failLoad = false;
const pendingLoads: Array<(json: string) => void> = [];
const loadApiKeysJson = async () => {
  if (failLoad) throw new Error("sensitive fixture failure");
  if (holdLoad) return new Promise<string>((resolve) => pendingLoads.push(resolve));
  return initialJson;
};

function Fixture() {
  const [open, setOpen] = useState(true);
  const [scope, setScope] = useState("fixture-a");
  const [keys, setKeys] = useState(saved);
  const [mounted, setMounted] = useState(true);
  Object.assign(window, {
    __keyProbe: {
      saves: () => saves,
      saved: () => saved,
      inFlight: () => inFlight,
      loads: () => pendingLoads.length,
      releaseLoad: () => {
        holdLoad = false;
        pendingLoads.splice(0).forEach((resolve) => resolve(initialJson));
      },
      failLoad: (fail: boolean) => {
        failLoad = fail;
      },
      reopen: () => setOpen(true),
      switchScope: () => setScope("fixture-b"),
      unmount: () => setMounted(false),
      seed: (count: number) => {
        saved = initial.slice(0, count);
        setKeys(saved);
        setOpen(false);
      },
    },
  });
  return (
    <LCodeIntlProvider initialLocale="zh-CN">
      <button onClick={() => setOpen(true)}>Reopen</button>
      {mounted ? (
        <ProviderApiKeyManagerDialog
          open={open}
          scopeKey={scope}
          apiKeys={keys}
          loadApiKeysJson={lazy ? loadApiKeysJson : undefined}
          onOpenChange={setOpen}
          onSave={async (next) => {
            saved = next;
            saves++;
            setKeys(next);
          }}
          onProbe={async (ids, options) => {
            inFlight++;
            try {
              return await probeProviderApiKeys(service, "fixture", ids, options);
            } finally {
              inFlight--;
            }
          }}
        />
      ) : null}
    </LCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
