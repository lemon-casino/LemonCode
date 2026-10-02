import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const RSS_BUDGET_BYTES = 1.5 * 1024 ** 3;
export const SAMPLE_CAP = 420;
export interface ResourceSample {
  wallMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
}

export function slope(samples: readonly ResourceSample[], field: "rssBytes" | "heapUsedBytes") {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((sum, value) => sum + value.wallMs / 1_000, 0) / samples.length;
  const meanY = samples.reduce((sum, value) => sum + value[field], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const value of samples) {
    const x = value.wallMs / 1_000 - meanX;
    numerator += x * (value[field] - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function createResourceMeter() {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const samples: ResourceSample[] = [];
  let rssPeakBytes = 0;
  let heapPeakBytes = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    const used = process.cpuUsage(cpu);
    const value: ResourceSample = {
      wallMs: performance.now() - started,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      cpuUserMicros: used.user,
      cpuSystemMicros: used.system,
    };
    rssPeakBytes = Math.max(rssPeakBytes, memory.rss);
    heapPeakBytes = Math.max(heapPeakBytes, memory.heapUsed);
    // 基准只保留固定上限采样，不把观察日志的线性增长误报成产品泄漏。
    if (samples.length === SAMPLE_CAP) samples.splice(1, 1);
    samples.push(value);
    return value;
  };
  sample();
  return {
    sample,
    summary() {
      const end = sample();
      const start = samples[0]!;
      const steady = samples.filter((value) => value.wallMs >= Math.min(10_000, end.wallMs / 2));
      return {
        wallMs: end.wallMs,
        cpuUserMicros: end.cpuUserMicros,
        cpuSystemMicros: end.cpuSystemMicros,
        cpuPercentOneCore: ((end.cpuUserMicros + end.cpuSystemMicros) / (end.wallMs * 1_000)) * 100,
        rssStartBytes: start.rssBytes,
        rssPeakBytes,
        rssEndBytes: end.rssBytes,
        heapStartBytes: start.heapUsedBytes,
        heapPeakBytes,
        heapEndBytes: end.heapUsedBytes,
        steadyRssBytesPerSecond: slope(steady, "rssBytes"),
        steadyHeapBytesPerSecond: slope(steady, "heapUsedBytes"),
        steadySampleCount: steady.length,
        sampleCap: SAMPLE_CAP,
        samples,
      };
    },
  };
}

export function createTimerOwner() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let scheduled = 0;
  let fired = 0;
  let cancelled = 0;
  let peak = 0;
  return {
    schedule(callback: () => void, ms: number) {
      scheduled++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        fired++;
        callback();
      }, ms);
      timers.add(timer);
      peak = Math.max(peak, timers.size);
      return () => {
        if (timers.delete(timer)) {
          cancelled++;
          clearTimeout(timer);
        }
      };
    },
    summary: () => ({ scheduled, fired, cancelled, peak, remaining: timers.size }),
    clear() {
      for (const timer of timers) {
        clearTimeout(timer);
        cancelled++;
      }
      timers.clear();
    },
  };
}

export async function fingerprint(directory: string, extension: string) {
  const hash = createHash("sha256");
  let count = 0;
  let oldestMtimeMs = Infinity;
  let newestMtimeMs = 0;
  async function walk(folder: string) {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(extension) && !entry.name.includes(".test.")) {
        const [data, info] = await Promise.all([readFile(path), stat(path)]);
        hash.update(path.slice(directory.length).replaceAll("\\", "/"));
        hash.update(data);
        count++;
        oldestMtimeMs = Math.min(oldestMtimeMs, info.mtimeMs);
        newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs);
      }
    }
  }
  await walk(directory);
  return { sha256: hash.digest("hex"), files: count, oldestMtimeMs, newestMtimeMs };
}
