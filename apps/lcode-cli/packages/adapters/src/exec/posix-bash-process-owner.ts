import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { BashProcessOwner } from "./bash-process-owner.js";

const GRACE_MS = 200;
const EXIT_WAIT_MS = 1500;
const POLL_MS = 25;
const LOOKUP_MS = 1000;

export interface PosixBashMember {
  pid: number;
  group: number;
  session: number;
  identity: string;
  startedAt: number;
}

export interface PosixBashOwnerIO {
  members(): Promise<PosixBashMember[]>;
  signal(group: number, signal: NodeJS.Signals): void;
}

/** 独立 session/PGID 由本次 spawn 创建；退出后继续按 OS 创建身份核验，不按 cwd 认领。 */
export function createPosixBashProcessOwner(
  platform: NodeJS.Platform,
  io?: PosixBashOwnerIO,
): BashProcessOwner {
  const startedAt = Math.floor(Date.now() / 1000) * 1000;
  let rootPid: number | undefined;
  let rootExitedAt: number | undefined;
  let known: PosixBashMember[] | undefined;
  let settled = false;
  const backend = io ?? {
    members: () => readMembers(platform, rootPid!),
    signal: (group: number, signal: NodeJS.Signals) => {
      process.kill(-group, signal);
    },
  };
  const same = (a: PosixBashMember, b: PosixBashMember) =>
    a.pid === b.pid && a.identity === b.identity;
  async function current(): Promise<PosixBashMember[]> {
    const members = (await backend.members()).filter((member) => member.session === rootPid);
    if (!known) {
      known = members.filter(
        (member) =>
          member.startedAt >= startedAt && member.startedAt <= (rootExitedAt ?? Date.now()),
      );
    }
    if (members.length && !known.some((owned) => members.some((member) => same(owned, member)))) {
      // 原组已退出且 PGID 被复用；新组没有任何原成员，禁止向它发送信号。
      return [];
    }
    // 同一独立 session 的组仍由已核验成员维系，其在清理期间派生的新成员继续属于该组。
    known = members;
    return members;
  }
  async function signalOwned(signal: NodeJS.Signals): Promise<boolean> {
    const members = await current();
    if (!members.length) return false;
    // job control 会创建其它 PGID，但仍属于 spawn(detached) 创建的独立 session。
    for (const group of new Set(members.map((member) => member.group))) {
      try {
        backend.signal(group, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return true;
  }
  return {
    attach(child) {
      rootPid = child.pid;
      child.once("exit", () => {
        rootExitedAt = Date.now();
      });
    },
    async settle() {
      if (settled || !rootPid) return;
      if (await signalOwned("SIGTERM")) {
        const grace = Date.now() + GRACE_MS;
        while ((await current()).length && Date.now() < grace) await setTimeout(POLL_MS);
        await signalOwned("SIGKILL");
        const deadline = Date.now() + EXIT_WAIT_MS;
        while ((await current()).length) {
          if (Date.now() >= deadline)
            throw new Error("Bash process cleanup incomplete (POSIX group)");
          await setTimeout(POLL_MS);
        }
      }
      settled = true;
    },
  };
}

async function readMembers(
  platform: NodeJS.Platform,
  ownedGroup: number,
): Promise<PosixBashMember[]> {
  const columns =
    platform === "darwin" ? "pid=,pgid=,lstart=,stat=,command=" : "pid=,pgid=,lstart=,stat=,sid=";
  const { stdout } = await promisify(execFile)(
    "ps",
    [platform === "darwin" ? "-axo" : "-eo", columns],
    {
      encoding: "utf8",
      timeout: LOOKUP_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  const members: PosixBashMember[] = [];
  const darwinSession = platform === "darwin" ? await readDarwinSessionFunction() : undefined;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields[0]);
    const group = Number(fields[1]);
    const session = darwinSession ? darwinSession(pid) : Number(fields[8]);
    if (session !== ownedGroup) continue;
    const startedAt = Date.parse(fields.slice(2, 7).join(" "));
    if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(startedAt) || !fields[7])
      throw new Error("Cannot verify Bash process group identity");
    if (fields[7].startsWith("Z")) continue;
    // Darwin 的 ps 创建时间为秒级；沿用进程 owner 的 command 联合指纹，避免只依赖 PID。
    let identity = `${fields.slice(2, 7).join(" ")}|${platform === "darwin" ? fields.slice(8).join(" ") : ""}`;
    if (platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const values = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
        if (Number(values[2]) !== group || Number(values[3]) !== session || values[0] === "Z")
          continue;
        if (!values[19]) throw new Error("Cannot verify Linux Bash process birth");
        identity = `linux:${values[19]}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    members.push({ pid, group, session, identity, startedAt });
  }
  return members;
}

let darwinSessionFunction: Promise<(pid: number) => number> | undefined;
function readDarwinSessionFunction(): Promise<(pid: number) => number> {
  darwinSessionFunction ??= import("koffi").then(({ default: koffi }) => {
    // Darwin ps 的 sess 字段不是可移植的 getsid 值；通过系统公开接口读取本次 session。
    const libc = koffi.load("/usr/lib/libSystem.B.dylib");
    return libc.func("getsid", "int", ["int"]) as (pid: number) => number;
  });
  return darwinSessionFunction;
}
