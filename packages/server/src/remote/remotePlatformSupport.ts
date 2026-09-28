import type { RemoteEnvironment } from "@lcode/server/remote/backend.js";

export function assertSupportedRemoteEnvironment(env: RemoteEnvironment): void {
  if (env.platform !== "win32") {
    return;
  }

  // deploy/connect 之前各自硬编码 Windows 拒绝逻辑，后续容易出现 skipDeploy 绕过或错误信息不一致。
  // 当前 remote 后端和启动命令仍依赖 POSIX shell；先集中能力边界，等 Windows shell strategy 接入后再统一放开。
  throw new Error("当前 remote 模式仅支持 POSIX shell 环境，暂不支持 Windows 原生远程主机");
}
