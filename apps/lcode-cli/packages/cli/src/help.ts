import { getLCodeCopy, type SupportedLocale, type UiLocale } from "@lcode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getLCodeCopy(locale, detectedLocale).cli.help(version);
}
