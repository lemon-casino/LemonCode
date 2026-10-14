import type { AgentRuntime } from "@lcode/core";
import type { ActorRuntimeFactory } from "./workflow-driver-types.js";

/** 测试桩也遵循 construct/initialize 分离，不能保留生产旧工厂路径。 */
export function readyActorRuntimeFactory(
  construct: (input: Parameters<ActorRuntimeFactory>[0]) => AgentRuntime,
): ActorRuntimeFactory {
  return (input) => ({ construct: () => construct(input), initialize: async () => {} });
}

export async function initializeActorFixture(
  factory: ActorRuntimeFactory,
  input: Parameters<ActorRuntimeFactory>[0],
): Promise<AgentRuntime> {
  const construction = factory(input);
  const runtime = construction.construct();
  await construction.initialize(runtime);
  return runtime;
}
