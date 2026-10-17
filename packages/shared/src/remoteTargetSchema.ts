import { z } from "zod";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import { wslUserSchema } from "./wslUserValidation.js";

const text = z.string().trim().min(1);

// 修复：连接入口与持久化目标曾独立维护字段，代理选择在 IPC 中被静默丢弃。
// 所有连接类型与历史 schema 从这里派生，目录展示则继续采用独立的严格白名单。
export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: text,
  port: z.number().int().positive().max(65535).optional(),
  username: text,
  sshConfigAlias: text.optional(),
  /** 复用本机设置代理；缺省直连，不在目标中复制代理凭据。 */
  useProxy: z.boolean().optional(),
  /** 设置代理库 ID；缺省时兼容设置中的默认代理。 */
  proxyProfileId: text.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: text,
});

export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
]);
