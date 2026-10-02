import {
  TAG_MODES,
  TAG_STRATEGIES,
  getTagSuggestions,
  type PublishOptions,
} from "./publishModel.js";

export interface PublishPreset {
  name: string;
  options: PublishOptions;
}
const MAX_PRESETS = 30;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedText = (value: unknown, max = 256): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function isOptions(value: unknown): value is PublishOptions {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "remotes",
      "pushBranch",
      "tagMode",
      "tagName",
      "existingTags",
      "tagStrategy",
    ])
  )
    return false;
  if (
    typeof value.pushBranch !== "boolean" ||
    !TAG_MODES.some((mode) => mode === value.tagMode) ||
    !TAG_STRATEGIES.some((strategy) => strategy === value.tagStrategy) ||
    !boundedText(value.tagName)
  )
    return false;
  if (
    !Array.isArray(value.remotes) ||
    value.remotes.length > 50 ||
    !value.remotes.every(
      (remote: unknown) =>
        isRecord(remote) &&
        exactKeys(remote, ["name", "branch"]) &&
        boundedText(remote.name) &&
        remote.name.trim().length > 0 &&
        boundedText(remote.branch),
    )
  )
    return false;
  if (
    new Set(value.remotes.map((remote: { name: string }) => remote.name)).size !==
    value.remotes.length
  )
    return false;
  return (
    Array.isArray(value.existingTags) &&
    value.existingTags.length <= 200 &&
    value.existingTags.every((name: unknown) => boundedText(name) && name.length > 0) &&
    new Set(value.existingTags).size === value.existingTags.length
  );
}

export function publishPresetStorageKey(workspacePath: string, workspaceIdentity?: string): string {
  return `lcode.git.publish-presets.v1:${encodeURIComponent(workspaceIdentity?.trim() || workspacePath)}`;
}

export function parsePublishPresets(json: string | null): PublishPreset[] {
  if (!json || json.length > 200_000) return [];
  try {
    const data: unknown = JSON.parse(json);
    if (
      !isRecord(data) ||
      !exactKeys(data, ["version", "presets"]) ||
      data.version !== 1 ||
      !Array.isArray(data.presets) ||
      data.presets.length > MAX_PRESETS
    )
      return [];
    const result: PublishPreset[] = [];
    for (const value of data.presets) {
      if (
        !isRecord(value) ||
        !exactKeys(value, ["name", "options"]) ||
        !boundedText(value.name, 80) ||
        !value.name.trim() ||
        value.name !== value.name.trim() ||
        !isOptions(value.options) ||
        result.some((preset) => preset.name === value.name)
      )
        return [];
      result.push({ name: value.name, options: value.options });
    }
    return result;
  } catch {
    return [];
  }
}

export function serializePublishPresets(presets: PublishPreset[]): string {
  const json = JSON.stringify({ version: 1, presets });
  if (parsePublishPresets(json).length !== presets.length)
    throw new Error("Invalid publish presets");
  return json;
}

export function applyPublishPreset(
  preset: PublishPreset,
  tagNames: readonly string[],
): PublishOptions {
  const options = {
    ...preset.options,
    remotes: preset.options.remotes.map((remote) => ({ ...remote })),
    existingTags: [...preset.options.existingTags],
  };
  if (options.tagStrategy !== "custom")
    options.tagName = getTagSuggestions(tagNames)?.[options.tagStrategy] ?? "";
  return options;
}
