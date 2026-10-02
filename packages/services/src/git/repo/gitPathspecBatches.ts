/** 路径按命令字节预算分批，不限制总文件数；兼容 Windows argv 与 UTF-8 平台。 */
export function batchGitPathspecs(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [],
    bytes = 0;
  for (const path of paths) {
    // 中文依据：移除文件数量门槛后，不能再把所有长路径一次塞进 Windows 命令行。
    const cost = Buffer.byteLength(path, "utf8") * 2 + 3;
    if (batch.length && bytes + cost > 8_000) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
