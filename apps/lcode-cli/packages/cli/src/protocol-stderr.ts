/**
 * 协议进程的诊断出口只有一个。必须监听真实流的异步 error，而不只是 catch write：
 * 否则 EPIPE -> uncaughtException -> 再写 stderr 会形成高 CPU 自激循环。
 */
export function installProtocolStderrBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalWrite = stderr.write;
  let unavailable = false;
  const onError = () => {
    unavailable = true;
  };
  stderr.on("error", onError);
  stderr.on("close", onError);
  stderr.write = ((chunk, encodingOrCallback, callback): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!unavailable) {
      try {
        return originalWrite.call(stderr, chunk, encoding, (error) => {
          if (error) unavailable = true;
          writeCallback?.();
        });
      } catch {
        unavailable = true;
      }
    }
    // 诊断是 best effort；出口失效后仍完成调用方的 flush，不再写坏流或报告自身失败。
    if (writeCallback) queueMicrotask(() => writeCallback());
    return true;
  }) as typeof stderr.write;
  return () => {
    stderr.write = originalWrite;
    stderr.off("error", onError);
    stderr.off("close", onError);
  };
}
