import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  frozenManifestSchema,
  runtimeEnvironmentRecordSchema,
  runtimePreparationOperationSchema,
  type RuntimeEnvironmentRecord,
} from "@lcode/shared";
import { scopeKeyHash, type RuntimeEnvironmentStore } from "../app/ports.js";

/**
 * 环境持久化实现（spec: specs/worktree-runtime-environments.md §8.2/§8.3）。
 * records/operations/manifests 全部在 HostDataRoot 的 runtime-environments/ 下。
 * 严格校验：损坏/未知版本记录明确失败不修成 ready；短记录锁，不覆盖长安装。
 * port 类型在 app/ports.ts（层向：adapters→app 允许）。
 */

export type { RuntimeEnvironmentStore };

function manifestRecordId(environmentId: string, revision: number): string {
  return scopeKeyHash(["manifest", environmentId, revision]);
}

export function createRuntimeEnvironmentStore(dataDir: string): RuntimeEnvironmentStore {
  const root = resolve(dataDir);
  const recordPath = (kind: string, id: string) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid runtime environment record id");
    return join(root, kind, `${id}.json`);
  };

  async function readRecord<T>(
    kind: string,
    id: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(recordPath(kind, id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return parse(JSON.parse(raw));
    } catch (error) {
      // 根因：损坏或未知 schemaVersion 的记录不能被静默修成 ready（spec §8.3）。
      throw new Error(
        `Runtime environment record ${kind}/${id} is corrupt or has an unknown schema version`,
        { cause: error },
      );
    }
  }

  return {
    async lock(key, action) {
      await withFileLock(recordPath("locks", key), action, { lockMaxWaitMs: 30_000 });
    },
    readEnvironment: (id) =>
      readRecord("records", id, (value) => {
        const record = runtimeEnvironmentRecordSchema.parse(value);
        if (record.environmentId !== id) throw new Error("Record ID does not match its filename");
        return record;
      }),
    saveEnvironment: async (record) => {
      await atomicWritePrivateTextFile(
        recordPath("records", record.environmentId),
        `${JSON.stringify(runtimeEnvironmentRecordSchema.parse(record), null, 2)}\n`,
      );
    },
    listEnvironments: async () => {
      let files: string[];
      try {
        files = await readdir(join(root, "records"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const values: RuntimeEnvironmentRecord[] = [];
      for (const file of files.filter((name) => /^[a-f0-9]{32}\.json$/.test(name))) {
        const id = file.slice(0, -5);
        const record = await readRecord("records", id, (value) =>
          runtimeEnvironmentRecordSchema.parse(value),
        );
        if (record) values.push(record);
      }
      return values;
    },
    readOperation: (id) =>
      readRecord("operations", id, (value) => {
        const operation = runtimePreparationOperationSchema.parse(value);
        if (operation.operationId !== id) throw new Error("Operation ID does not match filename");
        return operation;
      }),
    saveOperation: async (operation) => {
      await atomicWritePrivateTextFile(
        recordPath("operations", operation.operationId),
        `${JSON.stringify(runtimePreparationOperationSchema.parse(operation), null, 2)}\n`,
      );
    },
    readManifest: (environmentId, revision) =>
      readRecord("manifests", manifestRecordId(environmentId, revision), (value) =>
        frozenManifestSchema.parse(value),
      ),
    saveManifest: async (environmentId, revision, manifest) => {
      await atomicWritePrivateTextFile(
        recordPath("manifests", manifestRecordId(environmentId, revision)),
        `${JSON.stringify(frozenManifestSchema.parse(manifest), null, 2)}\n`,
      );
    },
    removeEnvironment: async (id) => {
      recordPath("records", id);
      await rm(recordPath("records", id), { force: true });
    },
  };
}

/** HostDataRoot 下环境资源目录布局（spec §8.3）；组合根注入用。 */
export function runtimeEnvironmentDataDirs(dataDir: string): {
  root: string;
  toolBackends: string;
  toolStore: string;
  packageStore: string;
} {
  const base = resolve(dataDir);
  return {
    root: base,
    toolBackends: join(base, "tool-backends"),
    toolStore: join(base, "tool-store"),
    packageStore: join(base, "package-store"),
  };
}
