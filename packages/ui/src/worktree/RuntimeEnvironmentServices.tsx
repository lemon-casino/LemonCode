import type { RuntimeEnvironmentCapabilities, RuntimeEnvironmentProjection } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  environmentActionAvailable,
  environmentPreviewAvailability,
} from "@/hooks/runtimeEnvironmentModel.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function RuntimeEnvironmentServices({
  environment,
  capabilities,
  pending,
  remote,
  onAction,
}: {
  environment: RuntimeEnvironmentProjection;
  capabilities?: RuntimeEnvironmentCapabilities;
  pending: boolean;
  remote: boolean;
  onAction: (action: "start" | "stop" | "restart", serviceId: string) => Promise<boolean>;
}) {
  const { intl } = useLCodeIntl();
  const platform = useOptionalPlatform();
  const text = (key: string) => intl.formatMessage({ id: `runtimeEnvironment.${key}` });
  const receipts = environment.services ?? [];
  const available = environment.availableServices ?? [];
  const ids = [
    ...new Set([
      ...available.map((item) => item.serviceId),
      ...receipts.map((item) => item.serviceId),
    ]),
  ];
  const canStart =
    environmentActionAvailable(capabilities, "startService") && environment.status === "ready";
  const canStop = environmentActionAvailable(capabilities, "stopService");
  if (!ids.length) return <p className="text-ui-sm text-foreground-subtle">{text("noServices")}</p>;
  return (
    <div className="space-y-3" data-testid="runtime-environment-services">
      <h4 className="text-ui-sm font-medium">{text("services")}</h4>
      {ids.map((serviceId) => {
        const receipt = receipts.find((item) => item.serviceId === serviceId);
        const definition = available.find((item) => item.serviceId === serviceId);
        const running = receipt?.state === "running";
        return (
          <div
            key={serviceId}
            className="min-w-0 space-y-2 rounded-lg border border-border p-2"
            data-service-id={serviceId}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-ui-sm">
              <span className="break-all font-mono">{serviceId}</span>
              <span data-testid="runtime-service-state">
                {text(`service.${receipt?.state ?? "not-started"}`)}
              </span>
              {receipt?.generation ? (
                <span className="text-foreground-subtle">
                  {text("generation")} {receipt.generation}
                </span>
              ) : null}
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              {text(definition?.portIsolation === "managed" ? "portsManaged" : "portsUnmanaged")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  pending ||
                  !canStart ||
                  !definition ||
                  Boolean(receipt && !["stopped", "failed"].includes(receipt.state))
                }
                onClick={() => void onAction("start", serviceId)}
              >
                {text("start")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !canStop || !receipt || receipt.state === "stopped"}
                onClick={() => void onAction("stop", serviceId)}
              >
                {text("stop")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !canStart || !canStop || !definition || !running}
                onClick={() => void onAction("restart", serviceId)}
              >
                {text("restart")}
              </Button>
            </div>
            {receipt?.urls.map((url) => {
              // 仅 Desktop 原生 browser 能力说明浏览器与本机 Host 同设备；Web openExternal 不是端口代理。
              const reason = platform
                ? environmentPreviewAvailability(
                    url,
                    Boolean(platform.browserViewAttachGuest),
                    remote,
                  )
                : "host-unreachable";
              return (
                <div key={url} className="min-w-0 space-y-1 text-ui-sm">
                  <p className="break-all font-mono">{url}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!running || Boolean(reason)}
                    onClick={() => {
                      if (!reason && running) platform?.openExternal(url);
                    }}
                  >
                    {text("preview")}
                  </Button>
                  {reason ? (
                    <p className="break-words text-foreground-subtle">
                      {text(`preview.${reason}`)}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
