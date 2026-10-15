import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/** Host 观察到的启动入口字节 hash；未知命令不猜测，不读取或导出命令行中的其它文件。 */
export async function readAgentEntrySha256(command: {
  args?: string[];
  cwd?: string;
}): Promise<string | undefined> {
  const entry = command.args?.[0];
  if (!entry || !/^lcode(?:\.bytecode)?\.cjs$/.test(basename(entry))) return;
  try {
    const file = await open(resolve(command.cwd ?? process.cwd(), entry), "r");
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_ENTRY_BYTES) return;
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return;
      return hash.digest("hex");
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
