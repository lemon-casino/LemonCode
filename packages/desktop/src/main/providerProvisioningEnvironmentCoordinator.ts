import type { ProviderProvisioningTrigger } from "@lcode/shared";

type ExecuteSync = (trigger: ProviderProvisioningTrigger) => Promise<void>;

interface Registration {
  readonly id: string;
  readonly execute: ExecuteSync;
}

interface EnvironmentLane {
  readonly registrations: Map<string, Registration>;
  generation: number;
  completedGeneration: number;
  trigger: ProviderProvisioningTrigger;
  drain: Promise<void> | null;
}

/**
 * Main 进程只协调 Environment 身份和执行代际；配置与凭据始终由被选中的 Host 现读现传。
 */
export class ProviderProvisioningEnvironmentCoordinator {
  readonly #lanes = new Map<string, EnvironmentLane>();

  register(
    environmentKey: string,
    registrationId: string,
    execute: ExecuteSync,
  ): {
    initialSync: Promise<void>;
    dispose(): void;
  } {
    const lane = this.#lanes.get(environmentKey) ?? createLane();
    const wasOffline = lane.registrations.size === 0;
    lane.registrations.set(registrationId, { id: registrationId, execute });
    this.#lanes.set(environmentKey, lane);
    if (wasOffline) {
      lane.generation += 1;
      lane.trigger = "environment-online";
    }
    const initialSync = this.#startDrain(lane);
    return {
      initialSync,
      dispose: () => {
        lane.registrations.delete(registrationId);
      },
    };
  }

  requestAll(trigger: Exclude<ProviderProvisioningTrigger, "environment-online">): Promise<void> {
    const drains: Promise<void>[] = [];
    for (const lane of this.#lanes.values()) {
      lane.generation += 1;
      lane.trigger = trigger;
      if (lane.registrations.size > 0) drains.push(this.#startDrain(lane));
    }
    return Promise.all(drains).then(() => undefined);
  }

  #startDrain(lane: EnvironmentLane): Promise<void> {
    if (lane.drain) return lane.drain;
    const operation = this.#drain(lane).finally(() => {
      if (lane.drain === operation) lane.drain = null;
    });
    lane.drain = operation;
    return operation;
  }

  async #drain(lane: EnvironmentLane): Promise<void> {
    while (lane.completedGeneration < lane.generation && lane.registrations.size > 0) {
      const targetGeneration = lane.generation;
      const trigger = lane.trigger;
      const registration = lane.registrations.values().next().value as Registration | undefined;
      if (!registration) return;
      try {
        await registration.execute(trigger);
        lane.completedGeneration = targetGeneration;
      } catch (error) {
        // 执行 Host 退出时，其注册会先被移除；同一 Environment 仍有其它 Host
        // 就立即接管当前代际。普通远端失败不自动重试，等待下一次正式触发。
        if (!lane.registrations.has(registration.id) && lane.registrations.size > 0) continue;
        lane.completedGeneration = targetGeneration;
        // 首次同步是 Remote Workspace 发布屏障，不能把失败吞成已就绪；
        // 已连接后的同步由执行端降级为 warning，不会进入这里。
        if (trigger === "environment-online") throw error;
      }
    }
  }
}

function createLane(): EnvironmentLane {
  return {
    registrations: new Map(),
    generation: 0,
    completedGeneration: 0,
    trigger: "environment-online",
    drain: null,
  };
}
