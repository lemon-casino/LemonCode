import { RoutingScheduler } from "./scheduler.js";

/** 调度契约示例：原 owner 提供快照，原 adapter 在唯一物理尝试前取得租约。 */
export function routingContractExample() {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const lease = owner.reserve(
    [{ id: "example", generation: "1", windows: [], portability: "portable" }],
    { attemptId: "example-attempt", scopeKey: "example-scope", workUnits: 10 },
  );
  lease.dispatch();
  lease.finish({ workUnits: 8 });
  owner.dispose();
}
