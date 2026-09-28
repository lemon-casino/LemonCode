import { LCODE_AGENT_PROVIDER } from "@lcode/shared";
import type { IRemoteBackend } from "@lcode/server/remote/backend.js";
import { type DeployLoggers, waitForClose } from "@lcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@lcode/server/remote/posixShell.js";

export async function repairLegacyRemoteOfficialPluginDirectoryPermissions(params: {
  backend: IRemoteBackend;
  loggers: DeployLoggers;
  remoteOfficialPluginDir: string;
}): Promise<boolean> {
  // 旧版从 Windows 重打 packages tar 时会把目录 mode 写成 0666，远端叠加 umask 后
  // 落成不可遍历的 0644。3.3.3 升级到 3.3.4 时文件可能完整但版本变化仍要替换 packages，
  // 所以权限修复必须绑定“即将替换 packages”的部署路径，而不是健康远端的增量跳过路径。
  // IRemoteBackend.exists 只承诺检查远端文件，SSH / Docker 实现使用 test -f，
  // 因此目录存在性和 chmod 必须收敛在同一条远端 shell 命令中判断。
  params.loggers.logWarn(
    `[lcode-agent-deploy] ${LCODE_AGENT_PROVIDER}: 检查并修复旧 builtin plugin 目录权限 ${params.remoteOfficialPluginDir}`,
  );
  const quotedRemoteOfficialPluginDir = quotePosixPathArg(params.remoteOfficialPluginDir);
  const stream = await params.backend.exec(
    `if [ -d ${quotedRemoteOfficialPluginDir} ]; then command chmod -R u+rwX ${quotedRemoteOfficialPluginDir}; fi`,
  );
  try {
    await waitForClose(stream);
    return true;
  } catch (error) {
    // chmod 只是旧 WSL 坏权限目录的预修复，真实部署成败应由后续 packages 替换决定。
    // 某些 SSH / Docker 挂载卷或 ACL 环境可能拒绝 chmod，但 rm/tar 替换路径仍可成功。
    params.loggers.logWarn(
      `[lcode-agent-deploy] ${LCODE_AGENT_PROVIDER}: 修复旧 builtin plugin 目录权限失败，将继续尝试替换 packages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
