const LCODE_PROCESS_PREFIX = "lcode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinLCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [LCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatLCodeMainProcessName(): string {
  return joinLCodeProcessName("main");
}

export function formatLCodeGpuProcessName(): string {
  return joinLCodeProcessName("gpu");
}

export function formatLCodeHostProcessName(label?: string): string {
  return joinLCodeProcessName("host", label);
}

export function formatLCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "LCode") {
    return joinLCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinLCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "LCode - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinLCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinLCodeProcessName("renderer", normalizedTitle);
}

export function formatLCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinLCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatLCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinLCodeProcessName(type, name);
}
