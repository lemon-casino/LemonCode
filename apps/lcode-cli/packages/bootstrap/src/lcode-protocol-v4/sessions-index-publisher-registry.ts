import type { SessionsIndexPublisher } from "./sessions-index-publisher.js";

const GATEWAY_DISPOSED_FAULT = "fault.gateway.disposed";

/**
 * sessions-index publisher 的 workspace 级生命周期边界：同键异步操作串行，dispose 后禁止回写。
 * gateway 只负责构造/投影；并发等待、失败后重试与销毁代际统一收敛在这里。
 */
export class SessionsIndexPublisherRegistry {
  private readonly publishers = new Map<string, SessionsIndexPublisher>();
  private readonly inFlight = new Map<string, Promise<SessionsIndexPublisher>>();
  private disposed = false;

  get(workspaceId: string): SessionsIndexPublisher | undefined {
    return this.publishers.get(workspaceId);
  }

  set(workspaceId: string, publisher: SessionsIndexPublisher): void {
    this.ensureActive();
    this.publishers.set(workspaceId, publisher);
  }

  keys(): IterableIterator<string> {
    return this.publishers.keys();
  }

  ensureActive(): void {
    if (this.disposed) throw new Error(GATEWAY_DISPOSED_FAULT);
  }

  async runExclusive(
    workspaceId: string,
    operation: () => Promise<SessionsIndexPublisher>,
  ): Promise<SessionsIndexPublisher> {
    this.ensureActive();
    const pending = this.inFlight.get(workspaceId);
    if (pending) {
      try {
        await pending;
      } catch {
        // 前序失败不能封死当前请求；销毁会由 ensureActive 阻断，其他失败允许重试。
      }
      this.ensureActive();
      return this.runExclusive(workspaceId, operation);
    }

    const current = (async () => {
      this.ensureActive();
      const publisher = await operation();
      this.ensureActive();
      return publisher;
    })();
    this.inFlight.set(workspaceId, current);
    try {
      return await current;
    } finally {
      if (this.inFlight.get(workspaceId) === current) this.inFlight.delete(workspaceId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
    this.publishers.clear();
  }
}
