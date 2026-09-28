import { createHash, randomUUID } from "node:crypto";
import { SqliteSessionStore, type SqliteMigrationProgress } from "@lcode/adapters/storage";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  lcodeProtocolNotifications,
  lcodeStorageStartupStateSchema,
  type LCodeStorageStartupState,
} from "@lcode/shared";

export async function openProtocolStartupStorage(options: {
  dbPath: string;
  output: NodeJS.WritableStream;
  onProgress?: (progress: LCodeStorageStartupState) => void;
}): Promise<SqliteSessionStore> {
  const attemptId = randomUUID();
  const databaseId = createHash("sha256").update(options.dbPath).digest("hex");
  let sequence = 0;
  let failedReported = false;
  const report = async (progress: SqliteMigrationProgress) => {
    const params = lcodeStorageStartupStateSchema.parse({
      schemaVersion: 1,
      attemptId,
      databaseId,
      databaseKind: "session",
      sequence: ++sequence,
      ...progress,
    });
    failedReported ||= params.phase === "failed";
    options.onProgress?.(params);
    // 不能先写入 JS 缓冲后立即阻塞执行 SQL；等待 Writable 确认控制帧已交给传输层。
    await new Promise<void>((resolve, reject) => {
      options.output.write(
        `${JSON.stringify({ method: lcodeProtocolNotifications.storageStartup, params })}\n`,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  };
  try {
    await report({ phase: "checking", elapsedMs: 0 });
    return await SqliteSessionStore.openStartup({ dbPath: options.dbPath }, { onProgress: report });
  } catch (error) {
    if (!failedReported) {
      try {
        await report({
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        });
      } catch {
        /* 传输已断开时保留最初的数据库/传输异常。 */
      }
    }
    throw error;
  }
}

/** 只准备存储，不创建 Provider/MCP/工作区 runtime；Host 确认观测边界后才允许写库。 */
export async function prepareProtocolStartupStorage(options: {
  dbPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { lcodeStoragePathReadySchema, classifyDatabaseStartupError } =
    await import("@lcode/shared");
  const lines = createInterface({ input: options.input });
  let timer: ReturnType<typeof setTimeout>;
  const acknowledgement = new Promise<boolean>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("Storage observation handshake timed out"), {
            kind: "startup_status_timeout",
          }),
        ),
      30_000,
    );
    lines.once("line", (line) => {
      try {
        if (line.length > 1024) throw new Error("Invalid storage acknowledgement");
        const ack = lcodeStoragePathReadySchema.parse(JSON.parse(line));
        resolve(ack.reuse ?? false);
      } catch (error) {
        reject(error);
      }
    });
    lines.once("close", () =>
      reject(
        Object.assign(new Error("Storage preparation input closed"), { kind: "transport_closed" }),
      ),
    );
  });
  // 路径通知发送失败时也要消费已创建的等待 promise，避免未处理拒绝。
  void acknowledgement.catch(() => {});
  let store: SqliteSessionStore | undefined;
  let failure: unknown;
  const write = (frame: unknown) =>
    new Promise<void>((resolve, reject) => {
      options.output.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  try {
    await write({ method: "startup/storagePath", params: { path: options.dbPath } });
    const reuse = await acknowledgement;
    clearTimeout(timer!);
    lines.close();
    // reuse 仅由同一次 Host 准备的成功路径集合授予；不打开连接，也不写永久跳过标记。
    if (!reuse) {
      store = await openProtocolStartupStorage(options);
      store.close();
      store = undefined;
    }
    await write({ method: "startup/storagePrepared", params: {} });
  } catch (error) {
    failure = error;
    try {
      await write({
        method: "startup/storageState",
        params: {
          schemaVersion: 1,
          attemptId: randomUUID(),
          databaseId: createHash("sha256").update(options.dbPath).digest("hex"),
          databaseKind: "session",
          sequence: 1,
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        },
      });
    } catch {
      /* 原始存储异常优先于失败通知的 IO 异常。 */
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    lines.close();
    try {
      store?.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
}
