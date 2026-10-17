import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@lcode/shared";
import type { IRemoteBackend } from "./backend.js";
import type { SSHBackendOptions } from "./ssh-backend.js";

export interface RemoteBackendOptions {
  sshProxy?: SSHBackendOptions["openSocket"];
}

export async function createRemoteBackend(
  target: RemoteTarget,
  options: RemoteBackendOptions = {},
): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      if (target.useProxy && !options.sshProxy)
        throw new Error("SSH 代理模式需要本地主机的代理配置");
      const { SSHBackend } = await import("./ssh-backend.js");
      let privateKey: string | Buffer | undefined;
      if (target.privateKeyPath) {
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }

      return new SSHBackend({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKeyPath: target.privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
        openSocket: target.useProxy ? options.sshProxy : undefined,
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
  }
}
