import type { UiLocale, SupportedLocale } from "@lcode/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { LCodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, LCodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, LCodeCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getLCodeCopy(locale?: UiLocale | string, detected?: string | null): LCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
