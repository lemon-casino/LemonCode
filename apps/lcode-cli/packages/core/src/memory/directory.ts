import {
  traceContextToLogContext,
  type FileSystemPort,
  type Logger,
  type TraceContext,
} from "@lcode/contracts";

export async function ensureMemoryDirectoryExists(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
  logger?: Logger,
): Promise<void> {
  try {
    await fileSystemPort.createDirectory({ path: rootDir, trace: traceContext });
  } catch (error) {
    // 目录预创建失败不阻断执行；实际 Write/Edit 仍返回原始文件错误。
    logger?.debug("Memory directory creation failed", {
      ...(traceContext ? traceContextToLogContext(traceContext) : {}),
      error: error instanceof Error ? error.message : String(error),
      event: "memory.directory.create_failed",
      module: "core.memory",
      status: "failed",
    });
  }
}
