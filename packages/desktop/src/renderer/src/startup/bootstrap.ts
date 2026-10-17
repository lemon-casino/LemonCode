import { startupAnimationSettingsSchema } from "@lcode/shared/startup-animation";
import { STARTUP_PRESENTATION_EVENT, type StartupPresentationEvent } from "./bridge.js";
import {
  bootStartupPresentation,
  notifyStartupShellReady,
  notifyStartupSurface,
  previewStartupAnimation,
} from "./presentation.js";

document.addEventListener(STARTUP_PRESENTATION_EVENT, ((
  event: CustomEvent<StartupPresentationEvent>,
) => {
  const value = event.detail;
  if (value?.kind === "shell") notifyStartupShellReady();
  else if (
    value?.kind === "surface" &&
    ["loading", "welcome", "ready", "attention"].includes(value.surface)
  )
    notifyStartupSurface(value.surface);
  else if (value?.kind === "preview") {
    const result = startupAnimationSettingsSchema.safeParse(value.settings);
    if (result.success)
      previewStartupAnimation(result.data, value.image instanceof Blob ? value.image : undefined);
  }
}) as EventListener);
bootStartupPresentation();
