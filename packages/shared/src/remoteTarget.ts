import type { z } from "zod";
import type {
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
} from "./remoteTargetSchema.js";

export type SSHConnectOptions = z.infer<typeof sshConnectOptionsSchema>;
export type WSLConnectOptions = z.infer<typeof wslConnectOptionsSchema>;
export type DockerConnectOptions = z.infer<typeof dockerConnectOptionsSchema>;

export type RemoteTarget = SSHConnectOptions | WSLConnectOptions | DockerConnectOptions;

/** 删除只应存在于当前连接流程中的 secret，供长期内存状态和跨进程回包使用。 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitized
    } = target;
    return sanitized;
  }

  return target;
}
