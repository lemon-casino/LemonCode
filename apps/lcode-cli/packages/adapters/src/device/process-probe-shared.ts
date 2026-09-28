import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileOptionsWithStringEncoding } from "node:child_process";

/**
 * 通用进程探针的共享契约与平台无关工具。
 * 平台实现（darwin / linux / win32）各自一个文件，只依赖本文件，不互相依赖。
 */
export interface ProcessProbeSample {
  pid: number;
  rssKb: number;
  /** 进程启动以来的累计 CPU 时间；Windows 无此数据，字段缺席而不是填 0 */
  cpuTimeMs?: number;
}

export interface ProcessProbeCommandResult {
  error?: unknown;
  status: number | null;
  stderr: string;
  stdout: string;
}

export type ProcessProbeExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
) => Promise<ProcessProbeCommandResult>;

/** 进程间关系与 CPU 时间；RSS 由各平台单独取得（Linux 要多读一次 `status`）。 */
export interface ProcessRelation {
  cpuTimeMs?: number;
  parentPid?: number;
  pid: number;
  processGroupId?: number;
}

export interface ProcessRow extends ProcessRelation {
  rssKb: number;
}

export const PROCESS_PROBE_SAMPLE_TIMEOUT_MS = 1_000;

const PROCESS_PROBE_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;

/** 采样失败：调用方一律翻译成「本次无样本」，并累计连续失败次数。 */
export class ProcessProbeFailure extends Error {}

/** 把进程表按 parentPid 展开成每个根 pid 的进程树；根不存在时不出现在结果里。 */
export function groupProcessTrees(
  rows: readonly ProcessRow[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly ProcessProbeSample[]> {
  const rowByPid = new Map(rows.map((row) => [row.pid, row]));
  const trees = new Map<number, readonly ProcessProbeSample[]>();
  for (const [rootPid, treePids] of collectProcessTreePids(rows, rootPids)) {
    trees.set(
      rootPid,
      treePids.flatMap((pid) => {
        const row = rowByPid.get(pid);
        return row ? [toSample(row)] : [];
      }),
    );
  }
  return trees;
}

/** 每个根 pid 的进程树成员 pid（含根自身），按 DFS 顺序；根不在进程表里则整棵树缺席。 */
export function collectProcessTreePids(
  relations: readonly ProcessRelation[],
  rootPids: readonly number[],
): ReadonlyMap<number, readonly number[]> {
  const knownPids = new Set(relations.map((relation) => relation.pid));
  const childrenByParent = new Map<number, number[]>();
  for (const relation of relations) {
    if (relation.parentPid === undefined) continue;
    const children = childrenByParent.get(relation.parentPid) ?? [];
    children.push(relation.pid);
    childrenByParent.set(relation.parentPid, children);
  }
  const trees = new Map<number, readonly number[]>();
  for (const rootPid of rootPids) {
    if (!knownPids.has(rootPid)) continue;
    const treePids: number[] = [];
    const visited = new Set<number>();
    const visit = (pid: number): void => {
      if (visited.has(pid)) return;
      visited.add(pid);
      treePids.push(pid);
      for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    };
    visit(rootPid);
    trees.set(rootPid, treePids);
  }
  return trees;
}

export async function runProbeCommand(
  execFile: ProcessProbeExecFile,
  file: string,
  args: readonly string[],
  extraOptions: Partial<ExecFileOptionsWithStringEncoding> = {},
): Promise<string> {
  const result = await execFile(file, args, {
    encoding: "utf8",
    maxBuffer: PROCESS_PROBE_MAX_BUFFER_BYTES,
    timeout: PROCESS_PROBE_SAMPLE_TIMEOUT_MS,
    ...extraOptions,
  });
  if (result.error || result.status !== 0) {
    throw new ProcessProbeFailure(
      `${file} 采样失败: ${result.stderr.trim() || String(result.status)}`,
    );
  }
  return result.stdout;
}

export function toSample(row: ProcessRow): ProcessProbeSample {
  return {
    pid: row.pid,
    rssKb: row.rssKb,
    ...(row.cpuTimeMs === undefined ? {} : { cpuTimeMs: row.cpuTimeMs }),
  };
}

export function isSamplablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

export function defaultProbeExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<ProcessProbeCommandResult> {
  return new Promise((resolve) => {
    nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
      resolve({
        ...(error ? { error } : {}),
        status: resolveExitStatus(error),
        stderr,
        stdout,
      });
    });
  });
}

function resolveExitStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}
