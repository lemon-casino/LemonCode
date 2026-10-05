/**
 * runtime-environment 模块清单：工作树/候选的托管运行环境。
 * 依赖声明与 architecture-policy.yaml 保持一致；对外只暴露 contract.ts 与 node.ts。
 */
export const runtimeEnvironmentModule = {
  id: "runtime-environment",
  requires: ["shared", "services"],
  provides: ["runtime-environment-service"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
