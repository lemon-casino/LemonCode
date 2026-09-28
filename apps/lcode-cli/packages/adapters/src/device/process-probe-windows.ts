import {
  runProbeCommand,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/**
 * Windows：唯一允许的外部进程是 `tasklist`，一次调用拿全部进程内存。
 * 严禁改用 Windows 管理接口脚本宿主一类实现（见 spec 性能红线的禁用关键字清单）：
 * 历史事故就是那样每隔几秒起一个重进程，显著拖慢用户电脑。
 * tasklist 既没有 ppid 也没有累计 CPU 时间，因此这里只回直连进程的 RSS。
 */
export async function readWindowsProcessMemory(
  execFile: ProcessProbeExecFile,
  pids: readonly number[],
): Promise<readonly ProcessProbeSample[]> {
  const stdout = await runProbeCommand(execFile, "tasklist", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
  });
  const wanted = new Set(pids);
  const samples: ProcessProbeSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = parseCsvFields(line);
    const pid = Number(fields[1]);
    if (!wanted.has(pid)) continue;
    const memoryDigits = (fields[4] ?? "").replace(/\D/g, "");
    if (!memoryDigits) continue;
    const rssKb = Number(memoryDigits);
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    samples.push({ pid, rssKb });
  }
  return samples;
}

function parseCsvFields(line: string): string[] {
  const fields: string[] = [];
  for (const match of line.matchAll(/"((?:[^"]|"")*)"/g)) {
    fields.push((match[1] ?? "").replace(/""/g, '"'));
  }
  return fields;
}
