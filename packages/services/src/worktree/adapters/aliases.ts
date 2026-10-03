import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
import { z } from "zod";
import type { WorktreeSessionAlias } from "../app/ports.js";

const aliasSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    taskId: z.string().min(1),
    parentTaskId: z.string().min(1),
    bindingId: z.string().regex(/^[a-f0-9]{32}$/),
    originalKey: z.string().min(1),
    executionKey: z.string().min(1),
  })
  .strict();

export function createWorktreeAliases(dataDir: string) {
  const root = join(dataDir, "session-aliases");
  const path = (id: string) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid session alias record ID");
    return join(root, `${id}.json`);
  };
  async function readAlias(id: string) {
    try {
      const value = aliasSchema.parse(JSON.parse(await readFile(path(id), "utf8")));
      if (value.id !== id) throw new Error("Session alias record does not match its filename");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return {
    readAlias,
    async saveAlias(alias: WorktreeSessionAlias) {
      await atomicWritePrivateTextFile(
        path(alias.id),
        `${JSON.stringify(aliasSchema.parse(alias))}\n`,
      );
    },
    async listAliases() {
      let files: string[];
      try {
        files = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const values = await Promise.all(
        files
          .filter((file) => /^[a-f0-9]{32}\.json$/.test(file))
          .map((file) => readAlias(file.slice(0, -5))),
      );
      return values.filter((alias): alias is WorktreeSessionAlias => alias !== null);
    },
  };
}
