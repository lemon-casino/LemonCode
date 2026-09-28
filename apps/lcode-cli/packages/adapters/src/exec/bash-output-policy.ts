const DEFAULT_BASH_MAX_OUTPUT_LENGTH = 30_000;
const MAX_BASH_MAX_OUTPUT_LENGTH = 150_000;

export function resolveBashMaxOutputLength(
  processEnv: NodeJS.ProcessEnv,
  requestFallback = DEFAULT_BASH_MAX_OUTPUT_LENGTH,
): number {
  const configured = processEnv.BASH_MAX_OUTPUT_LENGTH;
  if (configured === undefined) {
    return normalizeRequestFallback(requestFallback);
  }
  if (configured.trim() === "") return DEFAULT_BASH_MAX_OUTPUT_LENGTH;

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BASH_MAX_OUTPUT_LENGTH;
  }
  return Math.min(parsed, MAX_BASH_MAX_OUTPUT_LENGTH);
}

function normalizeRequestFallback(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BASH_MAX_OUTPUT_LENGTH;
  return Math.min(value, MAX_BASH_MAX_OUTPUT_LENGTH);
}
