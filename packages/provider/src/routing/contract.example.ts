import { RoutingScheduler } from "./scheduler.js";

/** 调度契约示例：原 owner 提供快照，原 adapter 在唯一物理尝试前取得租约。
 * 跨进程使用 SharedQuotaCoordinator 的 reserve → dispatch → usage/finish 窄端口；
 * 本地 createdAt 冻结 admission 有效期，文件 owner 的 sequence/fence 不能换成本地序号。
 * 完整事件顺序见 specs/provider-routing-recovery-diagnostics.md，domain 不实现文件锁或 HTTP。
 * 冷却到期只允许同资源一个 probe，finish 与归一 success 共同确认恢复。
 * readDiagnostics 是原 owner 的只读有界投影；共享 API 另读 SharedQuotaCoordinator.inspect，不能把本地 available 当成全局余额。
 */
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
