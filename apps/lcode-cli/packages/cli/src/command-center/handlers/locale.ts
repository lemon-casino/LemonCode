import { isUiLocale, SUPPORTED_LOCALES, type UiLocale } from "@lcode/i18n";
import type { TuiSubmitPromptResult } from "@lcode/tui";
import type { CommandCenterDeps } from "../types.js";

const CONFIGURABLE_LOCALES = ["auto", ...SUPPORTED_LOCALES] as const satisfies readonly UiLocale[];

export async function handleLocaleCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = (await readCurrentLocale(deps)) ?? "en-US";

  if (args.length === 0 || args === "status" || args === "list") {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: [
        `Current locale: ${current}.`,
        `Available locales: ${CONFIGURABLE_LOCALES.join(", ")}.`,
        "Use /locale <locale> to switch and persist the UI locale.",
      ].join("\n"),
    };
  }

  const requested = args.trim();
  if (!isUiLocale(requested)) {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: `Unsupported locale: ${args}. Available locales: ${CONFIGURABLE_LOCALES.join(", ")}.`,
    };
  }

  const setLocale = deps.setLocale ?? (await createAppLocaleSetter(deps));
  if (!setLocale) {
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: "Locale switching is not available in this client.",
    };
  }

  try {
    const result = await setLocale(requested);
    return {
      locale: result.locale,
      mode: deps.getMode?.(),
      response: formatLocaleSwitchResult(result.requestedLocale, result.locale, result.configPath),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      locale: current,
      mode: deps.getMode?.(),
      response: `Unable to switch locale: ${message}`,
    };
  }
}

async function readCurrentLocale(deps: CommandCenterDeps) {
  const localLocale = deps.getLocale?.();
  if (localLocale) return localLocale;
  const app = await deps.getApp();
  return app.getLocale?.();
}

async function createAppLocaleSetter(
  deps: CommandCenterDeps,
): Promise<CommandCenterDeps["setLocale"]> {
  const app = await deps.getApp();
  return app.setLocale?.bind(app);
}

function formatLocaleSwitchResult(
  requestedLocale: UiLocale,
  locale: string,
  configPath: string | undefined,
): string {
  const effective =
    requestedLocale === locale
      ? `Locale switched to ${locale}.`
      : `Locale set to ${requestedLocale}; effective locale is ${locale}.`;
  return configPath ? `${effective}\nConfig: ${configPath}` : effective;
}
