/** 请求租约持续到 body EOF/取消；收到 headers 不代表连接资源已释放。 */
export interface NetworkRequestLease {
  controller: AbortController;
  finish(): void;
  response(response: Response): Response;
}

export function createNetworkRequestLease(
  signal: AbortSignal,
  onFinish: () => void,
): NetworkRequestLease {
  const controller = new AbortController();
  let finished = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const forwardAbort = () => controller.abort(signal.reason);
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
    onFinish();
  };
  const onAbort = () => {
    if (finished) return;
    bodyController?.error(controller.signal.reason);
    void reader?.cancel(controller.signal.reason).catch(() => {});
    finish();
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();

  return {
    controller,
    finish,
    response(response) {
      controller.signal.throwIfAborted();
      if (!response.body) {
        finish();
        return response;
      }
      reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            bodyController = value;
          },
          async pull(value) {
            try {
              const chunk = await reader!.read();
              if (finished) return;
              if (chunk.done) {
                finish();
                value.close();
              } else value.enqueue(chunk.value);
            } catch (error) {
              if (finished) return;
              finish();
              value.error(error);
            }
          },
          cancel(reason) {
            // cancel tee 分支可能等另一消费者；先中止物理请求，不能留连接槽等待它。
            finish();
            controller.abort(reason);
            void reader!.cancel(reason).catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const wrapped = new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
      Object.defineProperties(wrapped, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return wrapped;
    },
  };
}

export function waitForNetworkResult<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  discardLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = signal.aborted;
    const abort = () => {
      aborted = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (aborted) abort();
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (aborted) discardLate?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (!aborted) reject(error);
      },
    );
  });
}
