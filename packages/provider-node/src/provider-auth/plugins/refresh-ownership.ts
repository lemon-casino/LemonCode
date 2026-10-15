import type { AuthDriverContext, AuthGrant } from "../driver.js";

interface Rotation {
  grant: AuthGrant;
  readonly commit: (grant: AuthGrant) => Promise<void>;
  readonly done: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
  writing?: Promise<void>;
}

/** 只持有原 worker operation 已获准的固定 CAS；取消不升级任意 credential.write 的权限。 */
export class PluginRefreshOwnership {
  private readonly rotations = new Map<number, Rotation>();
  constructor(private readonly active: () => boolean) {}
  get size(): number {
    return this.rotations.size;
  }

  async begin(
    id: number,
    context: AuthDriverContext | undefined,
    current: () => boolean,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid refresh operation");
    if (
      !this.active() ||
      !current() ||
      context?.signal?.aborted ||
      !context?.captureRefreshCommit ||
      !context.retainRefreshCompletion
    )
      return false;
    if (this.rotations.has(id)) return true;
    const grant = await context.read();
    if (!this.active() || !current() || context.signal?.aborted || grant?.type !== "oauth")
      return false;
    if (this.rotations.has(id)) return true;
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = {
      promise: new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
      resolve: () => resolve(),
      reject: (error: Error) => reject(error),
    };
    void done.promise.catch(() => {});
    const rotation = { grant, commit: context.captureRefreshCommit(), done };
    context.retainRefreshCompletion(done.promise);
    this.rotations.set(id, rotation);
    return true;
  }

  read(id: number): AuthGrant | undefined {
    return this.rotations.get(id)?.grant;
  }

  async write(id: number, grant: AuthGrant): Promise<boolean> {
    const rotation = this.rotations.get(id);
    if (!rotation) return false;
    if (!this.active() || rotation.writing) throw new Error("Refresh ownership unavailable");
    rotation.writing = rotation.commit(grant);
    await rotation.writing;
    rotation.grant = grant;
    this.rotations.delete(id);
    rotation.done.resolve();
    return true;
  }

  async end(id: number, admitted: boolean): Promise<void> {
    const rotation = this.rotations.get(id);
    if (!rotation) return;
    let cause: unknown;
    await rotation.writing?.catch((error: unknown) => {
      cause = error;
    });
    if (!this.rotations.delete(id)) return;
    if (admitted)
      rotation.done.reject(
        new Error("Provider rotation ended without a confirmed credential commit", { cause }),
      );
    else rotation.done.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.rotations.keys()].map((id) => this.end(id, true)));
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.rotations.values()].map((item) => item.done.promise));
  }
}
