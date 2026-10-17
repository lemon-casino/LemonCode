import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Emitter } from "@lcode/rpc";
import type { ExecutionSetSnapshot } from "@lcode/shared";
import type { ExecutionSetStore } from "../app/ports.js";

/** 原子写替换文件，监听目录并按 revision 去重；订阅释放后不保留 watcher。 */
export function executionSetEvents(dataDir: string, store: ExecutionSetStore) {
  const emitter = new Emitter<ExecutionSetSnapshot>();
  const revisions = new Map<string, number>();
  let count = 0,
    watcher: ReturnType<typeof watch> | undefined;
  let starting = Promise.resolve();
  const publish = (snapshot: ExecutionSetSnapshot) => {
    if ((revisions.get(snapshot.id) ?? -1) >= snapshot.revision) return;
    revisions.set(snapshot.id, snapshot.revision);
    emitter.fire(snapshot);
  };
  return {
    publish,
    subscribe: (listener: (snapshot: ExecutionSetSnapshot) => void) => {
      const subscription = emitter.event(listener);
      count++;
      if (count === 1)
        starting = mkdir(dataDir, { recursive: true }).then(() => {
          if (!count || watcher) return;
          watcher = watch(dataDir, { persistent: false }, (_event, name) => {
            if (!name || !/^[a-f0-9]{32}\.json$/.test(String(name))) return;
            void store.read(String(name).slice(0, -5)).then(
              (snapshot) => {
                if (snapshot) publish(snapshot);
              },
              () => {},
            );
          });
          watcher.on("error", () => {
            watcher?.close();
            watcher = undefined;
          });
        });
      let disposed = false;
      void starting
        .then(() => store.list())
        .then(
          (snapshots) => {
            if (!disposed) snapshots.forEach(listener);
          },
          () => {},
        );
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
          if (!--count) {
            watcher?.close();
            watcher = undefined;
          }
        },
      };
    },
  };
}
