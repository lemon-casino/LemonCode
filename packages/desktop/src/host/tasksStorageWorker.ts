import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { prepareTasksIndexStorage } from "@lcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@lcode/shared";

const data = z
  .object({ path: z.string().min(1) })
  .strict()
  .parse(workerData);
try {
  await prepareTasksIndexStorage(data.path, (phase, migration) =>
    parentPort?.postMessage({ type: "progress", phase, migration }),
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
