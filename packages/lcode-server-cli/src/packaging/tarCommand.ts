import { existsSync } from "node:fs";
import { join } from "node:path";

// Windows：Git Bash 可能把 GNU tar 前置到 PATH——它会把归档参数里的 `C:` 当远程主机、
// 也不能按 .zip 后缀写 zip，因此显式解析 System32 bsdtar，缺失时 fail-fast 而非回退
// PATH。非 Windows 宿主返回 PATH 解析的 "tar"，System32 仅是 Windows 的实现细节。
export function resolveHostTarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const system32Tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  if (!existsSync(system32Tar)) {
    throw new Error(
      `System32 tar.exe missing (${system32Tar}); Windows staging requires the OS-bundled bsdtar`,
    );
  }
  return system32Tar;
}

/** COPYFILE_DISABLE 判断需要同时命中裸 `tar` 与 System32 tar.exe 绝对路径两种形态。 */
export function isTarCommand(command: string): boolean {
  return command === "tar" || command.endsWith("\\tar.exe") || command.endsWith("/tar");
}
