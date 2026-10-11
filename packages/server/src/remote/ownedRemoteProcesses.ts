import type { ChildProcess } from "node:child_process";

/** backend 只拥有自己创建的 CLI 子进程；不得扩展成停止容器或发行版。 */
export class OwnedRemoteProcesses {
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly label: string) {}

  assertActive(): void {
    if (this.disposed) throw new Error(`${this.label} backend 已释放，无法启动新命令`);
  }

  track(child: ChildProcess): void {
    const closed = new Promise<void>((resolve) => {
      const finish = () => {
        this.children.delete(child);
        resolve();
      };
      // error 也可能只是 kill/send 失败，不能当作 stdio 已关闭；启动方负责处理错误。
      child.once("close", finish);
    });
    this.children.set(child, closed);
  }

  disposeAndWait(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const children = Array.from(this.children);
    // Docker 的空 dispose 让连接失败/取消后仍有 docker exec 占用管道。
    // 先同步发送 EOF，再等待 close，最后只 kill 本 owner 的残留 child。
    for (const [child] of children) {
      try {
        if (!child.stdin?.writableEnded) child.stdin?.end();
      } catch {
        /* 已关闭的输入仍等待 close。 */
      }
    }
    this.disposal = Promise.all(
      children.map(async ([child, closed]) => {
        if (await this.waitForClose(closed, Math.max(options?.graceTimeoutMs ?? 300, 0))) return;
        if (this.children.has(child)) child.kill();
        await this.waitForClose(closed, Math.max(options?.killWaitTimeoutMs ?? 250, 0));
      }),
    ).then(() => undefined);
    return this.disposal;
  }

  private async waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return result;
  }
}
