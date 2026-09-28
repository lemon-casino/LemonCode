/* 远程控制本地持久化:接入 Key、非明文配置与已授权设备哈希表。
 * 方案(specs/mobile-remote-control-cf-workers.md §桌面端改动 1/4)要求接入 Key 复用凭据集中管理机制、
 * 不进明文配置;这里复用 Main 进程既有 createCredentialService(加密落盘 + 文件锁),
 * 与 packages/ui/src/root/useRemoteWorkspaceHistory.ts 的 credentialService 是同一存储契约。 */
import {
  remoteControlPersistedDeviceSchema,
  REMOTE_CONTROL_MAX_PERSISTED_DEVICES,
  DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS,
  type RemoteControlPersistedDevice,
} from "@lcode/shared";
import { z } from "zod";

export const REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY = "remoteControl.accessKey";
export const REMOTE_CONTROL_CONFIG_CREDENTIAL_KEY = "remoteControl.config";
export const REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY = "remoteControl.devices";

/** 与 @lcode/services ICredentialService 的 load/save/delete 面(测试注入用窄接口)。 */
export interface RemoteControlCredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RemoteControlStoreLogger {
  warn: (...args: unknown[]) => void;
}

/** 持久化的非敏感配置部分;hasAccessKey 是派生事实,不落盘。 */
export const remoteControlPersistedConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    workerBaseUrl: z.string().default(""),
    pairingTtlMs: z.number().int().positive().default(DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS),
    allowNewDevices: z.boolean().default(true),
    idleDisconnectMs: z.number().int().nonnegative().default(0),
  })
  .strict();
export type RemoteControlPersistedConfig = z.infer<typeof remoteControlPersistedConfigSchema>;

export interface RemoteControlStore {
  loadAccessKey(): Promise<string | null>;
  saveAccessKey(accessKey: string): Promise<void>;
  loadConfig(): Promise<RemoteControlPersistedConfig>;
  saveConfig(config: RemoteControlPersistedConfig): Promise<void>;
  loadDevices(): Promise<RemoteControlPersistedDevice[]>;
  saveDevices(devices: RemoteControlPersistedDevice[]): Promise<void>;
}

export function createRemoteControlStore(options: {
  credentialService: RemoteControlCredentialService;
  logger: RemoteControlStoreLogger;
}): RemoteControlStore {
  const { credentialService, logger } = options;

  return {
    async loadAccessKey() {
      try {
        const value = await credentialService.load(REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY);
        return value && value.length > 0 ? value : null;
      } catch (error) {
        logger.warn("[remote-control-store] load access key failed:", error);
        return null;
      }
    },

    async saveAccessKey(accessKey) {
      await credentialService.save(REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY, accessKey);
    },

    async loadConfig() {
      try {
        const raw = await credentialService.load(REMOTE_CONTROL_CONFIG_CREDENTIAL_KEY);
        if (!raw) {
          return remoteControlPersistedConfigSchema.parse({});
        }
        const parsed = remoteControlPersistedConfigSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          // 配置损坏时回默认值并保留告警;凭据文件本体由 credentialService 负责备份策略。
          logger.warn("[remote-control-store] persisted config invalid, fallback to defaults");
          return remoteControlPersistedConfigSchema.parse({});
        }
        return parsed.data;
      } catch (error) {
        logger.warn("[remote-control-store] load config failed:", error);
        return remoteControlPersistedConfigSchema.parse({});
      }
    },

    async saveConfig(config) {
      const validated = remoteControlPersistedConfigSchema.parse(config);
      await credentialService.save(
        REMOTE_CONTROL_CONFIG_CREDENTIAL_KEY,
        JSON.stringify(validated),
      );
    },

    async loadDevices() {
      try {
        const raw = await credentialService.load(REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY);
        if (!raw) return [];
        const parsedJson: unknown = JSON.parse(raw);
        if (!Array.isArray(parsedJson)) return [];
        const devices: RemoteControlPersistedDevice[] = [];
        for (const entry of parsedJson) {
          const parsed = remoteControlPersistedDeviceSchema.safeParse(entry);
          if (parsed.success) {
            devices.push(parsed.data);
          } else {
            logger.warn("[remote-control-store] drop invalid persisted device entry");
          }
          if (devices.length >= REMOTE_CONTROL_MAX_PERSISTED_DEVICES) break;
        }
        return devices;
      } catch (error) {
        logger.warn("[remote-control-store] load devices failed:", error);
        return [];
      }
    },

    async saveDevices(devices) {
      // 已授权设备列表上限 64 条(PROTOCOL.md §4.3.2);超出时按最旧 lastSeenAt 淘汰。
      const bounded = [...devices]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, REMOTE_CONTROL_MAX_PERSISTED_DEVICES);
      await credentialService.save(
        REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY,
        JSON.stringify(bounded),
      );
    },
  };
}
