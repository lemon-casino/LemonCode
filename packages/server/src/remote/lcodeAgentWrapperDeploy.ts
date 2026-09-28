import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRemoteBackend } from "@lcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  waitForClose,
} from "@lcode/server/remote/deployShared.js";
import { buildWriteLiteralFileCommand } from "@lcode/server/remote/posixShell.js";

export function isWslBackend(backend: IRemoteBackend): boolean {
  return (backend as { kind?: string }).kind === "wsl";
}

export async function deployRemoteAgentWrapper(params: {
  backend: IRemoteBackend;
  content: string;
  remoteWrapperPath: string;
}): Promise<void> {
  const remoteWrapperTempPath = `${params.remoteWrapperPath}.new`;
  if (isWslBackend(params.backend)) {
    const localTempPath = join(tmpdir(), `lcode-agent-wrapper-${process.pid}-${Date.now()}.sh`);
    try {
      // WSL 的 `wsl.exe -- bash -lc <command>` 会让多行 shell 参数里的
      // `$HOME`、`$runtime_root`、`$@` 提前展开，生成 `exec "/node" ...` 的坏 wrapper。
      // 仅 WSL 按字节上传临时文件，SSH 仍走远端 shell 写入路径。
      await writeFile(localTempPath, params.content, "utf8");
      await params.backend.upload(localTempPath, remoteWrapperTempPath);
      const replaceStream = await params.backend.exec(
        buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteWrapperPath),
      );
      await waitForClose(replaceStream);
    } finally {
      await rm(localTempPath, { force: true });
    }
    return;
  }

  const stream = await params.backend.exec(
    [
      buildWriteLiteralFileCommand(remoteWrapperTempPath, params.content),
      buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteWrapperPath),
    ].join(" && "),
  );
  await waitForClose(stream);
}
