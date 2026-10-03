import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import type { WorktreeBinding, WorktreeIntegration } from "../contract.js";
import type { WorktreeStore } from "../app/ports.js";
import { bindingRecord, operationRecord } from "./records.js";
import { createWorktreeAliases } from "./aliases.js";

export function createWorktreeStore(dataDir: string): WorktreeStore {
  const root = resolve(dataDir);
  const checkouts = join(root, "checkouts");
  function recordPath(kind: string, id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid worktree record id");
    return join(root, kind, `${id}.json`);
  }
  async function read(kind: string, id: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(recordPath(kind, id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function write(kind: string, id: string, value: unknown) {
    await atomicWritePrivateTextFile(recordPath(kind, id), `${JSON.stringify(value)}\n`);
  }
  async function assertManagedPath(path: string) {
    const normalized = resolve(path);
    const child = relative(checkouts, normalized);
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === ".." ||
      isAbsolute(child) ||
      child.includes(sep)
    ) {
      throw new Error("Worktree path is outside the managed checkout root");
    }
    await mkdir(checkouts, { recursive: true });
    if (
      (await lstat(checkouts)).isSymbolicLink() ||
      resolve(await realpath(checkouts)) !== checkouts
    ) {
      throw new Error("Managed checkout root has been redirected");
    }
    try {
      if (
        (await lstat(normalized)).isSymbolicLink() ||
        resolve(await realpath(normalized)) !== normalized
      ) {
        throw new Error("Managed checkout has been redirected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    ...createWorktreeAliases(root),
    key: (value) => createHash("sha256").update(value).digest("hex").slice(0, 32),
    checkout: (id) => {
      recordPath("bindings", id);
      return join(checkouts, id);
    },
    lock: (key, action) =>
      withFileLock(recordPath("locks", key), action, { lockMaxWaitMs: 30_000 }),
    async readBinding(id) {
      const value = await read("bindings", id);
      if (value === null) return null;
      const binding = bindingRecord.parse(value);
      if (binding.id !== id) throw new Error("Worktree record ID does not match its filename");
      return binding;
    },
    async saveBinding(binding: WorktreeBinding) {
      await write("bindings", binding.id, bindingRecord.parse(binding));
    },
    async readPreparationRequest(scope, requestId) {
      const id = createHash("sha256")
        .update(JSON.stringify([scope, requestId]))
        .digest("hex")
        .slice(0, 32);
      const value = await read("requests", id);
      if (value === null) return null;
      if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
        throw new Error("Invalid preparation request record");
      return value;
    },
    async savePreparationRequest(scope, requestId, bindingId) {
      const id = createHash("sha256")
        .update(JSON.stringify([scope, requestId]))
        .digest("hex")
        .slice(0, 32);
      await write("requests", id, bindingId);
    },
    async isPreparationCancelled(id) {
      return (await read("cancellations", id)) === true;
    },
    async cancelPreparation(id) {
      await write("cancellations", id, true);
    },
    async listBindings() {
      let files: string[];
      try {
        files = await readdir(join(root, "bindings"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const values = await Promise.all(
        files
          .filter((file) => /^[a-f0-9]{32}\.json$/.test(file))
          .map(async (file) => {
            const value = bindingRecord.parse(await read("bindings", file.slice(0, -5)));
            if (`${value.id}.json` !== file)
              throw new Error("Worktree record ID does not match its filename");
            return value;
          }),
      );
      return values;
    },
    async readOperation(id) {
      const value = await read("operations", id);
      if (value === null) return null;
      const operation = operationRecord.parse(value);
      if (operation.id !== id) throw new Error("Integration record ID does not match its filename");
      return operation;
    },
    async saveOperation(operation: WorktreeIntegration) {
      await write("operations", operation.id, operationRecord.parse(operation));
    },
    assertManagedPath,
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
