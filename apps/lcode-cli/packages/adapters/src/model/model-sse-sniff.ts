const MAX_PREFIX_BYTES = 4096;
const markers = ["data:", "event:", ":", "id:", "retry:"];

/** 只观察明确 stream 请求的有界前缀；首段足够判定就回放，不等 EOF 或凑满缓冲。 */
export async function sniffModelSseResponse(
  response: Response,
  streamRequested: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !streamRequested ||
    !response.ok ||
    !response.body ||
    type.includes("event-stream") ||
    (type && !type.includes("json") && !type.includes("text/plain"))
  )
    return response;
  signal?.throwIfAborted();
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Array<Uint8Array | undefined> = [];
  const decoder = new TextDecoder();
  let prefix = "",
    observed = 0,
    sse = false,
    ended = false;
  try {
    while (observed < MAX_PREFIX_BYTES) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        ended = true;
        break;
      }
      chunks.push(chunk.value);
      const limited = chunk.value.subarray(0, MAX_PREFIX_BYTES - observed);
      observed += limited.byteLength;
      prefix += decoder.decode(limited, { stream: true });
      const normalized = prefix.replace(/^\uFEFF/u, "").trimStart();
      if (markers.some((marker) => normalized.startsWith(marker))) {
        sse = true;
        break;
      }
      if (normalized && !markers.some((marker) => marker.startsWith(normalized))) break;
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    reader.releaseLock();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const headers = new Headers(response.headers);
  if (sse) {
    headers.set("content-type", "text/event-stream");
    headers.delete("content-length");
    headers.delete("content-encoding");
  }
  let cursor = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (cursor < chunks.length) {
            const chunk = chunks[cursor]!;
            chunks[cursor++] = undefined;
            controller.enqueue(chunk);
            return;
          }
          if (ended) {
            reader.releaseLock();
            controller.close();
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          void reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        void reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const replayed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperties(replayed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return replayed;
}
