import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ObservationChangeEvent,
  ObservationHelloEvent,
  ObservationSourceErrorEvent,
  ObservationSourceFingerprint,
  ObservationSourceKind,
} from "../src/shared.js";
import { defaultDbPath, defaultLogDir } from "./sources.js";
import type { ObservationOptions } from "./types.js";

interface ObservationEventStreamOptions {
  intervalMs?: number;
  now?: () => Date;
}

interface ObservationWatchTarget {
  kind: ObservationSourceKind;
  label: string;
  path: string;
  jsonlOnly?: boolean;
  ignoreMtime?: boolean;
}

const DEFAULT_OBSERVATION_EVENT_INTERVAL_MS = 750;
const MIN_OBSERVATION_EVENT_INTERVAL_MS = 50;
const OBSERVATION_EVENT_RETRY_MS = 1500;

export function createObservationEventStream(
  options: ObservationOptions,
  streamOptions: ObservationEventStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const intervalMs = normalizeInterval(streamOptions.intervalMs);
  const now = streamOptions.now ?? (() => new Date());
  let revision = 0;
  let previousSources: ObservationSourceFingerprint[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checking = false;

  const encodeEvent = (type: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const enqueueEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    type: string,
    data: unknown,
  ): void => {
    if (closed) return;
    try {
      controller.enqueue(encodeEvent(type, data));
    } catch {
      closed = true;
    }
  };

  const checkSources = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (checking || closed) return;
    checking = true;
    try {
      const nextSources = await fingerprintObservationSources(options);
      const changedSources = diffSources(previousSources, nextSources);
      if (changedSources.length > 0) {
        previousSources = nextSources;
        revision += 1;
        const event: ObservationChangeEvent = {
          revision,
          changedAt: now().toISOString(),
          changedSources,
          sources: nextSources,
        };
        enqueueEvent(controller, "change", event);
      }
    } catch (error) {
      const event: ObservationSourceErrorEvent = {
        checkedAt: now().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      };
      enqueueEvent(controller, "source-error", event);
    } finally {
      checking = false;
    }
  };

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`retry: ${OBSERVATION_EVENT_RETRY_MS}\n\n`));
      previousSources = await fingerprintObservationSources(options);
      const hello: ObservationHelloEvent = {
        generatedAt: now().toISOString(),
        intervalMs,
        sources: previousSources,
      };
      enqueueEvent(controller, "hello", hello);
      timer = setInterval(() => {
        void checkSources(controller);
      }, intervalMs);
      timer.unref?.();
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
}

export async function fingerprintObservationSources(
  options: ObservationOptions,
): Promise<ObservationSourceFingerprint[]> {
  const fingerprints: ObservationSourceFingerprint[] = [];
  for (const target of observationWatchTargets(options)) {
    fingerprints.push(await fingerprintTarget(target));
  }
  return fingerprints;
}

function observationWatchTargets(options: ObservationOptions): ObservationWatchTarget[] {
  const dbPath = resolve(options.dbPath ?? defaultDbPath());
  const targets: ObservationWatchTarget[] = [
    {
      kind: "log",
      label: "结构化日志",
      path: resolve(options.logDir ?? defaultLogDir()),
      jsonlOnly: true,
    },
  ];

  if (options.eventPath) {
    targets.push({
      kind: "eventlog",
      label: "Session 事件 JSONL",
      path: resolve(options.eventPath),
      jsonlOnly: true,
    });
  }

  targets.push(
    {
      kind: "sqlite",
      label: "SQLite Session 数据库",
      path: dbPath,
    },
    {
      kind: "sqlite",
      label: "SQLite WAL",
      path: `${dbPath}-wal`,
    },
    {
      kind: "sqlite",
      label: "SQLite SHM",
      path: `${dbPath}-shm`,
      ignoreMtime: true,
    },
  );

  return targets;
}

async function fingerprintTarget(
  target: ObservationWatchTarget,
): Promise<ObservationSourceFingerprint> {
  try {
    const inputStat = await stat(target.path);
    if (inputStat.isDirectory()) {
      const entries = (await readdir(target.path))
        .filter((entry) => !target.jsonlOnly || entry.endsWith(".jsonl") || entry.endsWith(".log"))
        .sort();
      const parts: string[] = [];
      for (const entry of entries) {
        const entryPath = join(target.path, entry);
        try {
          const entryStat = await stat(entryPath);
          const kind = entryStat.isDirectory() ? "dir" : "file";
          parts.push(`${entry}:${kind}:${entryStat.size}:${mtimeSignature(entryStat.mtimeMs)}`);
        } catch {
          parts.push(`${entry}:missing`);
        }
      }
      return {
        kind: target.kind,
        label: target.label,
        path: target.path,
        exists: true,
        signature: `dir:${mtimeSignature(inputStat.mtimeMs)}:${parts.join("|")}`,
      };
    }

    // SQLite readers, including this debug app's own read-only analyzer pass, can update
    // the WAL shared-memory file mtime. Treating that mtime as data change makes the UI
    // refresh itself forever, so SHM fingerprints only track existence and size.
    const signature = target.ignoreMtime
      ? `file:${inputStat.size}`
      : `file:${inputStat.size}:${mtimeSignature(inputStat.mtimeMs)}`;

    return {
      kind: target.kind,
      label: target.label,
      path: target.path,
      exists: true,
      signature,
    };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        kind: target.kind,
        label: target.label,
        path: target.path,
        exists: false,
        signature: "missing",
      };
    }
    return {
      kind: target.kind,
      label: target.label,
      path: target.path,
      exists: false,
      signature: `error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function diffSources(
  previousSources: ObservationSourceFingerprint[],
  nextSources: ObservationSourceFingerprint[],
): ObservationSourceFingerprint[] {
  const previousByKey = new Map(
    previousSources.map((source) => [sourceFingerprintKey(source), source.signature]),
  );
  return nextSources.filter(
    (source) => previousByKey.get(sourceFingerprintKey(source)) !== source.signature,
  );
}

function sourceFingerprintKey(source: ObservationSourceFingerprint): string {
  return `${source.kind}:${source.label}:${source.path}`;
}

function normalizeInterval(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OBSERVATION_EVENT_INTERVAL_MS;
  }
  return Math.max(Math.trunc(value), MIN_OBSERVATION_EVENT_INTERVAL_MS);
}

function mtimeSignature(value: number): string {
  return Math.floor(value).toString(36);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
