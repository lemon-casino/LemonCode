import type { ChildProcess } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { prepareWindowsJobObject } from "../mcp/windows-job-object.js";
import { createPosixBashProcessOwner } from "./posix-bash-process-owner.js";

export interface BashProcessOwner {
  attach(child: ChildProcess): void;
  settle(): Promise<void>;
}

const EXIT_OBSERVATION_MS = 1500;
const EXIT_POLL_MS = 20;

/** 仅用于 Bash；root exit 不能提前释放仍持有 cwd/端口的派生进程。 */
export async function prepareBashProcessOwner(
  platform: NodeJS.Platform,
  prepareJob = prepareWindowsJobObject,
): Promise<BashProcessOwner> {
  if (platform !== "win32") return createPosixBashProcessOwner(platform);
  const job = await prepareJob();
  return {
    attach(child) {
      if (!child.pid) return;
      try {
        job.assign(child.pid);
      } catch (error) {
        // 归属登记失败必须立即停止刚创建的真实 child，不能让未登记命令继续运行。
        child.kill("SIGKILL");
        throw error;
      }
    },
    async settle() {
      job.terminate();
      const deadline = Date.now() + EXIT_OBSERVATION_MS;
      while (job.activeCount() !== 0) {
        if (Date.now() >= deadline)
          throw new Error("Bash process cleanup incomplete (Windows job)");
        await setTimeout(EXIT_POLL_MS);
      }
      // 核验所有成员退出后才关闭句柄；失败时执行器保留控制器，close 可重试。
      job.close();
    },
  };
}
