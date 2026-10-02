import { posix, win32 } from "node:path";

export function buildFileHashParts(relativePath, bytes) {
  // Windows 相对路径中的反斜杠会改变 source hash；仅统一路径 key，保留原字节和 NUL 边界。
  return [relativePath.replaceAll(win32.sep, posix.sep), "\0", bytes, "\0"];
}

export function assertRegistryCurrent(actual, expected) {
  // checkout 的 CRLF 不是生成漂移；只规范换行，header、hash 和正文仍须完整一致。
  if (normalizeRegistryLineEndings(actual) !== normalizeRegistryLineEndings(expected)) {
    throw new Error(
      "Generated Bash command registry is stale. Run `pnpm --dir apps/lcode-cli registry:generate`.",
    );
  }
}

function normalizeRegistryLineEndings(bytes) {
  // latin1 与字节一一对应，避免 UTF-8 解码把不同无效字节都替换成同一个字符而漏报。
  return bytes.toString("latin1").replaceAll("\r\n", "\n");
}
