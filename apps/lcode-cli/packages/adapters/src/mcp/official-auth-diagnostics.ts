import type { McpServerFailureKind } from "@lcode/shared";

export const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * 1024;

export async function classifyOfficialMcpResponse(
  response: Response,
): Promise<McpServerFailureKind | undefined> {
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "server_internal_error";

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return response.ok ? undefined : "connection_failed";
  }
  const text = await readBoundedResponseText(response, MAX_DIAGNOSTIC_RESPONSE_BYTES);
  if (!text) return response.ok ? undefined : "connection_failed";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response.ok ? undefined : "connection_failed";
    }
    const record = parsed as Record<string, unknown>;
    if (record["code"] === 3001) return "server_not_found";
    if (record["code"] === 1000) return "server_unavailable";
    if (record["jsonrpc"] === "2.0" && record["error"] !== undefined) {
      const rpcError = record["error"];
      if (rpcError && typeof rpcError === "object" && !Array.isArray(rpcError)) {
        const code = (rpcError as Record<string, unknown>)["code"];
        if (code === 1006) return "not_authenticated";
        if (code === 3101) return "coding_plan_required";
      }
      return "protocol_error";
    }
  } catch {
    return response.ok ? undefined : "connection_failed";
  }
  return response.ok ? undefined : "connection_failed";
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = numericHeader(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) return undefined;
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function numericHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 请求路径（不含 query）。query 可能带用户内容，因此丢弃。 */
export function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

export function byteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

/**
 * 从 JSON-RPC 请求体里取出**结构性**字段用于关联日志：method / id / tools\_call 的工具名 /
 * `_meta` 里的 trace\_id。
 * 刻意不取 `params.arguments`——那里是用户输入（如搜索词），不属于"没那么敏感"的范畴。
 *
 * trace\_id 仅在 `tools/call` 上存在：`initialize` / `tools/list` 由 SDK 在建连阶段发出，
 * 没有 `_meta`，因此那两个请求只有 request id、没有 trace id。这是预期的，不是缺陷。
 */
export function describeJsonRpc(body: unknown): {
  id?: number | string;
  method?: string;
  spanId?: string;
  toolName?: string;
  traceId?: string;
} {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined;
    const params = isPlainRecord(record.params) ? record.params : undefined;
    const toolName = params && typeof params.name === "string" ? params.name : undefined;
    // mcpRequestMeta 把 trace 写在 params._meta 上（同时有扁平键与 com.zcode/ 命名空间键）。
    const meta = params && isPlainRecord(params._meta) ? params._meta : undefined;
    const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : undefined;
    // span 才是"一次 tool call"的粒度：traceId 覆盖整个顶层 session，同一 session 里的
    // 多次调用共用它，用它做关联会串号。
    const spanId = meta && typeof meta.span_id === "string" ? meta.span_id : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(spanId ? { spanId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(traceId ? { traceId } : {}),
    };
  } catch {
    return {};
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 身份头的**非敏感摘要**：只有名字、是否成对、以及 targetType 的枚举值。
 * 绝不输出 Authorization 或 api-key 的值，连截断值也不输出——日志留存周期不受控。
 */
export function describeAbortSignal(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "already-aborted" : "armed";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
