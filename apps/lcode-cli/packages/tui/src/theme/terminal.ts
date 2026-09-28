import type { CliRenderer, TerminalColors } from "@mbears/opentui-core";
import type { UiThemeMode } from "@lcode/contracts";
import { isTuiThemeMode } from "./state.js";

const THEME_MODE_WAIT_TIMEOUT_MS = 250;
const PALETTE_DETECTION_TIMEOUT_MS = 350;
const HEX_COLOR_LENGTH = 7;
const HEX_RADIX = 16;
const RGB_COMPONENT_START = 1;
const RGB_COMPONENT_SIZE = 2;
const BRIGHTNESS_THRESHOLD = 128;

type TerminalThemeRenderer = Pick<
  CliRenderer,
  "getPalette" | "themeMode" | "waitForThemeMode"
>;

export async function resolveInitialTerminalThemeMode(
  renderer: TerminalThemeRenderer,
): Promise<UiThemeMode | null> {
  const current = normalizeThemeMode(renderer.themeMode);
  if (current) return current;

  const detected = normalizeThemeMode(
    await renderer.waitForThemeMode(THEME_MODE_WAIT_TIMEOUT_MS).catch(() => null),
  );
  if (detected) return detected;

  return await detectThemeModeFromPalette(renderer);
}

export function inferThemeModeFromTerminalColors(colors: TerminalColors): UiThemeMode | null {
  const background = colors.defaultBackground ?? colors.palette[0];
  if (!background) return null;
  return inferThemeModeFromHex(background);
}

function normalizeThemeMode(value: unknown): UiThemeMode | null {
  return isTuiThemeMode(value) ? value : null;
}

async function detectThemeModeFromPalette(
  renderer: TerminalThemeRenderer,
): Promise<UiThemeMode | null> {
  try {
    const colors = await renderer.getPalette({
      size: 16,
      timeout: PALETTE_DETECTION_TIMEOUT_MS,
    });
    return inferThemeModeFromTerminalColors(colors);
  } catch {
    return null;
  }
}

function inferThemeModeFromHex(color: string): UiThemeMode | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(color) || color.length !== HEX_COLOR_LENGTH) {
    return null;
  }

  const red = readHexComponent(color, RGB_COMPONENT_START);
  const green = readHexComponent(color, RGB_COMPONENT_START + RGB_COMPONENT_SIZE);
  const blue = readHexComponent(color, RGB_COMPONENT_START + RGB_COMPONENT_SIZE * 2);
  const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return brightness > BRIGHTNESS_THRESHOLD ? "light" : "dark";
}

function readHexComponent(color: string, offset: number): number {
  return Number.parseInt(color.slice(offset, offset + RGB_COMPONENT_SIZE), HEX_RADIX);
}

