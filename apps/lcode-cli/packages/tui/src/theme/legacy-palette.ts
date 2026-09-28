import { activeTuiTheme } from "./state.js";
import type { TuiLegacyPalette, TuiThemeTokens } from "./types.js";

const LEGACY_PALETTE_KEYS = [
  "accent",
  "background",
  "border",
  "danger",
  "muted",
  "panel",
  "panelAlt",
  "success",
  "text",
  "userMessageBackground",
  "warning",
] as const satisfies readonly (keyof TuiLegacyPalette)[];

export function themeToLegacyPalette(theme: TuiThemeTokens): TuiLegacyPalette {
  return {
    accent: theme.accent,
    background: theme.background,
    border: theme.border,
    danger: theme.error,
    muted: theme.textMuted,
    panel: theme.backgroundPanel,
    panelAlt: theme.backgroundElement,
    success: theme.success,
    text: theme.text,
    userMessageBackground: theme.backgroundMessageUser,
    warning: theme.warning,
  };
}

export const palette = new Proxy({} as TuiLegacyPalette, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return themeToLegacyPalette(activeTuiTheme())[property as keyof TuiLegacyPalette];
  },
  getOwnPropertyDescriptor(_target, property) {
    if (!LEGACY_PALETTE_KEYS.includes(property as keyof TuiLegacyPalette)) return undefined;
    return {
      configurable: true,
      enumerable: true,
      value: themeToLegacyPalette(activeTuiTheme())[property as keyof TuiLegacyPalette],
    };
  },
  ownKeys() {
    return [...LEGACY_PALETTE_KEYS];
  },
}) as TuiLegacyPalette;

