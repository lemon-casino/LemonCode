import type { LCodeApp } from "../app/types.js";
import type { LCodeProtocolAgentDependencies } from "./server-types.js";

/** 持有 app 资源而非业务 session；临时 workspace app、尚未登记的 app 也归此 owner。 */
export class ProtocolRuntimeResources {
  private stopping = false;
  private readonly apps = new Map<LCodeApp, { closing?: Promise<void>; closeFailed: boolean }>();
  private closePromise?: Promise<void>;

  constructor(private readonly factory: LCodeProtocolAgentDependencies["createLCodeApp"]) {}

  readonly create: LCodeProtocolAgentDependencies["createLCodeApp"] = async (options) => {
    this.assertServing();
    // 关闭失败的候选仍由此资源 owner 持有；同 ID 重建前先结算旧资源，不误关活跃 app。
    if (options?.sessionId)
      for (const [existing, state] of this.apps) {
        if (existing.sessionId === options.sessionId && state.closeFailed) await existing.close?.();
      }
    const app = await this.factory(options);
    const originalClose = app.close?.bind(app);
    const state: { closing?: Promise<void>; closeFailed: boolean } = { closeFailed: false };
    app.close = () => {
      state.closing ??= Promise.resolve()
        .then(async () => {
          await originalClose?.();
          this.apps.delete(app);
          state.closeFailed = false;
        })
        .catch((error) => {
          // 原 finally 无条件移除会丢失失败关闭句柄；保留 owner 并允许下一次 close 重试。
          state.closeFailed = true;
          state.closing = undefined;
          throw error;
        });
      return state.closing;
    };
    this.apps.set(app, state);
    if (this.stopping) {
      // create 在 EOF 前开始、EOF 后返回时不能重新成为可用 session，也不能遗失资源。
      await this.stopApp(app);
      this.assertServing();
    }
    return app;
  };

  assertServing(): void {
    if (this.stopping) throw new Error("LCode Protocol runtime is stopping");
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled(
          [...this.apps.keys()].map((app) => this.stopApp(app)),
        );
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "Protocol apps shutdown failed");
      })
      .catch((error) => {
        this.closePromise = undefined;
        throw error;
      });
    return this.closePromise;
  }

  private async stopApp(app: LCodeApp): Promise<void> {
    try {
      app.runtime.beginShutdown();
      app.runtime.stopActiveForegroundExecution?.({ reason: "Protocol runtime stopping" });
    } finally {
      await app.close?.();
    }
  }
}
