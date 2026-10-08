// 每个接入请求只持有自己的按钮等待态；授权事实由 Main 投影提供。
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { RemotePairingPendingDevice } from "./remoteControlBridge.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
export function RemotePairingDeviceRequest({
  pendingDevice,
  busy,
  onDecide,
}: {
  pendingDevice: RemotePairingPendingDevice;
  busy: boolean;
  onDecide: (requestId: string, accept: boolean) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const [decidePending, setDecidePending] = useState(false);
  async function handleDecide(accept: boolean) {
    setDecidePending(true);
    try {
      await onDecide(pendingDevice.requestId, accept);
    } finally {
      setDecidePending(false);
    }
  }
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3"
      data-testid="remote-control-pairing-device-request"
    >
      <div className="min-w-0">
        <p className="mb-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteControl.pairing.status.pairing" })}
        </p>
        <div className="text-ui-base font-medium text-foreground">
          {pendingDevice.deviceName?.trim() ||
            intl.formatMessage({ id: "settings.remoteControl.pairing.unknownDevice" })}
        </div>
        {pendingDevice.ua ? (
          <div className="mt-1 truncate text-ui-xs font-mono text-foreground-subtle">
            {pendingDevice.ua}
          </div>
        ) : null}
      </div>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.remoteControl.pairing.deviceRequestDescription" })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="lg"
          disabled={busy || decidePending}
          onClick={() => void handleDecide(true)}
        >
          {decidePending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : null}
          {intl.formatMessage({ id: "settings.remoteControl.pairing.allow" })}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          disabled={busy || decidePending}
          onClick={() => void handleDecide(false)}
        >
          {intl.formatMessage({ id: "settings.remoteControl.pairing.reject" })}
        </Button>
      </div>
    </div>
  );
}
