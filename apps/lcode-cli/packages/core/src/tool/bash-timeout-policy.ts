export interface BashTimeoutPolicy {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;

export const DEFAULT_BASH_TIMEOUT_POLICY: BashTimeoutPolicy = {
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
  maxTimeoutMs: DEFAULT_BASH_MAX_TIMEOUT_MS,
};

export function resolveBashTimeoutPolicy(
  env: Readonly<Record<string, string | undefined>>,
): BashTimeoutPolicy {
  const defaultTimeoutMs =
    parsePositiveTimeout(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_BASH_TIMEOUT_MS;
  const configuredMaxTimeoutMs = parsePositiveTimeout(env.BASH_MAX_TIMEOUT_MS);

  return {
    defaultTimeoutMs,
    maxTimeoutMs:
      configuredMaxTimeoutMs !== undefined
        ? Math.max(configuredMaxTimeoutMs, defaultTimeoutMs)
        : Math.max(DEFAULT_BASH_MAX_TIMEOUT_MS, defaultTimeoutMs),
  };
}

export function resolveBashTimeoutMs(
  inputTimeoutMs: number | undefined,
  policy: BashTimeoutPolicy,
): number {
  return Math.min(inputTimeoutMs || policy.defaultTimeoutMs, policy.maxTimeoutMs);
}

function parsePositiveTimeout(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}
