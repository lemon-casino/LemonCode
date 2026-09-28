import { createHttpClientError } from "@lcode/contracts";

export async function readResponseBody(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
  url: string,
): Promise<Uint8Array> {
  if (maxResponseBytes < 0) {
    throw createHttpClientError({
      code: "too_large",
      url,
      status: response.status,
      message: "HTTP response size limit must not be negative",
    });
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxResponseBytes) {
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: content-length=${parsed}, max=${maxResponseBytes}`,
      });
    }
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxResponseBytes) {
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: bytes=${buffer.byteLength}, max=${maxResponseBytes}`,
      });
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    if (signal.aborted) {
      throw createHttpClientError({
        code: "cancelled",
        url,
        status: response.status,
        message: "HTTP request was cancelled while reading response body",
      });
    }

    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw createHttpClientError({
        code: "too_large",
        url,
        status: response.status,
        message: `HTTP response is too large: bytes>${maxResponseBytes}`,
      });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
