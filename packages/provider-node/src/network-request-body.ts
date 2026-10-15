import { waitForNetworkResult } from "./network-request-lifecycle.js";

export function createNetworkRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: RequestInit,
): Request {
  if (!(input instanceof Request) || !input.body || init?.body != null)
    return new Request(input, init);
  // Node 的 Request(Request) 隐式 pipeThrough 不暴露 pipe 完成 Promise，取消只等中间流。
  // 显式复用原 body，让原 owner 能等到真正的上传源 cancel，而不是提前宣称物理关闭。
  if (input.bodyUsed || input.body.locked)
    throw new TypeError("Request body has already been used");
  return new Request(input, { ...init, body: input.body, duplex: "half" } as RequestInit);
}

/** 发送前的上传源也归原网络 owner；不能只取消等待，留下 reader 继续生产字节。 */
export async function readNetworkRequestBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  retain: (key: object, run: () => Promise<unknown>) => void,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  signal.throwIfAborted();
  if (!body) return undefined;
  const reader = body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown) => {
    // 必须在 releaseLock 前发起 cancel；账本延迟执行时 reader 可能已被 finally 解绑。
    cancellation ??= reader.cancel(reason).catch((error: unknown) => {
      if (error !== reason) throw error;
    });
    retain(reader, () => cancellation!);
  };
  const abort = () => cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array))
          throw new TypeError("Upload chunks must be Uint8Array");
        chunks.push(chunk.value);
        length += chunk.value.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      cancel(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await cancellation?.catch(() => {});
      reader.releaseLock();
    }
  })();
  try {
    return await waitForNetworkResult(reading, signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
