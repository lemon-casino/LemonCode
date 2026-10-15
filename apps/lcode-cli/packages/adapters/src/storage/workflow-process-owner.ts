import { createHash } from "node:crypto";
import { hostname, homedir, platform } from "node:os";
import { probeProcessStartTimeDefault } from "./workspace-hook-trust-lock.js";

export interface WorkflowProcessIdentity {
  hostId: string;
  processId: number;
  startedAt: number;
}
const START_TIME_TOLERANCE_MS = 2_000;

export function currentWorkflowProcessIdentity(): WorkflowProcessIdentity {
  return {
    // 仅持久化不可逆指纹，不把机器名、用户目录或设备凭据写入诊断。
    hostId: createHash("sha256")
      .update(JSON.stringify([hostname(), homedir(), platform()]))
      .digest("hex"),
    processId: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1_000),
  };
}

export async function probeWorkflowOwner(
  owner: WorkflowProcessIdentity,
  current: WorkflowProcessIdentity,
): Promise<"alive" | "retired" | "unknown"> {
  if (owner.hostId !== current.hostId) return "unknown";
  try {
    process.kill(owner.processId, 0);
  } catch (error) {
    // 同机指纹、实例时间和数据库原 token 已知后，ESRCH 才能证明该旧进程不再存在。
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "retired" : "unknown";
  }
  const startedAt = await probeProcessStartTimeDefault(owner.processId);
  if (startedAt === null) return "unknown";
  return Math.abs(startedAt - owner.startedAt) <= START_TIME_TOLERANCE_MS ? "alive" : "retired";
}
