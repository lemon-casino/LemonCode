import type { ProviderEndpointIdentity } from "@lcode/contracts/telemetry";

export const PROVIDER_ENDPOINT_SANITIZER_VERSION = "1";

const MAX_ENDPOINT_CHARS = 4_096;
const MAX_ROUTE_CHARS = 1_024;
const MAX_ROUTE_SEGMENT_CHARS = 128;
const EMAIL_PATTERN = /^[^/@\s]+@[^/@\s]+\.[^/@\s]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LONG_NUMBER_PATTERN = /^\d{7,}$/u;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/iu;
const TOKEN_PATTERN = /^(?=.{20,}$)(?=.*[a-z])(?=.*[A-Z0-9])[-._~+/A-Za-z0-9]+=*$/u;

export class ProviderEndpointIdentityCache {
  private readonly values = new Map<string, ProviderEndpointIdentity | null>();

  constructor(private readonly limit = 256) {}

  resolve(
    providerKind: string | undefined,
    baseURL: string | undefined,
  ): ProviderEndpointIdentity | undefined {
    const normalizedBaseURL = baseURL?.trim();
    if (!normalizedBaseURL) return undefined;
    const key = `${providerKind ?? "unknown"}\0${normalizedBaseURL}`;
    const cached = this.values.get(key);
    if (cached !== undefined) {
      this.values.delete(key);
      this.values.set(key, cached);
      return cached ?? undefined;
    }

    const value = sanitizeProviderEndpoint(normalizedBaseURL) ?? null;
    this.values.set(key, value);
    if (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest) this.values.delete(oldest);
    }
    return value ?? undefined;
  }

  get size(): number {
    return this.values.size;
  }
}

export function sanitizeProviderEndpoint(baseURL: string): ProviderEndpointIdentity | undefined {
  if (baseURL.length > MAX_ENDPOINT_CHARS) return undefined;
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    const origin = parsed.origin;
    const route = sanitizePathname(parsed.pathname).slice(0, MAX_ROUTE_CHARS);
    return {
      origin,
      route,
      sanitizerVersion: PROVIDER_ENDPOINT_SANITIZER_VERSION,
    };
  } catch {
    return undefined;
  }
}

function sanitizePathname(pathname: string): string {
  const segments = pathname
    .split("/")
    .map((segment) => sanitizePathSegment(safeDecodeURIComponent(segment)));
  const sanitized = segments.join("/");
  return sanitized || "/";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizePathSegment(segment: string): string {
  if (EMAIL_PATTERN.test(segment)) return "{email}";
  if (UUID_PATTERN.test(segment)) return "{uuid}";
  if (LONG_NUMBER_PATTERN.test(segment)) return "{id}";
  if (LONG_HEX_PATTERN.test(segment)) return "{hash}";
  if (TOKEN_PATTERN.test(segment)) return "{token}";
  return segment.slice(0, MAX_ROUTE_SEGMENT_CHARS);
}
