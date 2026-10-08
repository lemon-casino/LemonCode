/* 远程控制本地持久化:接入 Key、非明文配置与已授权设备哈希表。
 * 方案(specs/mobile-remote-control-cf-workers.md §桌面端改动 1/4)要求接入 Key 复用凭据集中管理机制、
 * 不进明文配置;这里复用 Main 进程既有 createCredentialService(加密落盘 + 文件锁),
 * 与 packages/ui/src/root/useRemoteWorkspaceHistory.ts 的 credentialService 是同一存储契约。 */
import {
  DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
  remoteControlPersistedDeviceSchema,
  REMOTE_CONTROL_MAX_PERSISTED_DEVICES,
  DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS,
  type RemoteControlPersistedDevice,
} from "@lcode/shared";
import { z } from "zod";

export const REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY = "remoteControl.accessKey";
export const REMOTE_CONTROL_CLIENT_ID_CREDENTIAL_KEY = "remoteControl.clientId";
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
    workerBaseUrl: z.string().default(DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL),
    pairingTtlMs: z.number().int().positive().default(DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS),
    allowNewDevices: z.boolean().default(true),
    idleDisconnectMs: z.number().int().nonnegative().default(0),
  })
  .strict();
export type RemoteControlPersistedConfig = z.infer<typeof remoteControlPersistedConfigSchema>;

export interface RemoteControlStore {
  loadAccessKey(): Promise<string | null>;
  saveAccessKey(accessKey: string): Promise<void>;
  loadClientId(): Promise<string | null>;
  saveClientId(clientId: string): Promise<void>;
  loadConfig(): Promise<RemoteControlPersistedConfig>;
  saveConfig(config: RemoteControlPersistedConfig): Promise<void>;
  loadDevices(): Promise<RemoteControlPersistedDevice[]>;
  saveDevices(devices: RemoteControlPersistedDevice[]): Promise<void>;
  updateDevices(
    update: (devices: RemoteControlPersistedDevice[]) => RemoteControlPersistedDevice[],
    pinnedDeviceIds?: string[],
  ): Promise<void>;
}

export function createRemoteControlStore(options: {
  credentialService: RemoteControlCredentialService;
  logger: RemoteControlStoreLogger;
}): RemoteControlStore {
  const { credentialService, logger } = options;

  // 授权、lastSeen 与撤销共用一条串行写入路径，避免并发 load/save 覆盖另一台设备。
  let deviceWrites: Promise<void> = Promise.resolve();
  async function readDevices(): Promise<RemoteControlPersistedDevice[]> {
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
  }
  function enqueueDevices(
    update: (devices: RemoteControlPersistedDevice[]) => RemoteControlPersistedDevice[],
    pinnedDeviceIds: string[] = [],
  ): Promise<void> {
    const operation = deviceWrites.then(async () => {
      const pinned = new Set(pinnedDeviceIds);
      const devices = update(await readDevices());
      const bounded = [...devices]
        .sort(
          (a, b) =>
            Number(pinned.has(b.deviceId)) - Number(pinned.has(a.deviceId)) ||
            b.lastSeenAt - a.lastSeenAt,
        )
        .slice(0, REMOTE_CONTROL_MAX_PERSISTED_DEVICES)
        .map((device) => remoteControlPersistedDeviceSchema.parse(device));
      await credentialService.save(REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY, JSON.stringify(bounded));
    });
    deviceWrites = operation.catch(() => {});
    return operation;
  }

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

    async loadClientId() {
      try {
        const value = await credentialService.load(REMOTE_CONTROL_CLIENT_ID_CREDENTIAL_KEY);
        return value && value.length > 0 ? value : null;
      } catch (error) {
        logger.warn("[remote-control-store] load client id failed:", error);
        return null;
      }
    },

    async saveClientId(clientId) {
      await credentialService.save(REMOTE_CONTROL_CLIENT_ID_CREDENTIAL_KEY, clientId);
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
        // 旧版本把未配置地址持久化成空串；迁移为空即回到官方托管服务，避免升级后
        // 仍被当作“未配置”而要求用户手工填写。
        return parsed.data.workerBaseUrl.trim()
          ? parsed.data
          : { ...parsed.data, workerBaseUrl: DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL };
      } catch (error) {
        logger.warn("[remote-control-store] load config failed:", error);
        return remoteControlPersistedConfigSchema.parse({});
      }
    },

    async saveConfig(config) {
      const validated = remoteControlPersistedConfigSchema.parse(config);
      await credentialService.save(REMOTE_CONTROL_CONFIG_CREDENTIAL_KEY, JSON.stringify(validated));
    },

    async loadDevices() {
      await deviceWrites;
      return readDevices();
    },
    saveDevices(devices) {
      return enqueueDevices(() => devices);
    },
    updateDevices(update, pinnedDeviceIds) {
      return enqueueDevices(update, pinnedDeviceIds);
    },
  };
}
