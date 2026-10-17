import { useState } from "react";
import { startupAnimationSettingsSchema, type StartupAnimationSettings } from "@lcode/shared";
import { useSettings } from "./useSettingService.js";
import { usePlatform } from "./usePlatform.js";

const defaultSettings = startupAnimationSettingsSchema.parse({});
export function useStartupAnimationSettings() {
  const { settings, loading, update } = useSettings();
  const platform = usePlatform();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const value = settings?.desktopStartupAnimation ?? defaultSettings;
  const save = async (patch: Partial<StartupAnimationSettings>) => {
    setSaving(true);
    setFailed(false);
    try {
      await update({
        desktopStartupAnimation: startupAnimationSettingsSchema.parse({ ...value, ...patch }),
      });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return {
    value,
    availablePresets: platform.getStartupAnimationPresets?.() ?? [],
    busy: saving || loading,
    failed,
    save,
    preview: () => platform.previewStartupAnimation?.(value),
  };
}
