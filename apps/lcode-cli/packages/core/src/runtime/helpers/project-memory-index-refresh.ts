import { join } from "node:path";
import type { FileSystemPort } from "@lcode/contracts";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";

const INDEX_READ_MAX_BYTES = 64 * 1024;
const PARTIAL_INDEX_NOTE =
  "\n\n> MEMORY.md was partially loaded. Keep this index short; use topic files for detail.";

export async function refreshProjectMemoryIndex(
  runtime: { memoryRoot?: string; memoryIndexContent?: string; fileSystemPort?: FileSystemPort },
  signal?: AbortSignal,
): Promise<void> {
  if (!runtime.memoryRoot || !runtime.fileSystemPort) return;
  signal?.throwIfAborted();
  let content: string | undefined;
  try {
    const read = await runtime.fileSystemPort.readTextFile(
      { path: join(runtime.memoryRoot, "MEMORY.md"), maxBytes: INDEX_READ_MAX_BYTES },
      { signal },
    );
    signal?.throwIfAborted();
    const formatted = formatProjectMemoryIndexContent(read.content);
    content = formatted ? formatted + (read.truncated ? PARTIAL_INDEX_NOTE : "") : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    // 外部编辑/删除后的索引不可继续沿用初始化快照；topic召回仍独立处理失败。
    content = undefined;
  }
  runtime.memoryIndexContent = content;
}
