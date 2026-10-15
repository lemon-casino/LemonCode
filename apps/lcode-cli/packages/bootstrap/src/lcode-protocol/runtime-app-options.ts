import type { ModelSelection } from "@lcode/contracts";
import type { PresentationSurface } from "@lcode/core";
import type { LCodeAppOptions } from "../app/types.js";

export function applyProtocolPresentationSurface(
  options: Omit<LCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<LCodeAppOptions, "providerRegistry"> {
  return { ...options, runtimeConfig: { ...options.runtimeConfig, presentationSurface } };
}

/** 进程 Registry 是当前 Environment 的唯一模型配置源。 */
export function applyProtocolProviderRegistry(
  options: Omit<LCodeAppOptions, "providerRegistry">,
  providerRegistry: LCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): LCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}
