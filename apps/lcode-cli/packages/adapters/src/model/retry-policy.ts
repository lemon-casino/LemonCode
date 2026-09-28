export interface AiSdkModelRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export type ResolvedAiSdkModelRetryOptions = Required<AiSdkModelRetryOptions>;

type EnvRecord = Record<string, string | undefined>;

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_FACTOR = 2;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

const ENV_MODEL_RETRY_MAX_RETRIES = "LCODE_MODEL_RETRY_MAX_RETRIES";
const ENV_MODEL_RETRY_BASE_DELAY_MS = "LCODE_MODEL_RETRY_BASE_DELAY_MS";
const ENV_MODEL_RETRY_BACKOFF_FACTOR = "LCODE_MODEL_RETRY_BACKOFF_FACTOR";
const ENV_MODEL_RETRY_MAX_DELAY_MS = "LCODE_MODEL_RETRY_MAX_DELAY_MS";

const DEFAULT_RETRY_OPTIONS: ResolvedAiSdkModelRetryOptions = {
  backoffFactor: DEFAULT_RETRY_BACKOFF_FACTOR,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  jitter: true,
  // maxAttempts includes the first request; env/config names expose retry count.
  maxAttempts: DEFAULT_MAX_RETRIES + 1,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
};

export function resolveAiSdkModelRetryOptions(
  options: AiSdkModelRetryOptions | undefined,
  env: EnvRecord,
): ResolvedAiSdkModelRetryOptions {
  const envOptions = readRetryOptionsFromEnv(env);
  return {
    backoffFactor: normalizePositiveNumber(
      options?.backoffFactor,
      normalizePositiveNumber(envOptions.backoffFactor, DEFAULT_RETRY_OPTIONS.backoffFactor),
    ),
    baseDelayMs: normalizeNonNegativeInteger(
      options?.baseDelayMs,
      normalizeNonNegativeInteger(envOptions.baseDelayMs, DEFAULT_RETRY_OPTIONS.baseDelayMs),
    ),
    jitter: options?.jitter ?? DEFAULT_RETRY_OPTIONS.jitter,
    maxAttempts: normalizePositiveInteger(
      options?.maxAttempts,
      normalizePositiveInteger(envOptions.maxAttempts, DEFAULT_RETRY_OPTIONS.maxAttempts),
    ),
    maxDelayMs: normalizeNonNegativeInteger(
      options?.maxDelayMs,
      normalizeNonNegativeInteger(envOptions.maxDelayMs, DEFAULT_RETRY_OPTIONS.maxDelayMs),
    ),
  };
}

function readRetryOptionsFromEnv(env: EnvRecord): AiSdkModelRetryOptions {
  const maxRetries = parseNonNegativeInteger(env[ENV_MODEL_RETRY_MAX_RETRIES]);
  return {
    backoffFactor: parsePositiveNumber(env[ENV_MODEL_RETRY_BACKOFF_FACTOR]),
    baseDelayMs: parseNonNegativeInteger(env[ENV_MODEL_RETRY_BASE_DELAY_MS]),
    maxAttempts: maxRetries === undefined ? undefined : maxRetries + 1,
    maxDelayMs: parseNonNegativeInteger(env[ENV_MODEL_RETRY_MAX_DELAY_MS]),
  };
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
