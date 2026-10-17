import { randomUUID } from "node:crypto";
import {
  startupAnimationSettingsSchema,
  type StartupAnimationSettings,
} from "@lcode/shared/startup-animation";

/** 只拥有进程首窗资格；持久化设置仍归 SettingService。 */
export function createStartupAnimationPolicy(createId: () => string = randomUUID) {
  let consumed = false;
  return {
    take(settings: StartupAnimationSettings | undefined) {
      const enabled = !consumed;
      consumed = true;
      return {
        enabled,
        launchId: createId(),
        settings: startupAnimationSettingsSchema.parse(settings ?? {}),
      };
    },
  };
}
