import { useCallback } from "react";
import type { IMemoryService } from "@lcode/services";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";
import { useSettings } from "./useSettingService.js";
import { logger } from "@/logger.js";

export type MemoryStorageLocation = Parameters<
  IMemoryService["changeStorageLocation"]
>[0]["location"];
export type MemoryStorageChangeResult = Awaited<
  ReturnType<IMemoryService["changeStorageLocation"]>
>;

/** 在本机 ServiceProvider 下使用，设置事实仍由原 SettingService 持有。 */
export function useMemoryStorageSettings() {
  const { memoryService } = useServices();
  const platform = usePlatform();
  const { settings, refresh } = useSettings();
  const changeStorageLocation = useCallback(
    async (location: MemoryStorageLocation) => {
      // 复制失败不能先提交 UI 偏好；唯一命令完成后才广播并读回已持久化值。
      const result = await memoryService.changeStorageLocation({ location });
      try {
        platform.syncAppSettings?.({ memoryStorageLocation: result.location });
      } catch (error) {
        // 文件复制与设置已提交，广播异常不能误报为回滚或仍使用旧位置。
        logger.warn("[useMemoryStorageSettings] 已保存记忆位置，设置广播失败", error);
      }
      await refresh({ afterPending: true, throwOnError: true });
      return result;
    },
    [memoryService, platform, refresh],
  );
  return {
    location: settings?.memoryStorageLocation ?? "profile",
    loaded: settings !== null,
    changeStorageLocation,
  };
}
