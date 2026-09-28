const MAX_ERROR_MESSAGE_CHARS = 2_048;
const MAX_ERROR_CHAIN_DEPTH = 8;
const claimedErrorObjects = new WeakSet<object>();

export interface SanitizedTelemetryError {
  cause?: {
    code?: string;
    message?: string;
    type: string;
  };
  code?: string;
  message?: string;
  type: string;
}

export function sanitizeTelemetryError(error: unknown): SanitizedTelemetryError {
  const record = objectRecord(error);
  const type =
    sanitizeErrorIdentifier(
      stringValue(record.type) ??
        stringValue(record.name) ??
        (error instanceof Error ? error.name : undefined),
    ) ?? "UnknownError";
  const code = sanitizeErrorCode(stringValue(record.code));
  const message = sanitizeErrorMessage(
    error instanceof Error ? error.message : stringValue(record.message),
  );
  const chain = errorObjectChain(error);
  // 修复原因：链包含输入本身；没有独立嵌套对象时不能把同一个错误重复登记为 cause。
  const cause = chain.length > 1 ? sanitizeCause(chain[chain.length - 1]!) : undefined;
  return {
    ...(cause ? { cause } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    type,
  };
}

/**
 * 同一个源异常会沿 Attempt -> Call -> Step -> Turn 冒泡。错误正文只应记录在最靠近
 * 来源、最先认领它的 Span；父层继续记录 outcome/failure_stage，但不复制同一份正文。
 *
 * 包装错误的 cause 链也参与认领：AdapterError(cause=ProviderError) 不会在上层重新覆盖
 * Provider Attempt 已记录的原始错误。WeakSet 不延长异常对象生命周期。
 */
export function claimSanitizedTelemetryError(error: unknown): SanitizedTelemetryError | undefined {
  const objects = errorObjectChain(error);
  if (objects.length === 0) return sanitizeTelemetryError(error);
  const alreadyClaimed = objects.some((candidate) => claimedErrorObjects.has(candidate));
  for (const candidate of objects) claimedErrorObjects.add(candidate);
  return alreadyClaimed ? undefined : sanitizeTelemetryError(error);
}

export function sanitizeErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // 错误可能携带整段响应正文；先做有界截断再正则清洗，避免 Telemetry 为恶意或异常
  // Provider 消息承担无界 CPU/内存成本。
  const sanitized = value
    .slice(0, 4_096)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, sanitizeUrl)
    .replace(
      /(\bauthorization\b["']?\s*[:=])\s*(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session|x-arms-license-key)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session|x-arms-license-key)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}")
    .replace(/\b[A-Za-z0-9]{4,32}@[0-9a-f]{12,}\b/giu, "{secret}")
    .replace(/\b[^/@\s]+@[^/@\s]+\.[^/@\s]+\b/gu, "{email}")
    .replace(
      /\/(?:Users|home|root|workspace|workspaces|Volumes)\/[^/\s]+(?:\/[^\s:;,)\]}]+)*/gu,
      "/{path}",
    )
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:;,)\]}]+/gu, "/{path}")
    .replace(/\b[A-Za-z]:\\[^\\\s]+(?:\\[^\s:;,)\]}]+)*/gu, "{path}")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized.slice(0, MAX_ERROR_MESSAGE_CHARS) || undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorObjectChain(error: unknown): object[] {
  const result: object[] = [];
  const seen = new Set<object>();
  let current = error;
  for (
    let depth = 0;
    depth < MAX_ERROR_CHAIN_DEPTH && current && typeof current === "object";
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    result.push(current);
    const record = current as Record<string, unknown>;
    // 部分流包装器使用 adapterError/error；沿单条优先链复用同一认领机制，避免父 Span 重复记录。
    current = [record.cause, record.adapterError, record.error].find(
      (nested) => nested && typeof nested === "object",
    );
  }
  return result;
}

function sanitizeCause(record: object): SanitizedTelemetryError["cause"] | undefined {
  const value = record as Record<string, unknown>;
  const type = sanitizeErrorIdentifier(stringValue(value.type) ?? stringValue(value.name));
  const code = sanitizeErrorCode(stringValue(value.code));
  const message = sanitizeErrorMessage(stringValue(value.message));
  if (!type && !code && !message) return undefined;
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    type: type ?? "UnknownError",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeErrorIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.trim().slice(0, 128);
  return /^[A-Za-z0-9_.:-]+$/u.test(sanitized) ? sanitized : undefined;
}

function sanitizeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 128);
  return sanitized || undefined;
}

function sanitizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const route = parsed.pathname
      .split("/")
      .map((segment) => sanitizeRouteSegment(segment))
      .join("/");
    return `${parsed.protocol}//${parsed.host}${route}`;
  } catch {
    return "{url}";
  }
}

function sanitizeRouteSegment(segment: string): string {
  if (!segment) return segment;
  if (
    /@/u.test(segment) ||
    /^\d{7,}$/u.test(segment) ||
    /^[0-9a-f]{16,}$/iu.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(segment)
  ) {
    return "{segment}";
  }
  return segment.slice(0, 128);
}
