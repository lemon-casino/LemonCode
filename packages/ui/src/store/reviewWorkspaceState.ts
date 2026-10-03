import type { IGitService } from "@lcode/services";
import {
  createGitReviewWorkspaceSnapshot,
  gitReviewWorkspaceKey,
  gitReviewWorkspaceSnapshotSchema,
  gitReviewWorkspaceUpdateResultSchema,
  type GitReviewWorkspaceData,
  type GitReviewWorkspaceScope,
  type GitReviewWorkspaceSnapshot,
  type GitReviewWorkspaceUpdate,
} from "@lcode/shared";
import type { IDisposable } from "@lcode/rpc";

type Patch = Partial<GitReviewWorkspaceData>;
export interface ReviewWorkspaceProjection {
  remoteFieldRevisions: GitReviewWorkspaceSnapshot["fieldRevisions"];
  snapshot: GitReviewWorkspaceSnapshot;
  data: GitReviewWorkspaceData;
  status: "loading" | "saving" | "ready" | "error" | "conflict";
}

/** Accepted 数据只来自 Host；本 store 的 overlay 是尚未接受的用户编辑。 */
export class ReviewWorkspaceProjectionStore {
  private listeners = new Set<() => void>();
  private event: IDisposable | undefined;
  private baseline: GitReviewWorkspaceSnapshot;
  private queued: Patch = {};
  private expected: GitReviewWorkspaceUpdate["expectedFieldRevisions"] = {};
  private flight: GitReviewWorkspaceUpdate | null = null;
  private running = false;
  private ownCommands = new Map<string, Set<keyof GitReviewWorkspaceData>>();
  private remoteFields: GitReviewWorkspaceSnapshot["fieldRevisions"];
  private epoch = 0;
  private projection: ReviewWorkspaceProjection;
  constructor(
    private service: IGitService,
    readonly scope: GitReviewWorkspaceScope,
  ) {
    this.baseline = createGitReviewWorkspaceSnapshot(scope);
    this.remoteFields = this.baseline.fieldRevisions;
    this.projection = {
      snapshot: this.baseline,
      data: this.baseline.data,
      status: "loading",
      remoteFieldRevisions: this.remoteFields,
    };
  }
  getSnapshot = () => this.projection;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const epoch = ++this.epoch;
      try {
        this.event = this.service.onDynamicReviewWorkspace(this.scope)((snapshot) => {
          if (this.epoch === epoch) this.adopt(snapshot);
        });
      } catch {
        this.emit("error");
      }
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.epoch++;
        this.event?.dispose();
        this.event = undefined;
      }
    };
  };
  private emit(status = this.projection.status) {
    this.projection = {
      remoteFieldRevisions: this.remoteFields,
      snapshot: this.baseline,
      data: { ...this.baseline.data, ...this.flight?.patch, ...this.queued },
      status,
    };
    this.listeners.forEach((listener) => listener());
  }
  private adopt(input: GitReviewWorkspaceSnapshot) {
    const snapshot = gitReviewWorkspaceSnapshotSchema.parse(input);
    if (
      gitReviewWorkspaceKey(snapshot.scope) !== gitReviewWorkspaceKey(this.scope) ||
      snapshot.revision < this.baseline.revision
    )
      return;
    if (snapshot.revision > this.baseline.revision) {
      const ownFields = snapshot.lastCommandId
        ? this.ownCommands.get(snapshot.lastCommandId)
        : undefined;
      this.remoteFields = {
        ...this.remoteFields,
        ...Object.fromEntries(
          Object.keys(snapshot.fieldRevisions)
            .filter((field) => {
              const key = field as keyof typeof snapshot.fieldRevisions;
              // 缺失中间事件时，本端回执只归属本命令字段，不能遮住快照里另一端的修改。
              return (
                snapshot.fieldRevisions[key] > this.baseline.fieldRevisions[key] &&
                !(ownFields?.has(key) && snapshot.fieldRevisions[key] === snapshot.revision)
              );
            })
            .map((field) => [
              field,
              snapshot.fieldRevisions[field as keyof typeof snapshot.fieldRevisions],
            ]),
        ),
      };
    }
    this.baseline = snapshot;
    this.emit(this.flight || Object.keys(this.queued).length ? this.projection.status : "ready");
  }
  refresh = async () => {
    const epoch = this.epoch;
    try {
      const snapshot = await this.service.getReviewWorkspace(this.scope);
      if (epoch !== this.epoch) return;
      this.adopt(snapshot);
      if (this.projection.status === "loading" && !this.flight) {
        this.emit("ready");
        if (Object.keys(this.queued).length) {
          this.emit("saving");
          void this.drain();
        }
      }
    } catch {
      if (epoch === this.epoch) this.emit("error");
    }
  };
  patch = (patch: Patch) => {
    for (const field of Object.keys(patch) as (keyof Patch)[]) {
      if (!(field in this.queued)) this.expected[field] = this.baseline.fieldRevisions[field];
    }
    this.queued = { ...this.queued, ...patch };
    if (!["error", "conflict", "loading"].includes(this.projection.status)) {
      this.emit("saving");
      void this.drain();
    } else this.emit();
  };
  flush = async () => {
    if (this.projection.status === "ready") return;
    if (this.projection.status === "error" || this.projection.status === "conflict")
      throw new Error("Review workspace is not synchronized");
    await new Promise<void>((resolve, reject) => {
      const dispose = this.subscribe(() => {
        if (this.projection.status === "ready") {
          dispose();
          resolve();
        } else if (this.projection.status === "error" || this.projection.status === "conflict") {
          dispose();
          reject(new Error("Review workspace is not synchronized"));
        }
      });
    });
  };
  private async drain() {
    if (this.running || ["error", "conflict", "loading"].includes(this.projection.status)) return;
    this.running = true;
    try {
      while (this.flight || Object.keys(this.queued).length) {
        if (!this.flight) {
          this.flight = {
            scope: this.scope,
            commandId: crypto.randomUUID(),
            patch: this.queued,
            expectedFieldRevisions: this.expected,
          };
          this.queued = {};
          this.expected = {};
        }
        const flight = this.flight;
        this.ownCommands.set(
          flight.commandId,
          new Set(Object.keys(flight.patch) as (keyof Patch)[]),
        );
        if (this.ownCommands.size > 256)
          this.ownCommands.delete(this.ownCommands.keys().next().value!);
        const result = gitReviewWorkspaceUpdateResultSchema.parse(
          await this.service.updateReviewWorkspace(flight),
        );
        this.adopt(result.snapshot);
        if (result.status === "conflict") {
          this.emit("conflict");
          return;
        }
        // 后续本端编辑继承本次确认版本；远端更新不能替未提交编辑修改前置版本。
        for (const field of Object.keys(this.queued) as (keyof Patch)[]) {
          if (
            field in flight.patch &&
            this.expected[field] === flight.expectedFieldRevisions[field]
          )
            // 响应丢失重试可能返回另一端的新快照，只能继承本命令首次接受的版本。
            this.expected[field] = result.commandRevision;
        }
        this.flight = null;
      }
      this.emit("ready");
    } catch {
      this.emit("error");
    } finally {
      this.running = false;
    }
  }
  retry = async () => {
    if (this.running) return;
    await this.refresh();
    if (this.projection.status === "error") {
      // 已接受但响应丢失时保留同一 commandId，Host 对账后再处理后续输入。
      this.emit("saving");
      await this.drain();
    }
  };
  resolve = (useLocal: boolean) => {
    if (this.running) return;
    const patch = { ...this.flight?.patch, ...this.queued };
    this.flight = null;
    this.queued = {};
    this.expected = {};
    this.emit("ready");
    if (useLocal && Object.keys(patch).length) this.patch(patch);
  };
}

const projections = new WeakMap<IGitService, Map<string, ReviewWorkspaceProjectionStore>>();
export function getReviewWorkspaceProjection(service: IGitService, scope: GitReviewWorkspaceScope) {
  let scopes = projections.get(service);
  if (!scopes) {
    scopes = new Map();
    projections.set(service, scopes);
  }
  const key = gitReviewWorkspaceKey(scope);
  let store = scopes.get(key);
  if (!store) {
    store = new ReviewWorkspaceProjectionStore(service, scope);
    scopes.set(key, store);
  }
  return store;
}
