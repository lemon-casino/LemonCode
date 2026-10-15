import { Worker } from "node:worker_threads";
import type { AuthDriverContext, AuthGrant, AuthDriverNetworkOptions } from "../driver.js";
import { PLUGIN_WORKER_SOURCE } from "./worker-source.js";
import { readNetworkRequestBody } from "../../network-request-body.js";
import { NetworkCleanup } from "../../network-cleanup.js";

interface PendingCall {
  /** Node Request 的取消 controller 使用弱引用；只持有 signal 不够，须保留 Request 到流结算。 */
  readonly requestOwner?: Request;
  resolve(value: unknown): void;
  reject(error: Error): void;
  context?: AuthDriverContext;
  cleanup(): void;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  settled: boolean;
  aborted: boolean;
}

type WorkerMessage = {
  kind: "result" | "response" | "chunk" | "end" | "error" | "credential" | "disposed";
  id: number;
  value?: unknown;
  error?: { message: string; name?: string; signIn?: string };
  action?: "read" | "write" | "signin";
  signIn?: "expired" | "kept" | "renewed";
  grant?: AuthGrant;
  callId?: number;
  operationId?: number;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  bytes?: Uint8Array;
};

function abortedError(): Error {
  return new DOMException("Provider operation was cancelled", "AbortError");
}
const WORKER_CLOSE_BUDGET_MS = 1_000;

/** Internal transport, exported separately only for deterministic local fixtures. */
export class PluginWorkerTransport {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingCall>();
  private sequence = 0;
  private closed = false;
  private readonly exit: Promise<number>;
  private disposing?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly uploadCleanup = new NetworkCleanup();
  private activeUploads = 0;

  constructor(
    channel: string,
    fixtureOrigin?: string,
    fixtureH2Origin?: string,
    fixtureLocalHome?: string,
    private readonly networkOptions?: AuthDriverNetworkOptions,
    dependencies: { worker?: Worker } = {},
  ) {
    this.worker =
      dependencies.worker ??
      new Worker(PLUGIN_WORKER_SOURCE, {
        eval: true,
        workerData: {
          channel,
          ...(fixtureOrigin ? { fixtureOrigin, fixtureH2Origin, fixtureLocalHome } : {}),
        },
        // A provider must never forward a raw console log containing its tokens.
        stdout: true,
        stderr: true,
      });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.exit = new Promise((resolve) => {
      this.worker.once("exit", (code) => {
        this.closed = true;
        this.lifetime.abort(abortedError());
        this.failAll(new Error("Provider plugin worker stopped"));
        resolve(code);
      });
    });
    this.worker.on("error", (error) => {
      this.closed = true;
      this.lifetime.abort(abortedError());
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on("message", (message: WorkerMessage) => {
      void this.receive(message).catch((error: unknown) => {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
        void this.dispose().catch(() => {});
      });
    });
    // Worker 加第一个 message listener 会重新 ref；注册后再标记 handle 空闲。
    // 捕获的 stdio 仍有独立 ref，物理释放始终依赖 dispose 确认 exit，不能只靠 unref。
    this.worker.unref();
  }

  async fetch(request: Request, context?: AuthDriverContext): Promise<Response> {
    if (this.closed) throw abortedError();
    this.activeUploads++;
    this.worker.ref();
    try {
      const signal = AbortSignal.any([
        request.signal,
        this.lifetime.signal,
        ...(context?.signal ? [context.signal] : []),
      ]);
      // worker call 前的上传序列化同样归 driver，取消后不能继续读取或迟到 postMessage。
      const body = await readNetworkRequestBody(request.body, signal, (key, run) =>
        this.uploadCleanup.retain(key, run),
      );
      signal.throwIfAborted();
      return this.call<Response>(
        "fetch",
        {
          request: {
            url: request.url,
            method: request.method,
            headers: [...request.headers],
            body,
          },
        },
        context,
        request.signal,
        false,
        request,
      );
    } finally {
      this.activeUploads--;
      if (!this.activeUploads && !this.pending.size && !this.closed) this.worker.unref();
    }
  }

  async call<T>(
    operation: string,
    params: Record<string, unknown> = {},
    context?: AuthDriverContext,
    signal?: AbortSignal,
    killOnAbort = false,
    requestOwner?: Request,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Provider plugin driver is disposed"));
    const signals = [context?.signal, signal].filter((item): item is AbortSignal => Boolean(item));
    const combined = signals.length ? AbortSignal.any(signals) : undefined;
    if (combined?.aborted) return Promise.reject(abortedError());
    const network = await this.networkOptions?.resolveNetwork();
    if (this.closed || combined?.aborted) throw abortedError();
    const id = ++this.sequence;
    this.worker.ref();
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.aborted = true;
        this.finish(id, abortedError());
        this.worker.postMessage({ kind: "cancel", id });
        // 授权插件可能拥有 loopback server、CLI 子进程和轮询定时器。
        // 取消授权必须销毁其 worker，不能只丢弃 Promise 留下后台登录。
        if (killOnAbort) void this.dispose().catch(() => {});
      };
      const pending: PendingCall = {
        requestOwner,
        resolve: (value) => resolve(value as T),
        reject,
        context,
        cleanup: () => combined?.removeEventListener("abort", cancel),
        settled: false,
        aborted: false,
      };
      this.pending.set(id, pending);
      combined?.addEventListener("abort", cancel, { once: true });
      this.worker.postMessage({
        kind: "call",
        id,
        operation,
        context: Boolean(context),
        ...params,
        network,
      });
    });
  }

  dispose(options?: { deadlineAt?: number }): Promise<void> {
    if (this.disposing) return this.disposing;
    this.lifetime.abort(abortedError());
    if (!this.closed) {
      this.closed = true;
      this.failAll(abortedError());
      this.worker.ref();
      this.worker.postMessage({ kind: "dispose" });
    }
    this.disposing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          Promise.allSettled([
            this.uploadCleanup.drain(),
            this.exit.then((code) => {
              if (code !== 0) throw new Error(`Provider worker cleanup failed (exit ${code})`);
            }),
          ]).then((results) => {
            const failures = results
              .filter((result) => result.status === "rejected")
              .map((result) => result.reason);
            if (failures.length)
              throw new AggregateError(failures, "Provider worker resource cleanup failed");
            return "exited" as const;
          }),
          new Promise<"pending">((resolve) => {
            timer = setTimeout(
              () => resolve("pending"),
              Math.max(
                0,
                Math.min(WORKER_CLOSE_BUDGET_MS, (options?.deadlineAt ?? Infinity) - Date.now()),
              ),
            );
          }),
        ]);
        if (outcome === "pending") {
          if (this.worker.threadId === -1)
            throw new Error("Provider upload cleanup remains pending after worker exit");
          // 只终止本账号创建的 Worker；强制结束必须报告，不能伪装优雅关闭 ACK。
          await this.worker.terminate();
          throw new Error("Provider worker cleanup required forced termination");
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return this.disposing;
  }

  private finish(id: number, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    if (error) {
      if (pending.stream) pending.stream.error(error);
      if (!pending.settled) pending.reject(error);
    } else if (pending.stream) pending.stream.close();
    else if (!pending.settled) pending.resolve(value);
    if (this.pending.size === 0 && !this.activeUploads) this.worker.unref();
  }

  private failAll(error: Error): void {
    for (const id of this.pending.keys()) this.finish(id, error);
  }

  private async receive(message: WorkerMessage): Promise<void> {
    if (message.kind === "disposed") return;
    if (message.kind === "credential") {
      await this.credential(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.aborted || this.closed) return;
    switch (message.kind) {
      case "result":
        this.finish(message.id, undefined, message.value);
        break;
      case "error":
        this.finish(
          message.id,
          Object.assign(
            new Error(message.error?.message || "Provider operation failed"),
            message.error,
          ),
        );
        break;
      case "response": {
        const noBody = [204, 205, 304].includes(message.status ?? 200);
        const body = noBody
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start: (controller) => {
                  pending.stream = controller;
                },
                pull: () => {
                  this.worker.postMessage({ kind: "pull", id: message.id });
                },
                cancel: () => {
                  pending.stream = undefined;
                  this.worker.postMessage({ kind: "cancel", id: message.id });
                  this.finish(message.id);
                },
              },
              { highWaterMark: 0 },
            );
        pending.settled = true;
        pending.resolve(
          new Response(body, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }),
        );
        if (noBody) this.worker.postMessage({ kind: "pull", id: message.id });
        break;
      }
      case "chunk":
        if (message.bytes) pending.stream?.enqueue(message.bytes);
        break;
      case "end":
        this.finish(message.id);
        break;
    }
  }

  private async credential(message: WorkerMessage): Promise<void> {
    const pending = this.pending.get(message.operationId ?? -1);
    try {
      if (!pending?.context || pending.aborted || this.closed || pending.context.signal?.aborted)
        throw abortedError();
      let value: AuthGrant | null | undefined;
      if (message.action === "read") value = await pending.context.read();
      else if (message.action === "signin" && message.signIn)
        await pending.context.reportSignIn?.(message.signIn);
      else if (message.action === "write" && message.grant)
        await pending.context.write(message.grant);
      else throw new Error("Invalid plugin credential operation");
      // Host generation/CAS guards write(), and this check discards a read whose
      // account was cancelled while the encrypted store was being read.
      if (
        pending.aborted ||
        this.closed ||
        !this.pending.has(message.operationId!) ||
        pending.context.signal?.aborted
      )
        throw abortedError();
      this.worker.postMessage({ kind: "credential-result", callId: message.callId, value });
    } catch (error) {
      if (!this.closed)
        this.worker.postMessage({
          kind: "credential-result",
          callId: message.callId,
          error: {
            message: error instanceof Error ? error.message : "Credential operation failed",
          },
        });
    }
  }
}
