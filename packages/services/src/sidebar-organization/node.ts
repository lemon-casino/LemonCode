import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Emitter } from "@lcode/rpc";
import { sidebarOrganizationRequestSchema, type SidebarOrganization } from "@lcode/shared";
import type { ISidebarOrganizationService } from "./contract.js";
import { createOrganizationRepository } from "./adapters/repository.js";

export function createSidebarOrganizationService(path: string): ISidebarOrganizationService {
  const repository = createOrganizationRepository(path);
  const emitter = new Emitter<SidebarOrganization>();
  let subscribers = 0;
  let watcher: ReturnType<typeof watch> | undefined;
  let watching = Promise.resolve();
  let revision = -1;
  const publish = (snapshot: SidebarOrganization) => {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    emitter.fire(snapshot);
  };
  // 原子 rename 会替换 inode；监听父目录，不能只监听旧文件而漏掉其它窗口提交。
  const subscribe: ISidebarOrganizationService["onDidChange"] = (listener) => {
    const subscription = emitter.event(listener);
    subscribers++;
    if (subscribers === 1)
      watching = mkdir(dirname(path), { recursive: true }).then(() => {
        if (!subscribers || watcher) return;
        watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
          if (name?.toString() !== basename(path)) return;
          void repository.getSnapshot().then(publish, () => {});
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
        });
      });
    let disposed = false;
    // RPC 重连会重新建立订阅；即使该 revision 已通知过其它窗口，新订阅也必须拿到当前快照。
    // 初始读取与后续事件可能交错，客户端按 revision 丢弃迟到结果。
    void watching
      .then(() => repository.getSnapshot())
      .then(
        (snapshot) => {
          if (!disposed) listener(snapshot);
        },
        () => {},
      );
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        subscription.dispose();
        subscribers--;
        if (!subscribers) {
          watcher?.close();
          watcher = undefined;
        }
      },
    };
  };
  return {
    onDidChange: subscribe,
    async getSnapshot() {
      await watching;
      return repository.getSnapshot();
    },
    async apply(input) {
      const result = await repository.apply(sidebarOrganizationRequestSchema.parse(input));
      publish(result.snapshot);
      return result;
    },
  };
}
