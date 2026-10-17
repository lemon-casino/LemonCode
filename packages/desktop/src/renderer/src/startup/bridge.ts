import type { StartupAnimationSettings, StartupSurface } from "@lcode/shared/startup-animation";

export const STARTUP_PRESENTATION_EVENT = "lcode-startup-presentation";
export type StartupPresentationEvent =
  | { kind: "shell" }
  | { kind: "surface"; surface: StartupSurface }
  | { kind: "preview"; settings: StartupAnimationSettings; image?: Blob };

export function notifyStartupShellReady() {
  document.documentElement.dataset.startupShell = "ready";
  document.dispatchEvent(
    new CustomEvent<StartupPresentationEvent>(STARTUP_PRESENTATION_EVENT, {
      detail: { kind: "shell" },
    }),
  );
}
export function notifyStartupSurface(surface: StartupSurface) {
  document.documentElement.dataset.startupSurface = surface;
  document.dispatchEvent(
    new CustomEvent<StartupPresentationEvent>(STARTUP_PRESENTATION_EVENT, {
      detail: { kind: "surface", surface },
    }),
  );
}
export function previewStartupAnimation(settings: StartupAnimationSettings, image?: Blob) {
  document.dispatchEvent(
    new CustomEvent<StartupPresentationEvent>(STARTUP_PRESENTATION_EVENT, {
      detail: { kind: "preview", settings, image },
    }),
  );
}
