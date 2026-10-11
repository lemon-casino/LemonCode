import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  TID_SETTINGS_MEMORY_STORAGE_LOCATION,
  TID_SETTINGS_MEMORY_STORAGE_FEEDBACK,
} from "@lcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  MemoryStorageChangeResult,
  MemoryStorageLocation,
} from "@/hooks/useMemoryStorageSettings.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { SettingsRow } from "./SettingsPageParts.js";

export function MemoryStorageLocationControl({
  location,
  disabled,
  onChange,
}: {
  location: MemoryStorageLocation;
  disabled: boolean;
  onChange: (location: MemoryStorageLocation) => Promise<MemoryStorageChangeResult>;
}) {
  const { intl } = useLCodeIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemoryStorageChangeResult | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function change(value: string) {
    if (
      disabled ||
      inFlight.current ||
      value === location ||
      (value !== "profile" && value !== "workspace")
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const committed = await runUserActionAsync({
        input: {
          featureId: "settings.memory",
          action: "change_storage_location",
          trigger: "select",
        },
        operation: () => onChange(value),
        completed: { resultSource: "platform_result" },
        failureStage: "storage_location_change",
      });
      if (active.current) setResult(committed);
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  const message = (key: string) => intl.formatMessage({ id: `settings.memory.storage.${key}` });
  return (
    <>
      <SettingsRow
        label={message("label")}
        description={message("description")}
        controlLayout="wide"
        control={
          <Select
            value={location}
            disabled={disabled || busy}
            onValueChange={(value) => void change(value)}
          >
            <SelectTrigger
              size="lg"
              className="w-full"
              aria-label={message("label")}
              title={message(location)}
              data-testid={TID_SETTINGS_MEMORY_STORAGE_LOCATION}
            >
              <SelectValue>{message(location)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="profile">{message("profile")}</SelectItem>
              <SelectItem value="workspace">{message("workspace")}</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <div
        className="min-w-0 space-y-1 px-4 pb-3 text-ui-sm leading-5 text-foreground-subtle"
        data-testid={TID_SETTINGS_MEMORY_STORAGE_FEEDBACK}
      >
        {busy ? (
          <span role="status" className="inline-flex items-center gap-1.5">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            {message("saving")}
          </span>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {intl.formatMessage({ id: "settings.memory.storage.failed" }, { reason: error })}
          </p>
        ) : null}
        {result ? (
          <p role="status">
            {intl.formatMessage(
              { id: "settings.memory.storage.saved" },
              { copiedCount: result.copiedCount, conflictCount: result.conflictCount },
            )}
          </p>
        ) : null}
        <p>{message("timing")}</p>
      </div>
    </>
  );
}
