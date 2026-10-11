import type { ComponentProps } from "react";
import { useMemoryStorageSettings } from "@/hooks/useMemoryStorageSettings.js";
import { MemorySettingsSection } from "./MemorySettingsSection.js";

/** 由设置页本机 ServiceProvider 装配，不读取当前远程 tab 的位置偏好。 */
export function MemorySettingsSectionController(
  props: Omit<
    ComponentProps<typeof MemorySettingsSection>,
    "memoryStorageLocation" | "memoryStorageLocationLoading" | "onMemoryStorageLocationChange"
  >,
) {
  const storage = useMemoryStorageSettings();
  return (
    <MemorySettingsSection
      {...props}
      memoryStorageLocation={storage.location}
      memoryStorageLocationLoading={!storage.loaded}
      onMemoryStorageLocationChange={storage.changeStorageLocation}
    />
  );
}
