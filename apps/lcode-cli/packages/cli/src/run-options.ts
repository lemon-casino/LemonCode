import type { PresentationSurface } from "@lcode/core";
import { getLCodeCopy, isUiLocale, type UiLocale } from "@lcode/i18n";
import type { GlobalOptions, GlobalOutputFormat } from "@lcode/shared-types";
import type { parseGlobalArgs } from "./arguments.js";
import type { CliPermissionMode, CliTargetRequest } from "./cli-types.js";
import type { PluginsCommandFlags } from "./plugins-command.js";

const EMPTY_TARGET_ERROR = "--target requires non-empty text.";
const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";

export const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

export const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

export const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

export const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

export const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    detectedLocale,
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    ...(typeof values["benchmark-limits"] === "string"
      ? { benchmarkLimits: values["benchmark-limits"] }
      : {}),
    ...(typeof values["goal-acceptance"] === "string"
      ? { goalAcceptancePath: values["goal-acceptance"] }
      : {}),
    ...(values.goal === true ? { promptGoal: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    verbose: values.verbose === true,
  };
};

const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
export const normalizeOutputFormat = (
  value: string | undefined,
): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

export const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getLCodeCopy().cli.errors.localeUnsupported(value));
};

export const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (mode === "build" || mode === "plan" || mode === "edit" || mode === "yolo") return mode;
  throw new Error(`Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo.`);
};

export const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

export const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "lcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

export const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

export const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;
