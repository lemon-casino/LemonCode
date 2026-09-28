import { detectLocale, resolveLocale, type SupportedLocale, type UiLocale } from "@lcode/i18n";
import type { CliEnv } from "./env.js";

export function detectCliLocale(env: CliEnv | NodeJS.ProcessEnv): SupportedLocale | undefined {
  return detectLocale({
    env,
    intlLocale: resolveIntlLocale(),
  });
}

export function resolveDisplayLocale(
  locale: UiLocale | undefined,
  detectedLocale: SupportedLocale | undefined,
): SupportedLocale | undefined {
  if (locale === undefined) return undefined;
  return resolveLocale(locale, detectedLocale);
}

function resolveIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
