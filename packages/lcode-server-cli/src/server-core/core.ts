import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  materializeLCodeBuiltinProviderConfig,
  getAppConfigDir,
  LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@lcode/services/node";
import { ILCodeAgentService } from "@lcode/services";
import { LCODE_VERSION } from "@lcode/shared";
import { createCoreHttpServer } from "./http.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";

declare const __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(generation: number): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const explicitLCodeBuiltinProviderConfigFilePath =
    process.env[LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const lcodeBuiltinProviderConfigFilePath = explicitLCodeBuiltinProviderConfigFilePath
    ? explicitLCodeBuiltinProviderConfigFilePath
    : typeof __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeLCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!lcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 LCode Built-in Provider Config，且未设置 ${LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const services = createLocalServices({
    lcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
  });
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(ILCodeAgentService));
  const http = await createCoreHttpServer(services, { serverId: await resolveCoreServerId() });
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: LCODE_VERSION,
    generation,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({ type: "task-activity", runningTaskCount });
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({ type: "task-activity", runningTaskCount });
        }
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount });
      })
      .catch(() => {
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount: lastRunningTaskCount });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      void shutdown("requested");
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
