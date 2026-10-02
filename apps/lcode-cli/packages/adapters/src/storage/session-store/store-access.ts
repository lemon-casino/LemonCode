import type { DatabaseSync } from "node:sqlite";
import type { ForkCommitFaultStage } from "./options.js";

/** 方法模块只借用 SqliteSessionStore 的连接与写入守卫，不拥有第二份连接或缓存。 */
export interface SqliteStoreAccess {
  readonly db: DatabaseSync;
  throwBeforeWrite(): void;
  maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void;
}

export type StoreMethods<T> = { [K in keyof T]: OmitThisParameter<T[K]> };
