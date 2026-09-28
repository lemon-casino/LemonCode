import { spawn, type ChildProcess } from "node:child_process";

const GENERIC_SIGTERM_TO_SIGKILL_MS = 750;
const POSIX_PROCESS_LOOKUP_TIMEOUT_MS = 500;
export const BASH_SIGTERM_TO_SIGKILL_MS = 1_500;

export async function signalPosixProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return;
  await killPosixProcessTree(rootPid, signal).catch(() => undefined);
}

export function terminateGenericPosixProcessGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  setTimeout(() => {
    // 组长 exit 后，负 PGID 仍可能命中持有 pipe 的孙进程；仅当进程组
    // 确认不存在时才跳过 escalation。
    if (!isPosixProcessGroupAlive(child.pid!)) return;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, GENERIC_SIGTERM_TO_SIGKILL_MS).unref();
}

function isPosixProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function killPosixProcessTree(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const descendants = await collectPosixDescendantPids(rootPid);
  try {
    process.kill(-rootPid, signal);
  } catch {
    try {
      process.kill(rootPid, signal);
    } catch {
      // 根进程可能已退出；仍继续处理快照后代。
    }
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // 后代可能已自然退出或已被同组信号回收。
    }
  }
}

async function collectPosixDescendantPids(rootPid: number): Promise<Set<number>> {
  let stdout: string;
  try {
    stdout = await Promise.race([
      readPosixProcessTable(),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(""), POSIX_PROCESS_LOOKUP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // ps 失败时按空后代集合退化，根进程组信号仍会继续。
    return new Set();
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    for (const pid of childrenByParent.get(parentPid) ?? []) {
      if (pid <= 1 || pid === rootPid || descendants.has(pid)) continue;
      descendants.add(pid);
      queue.push(pid);
    }
  }
  return descendants;
}

function readPosixProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    let processTable: ChildProcess;
    try {
      processTable = spawn("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
        cwd: "/",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    processTable.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk;
    });
    processTable.once("error", reject);
    processTable.once("close", () => resolve(stdout));
  });
}
