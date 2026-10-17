import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock, atomicWritePrivateTextFile } from "@lcode/shared/node";
import { executionSetSnapshotSchema, type ExecutionSetSnapshot } from "@lcode/shared";
import type { ExecutionSetStore } from "../app/ports.js";
export function createExecutionSetStore(dataDir: string): ExecutionSetStore {
  const filename = (id: string) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid execution set id");
    return join(dataDir, `${id}.json`);
  };
  const read = async (id: string) => {
    try {
      const snapshot = executionSetSnapshotSchema.parse(
        JSON.parse(await readFile(filename(id), "utf8")),
      );
      if (snapshot.id !== id) throw new Error("Execution set identity differs from its record");
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    key: (value) => createHash("sha256").update(value).digest("hex").slice(0, 32),
    lock: (id, action) => withFileLock(`${filename(id)}.lock`, action, { lockMaxWaitMs: 30000 }),
    read,
    write: async (snapshot: ExecutionSetSnapshot) =>
      atomicWritePrivateTextFile(
        filename(snapshot.id),
        `${JSON.stringify(executionSetSnapshotSchema.parse(snapshot))}\n`,
      ),
    async list() {
      let files: string[];
      try {
        files = await readdir(dataDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const records = await Promise.all(
        files
          .filter((file) => /^[a-f0-9]{32}\.json$/.test(file))
          .map((file) => read(file.slice(0, -5))),
      );
      return records.filter((snapshot): snapshot is ExecutionSetSnapshot => Boolean(snapshot));
    },
  };
}
