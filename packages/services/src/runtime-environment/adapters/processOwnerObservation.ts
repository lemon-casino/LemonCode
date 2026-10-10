import type { RuntimeConsumerProcessOwner, RuntimeProcessOwnerObserver } from "../contract.js";

/** 本机执行 Host 观察；无 registry 时不猜测，且此结果绝不能作为进程树退出收据。 */
export function createNativeProcessOwnerObserver(
  hasProcessOwner?: (owner: RuntimeConsumerProcessOwner) => boolean,
): RuntimeProcessOwnerObserver {
  return (owner) => {
    if (!hasProcessOwner) return "unknown";
    try {
      // owner 集合包含退出后尚未结算的实例，不能用当前复用池为空来授权退役。
      if (hasProcessOwner(owner)) return "present";
    } catch {
      return "unknown";
    }
    const pid = owner.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
    try {
      process.kill(pid, 0);
      // PID 可能已复用；保守保护，绝不按 PID 杀进程或生成树退出证明。
      return "present";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
    }
  };
}
