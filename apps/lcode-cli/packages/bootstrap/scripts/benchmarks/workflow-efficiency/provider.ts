import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { AiSdkModelAdapter, resolveAiSdkModelRetryOptions } from "@lcode/adapters/model";
import { ProviderConfigMap, ProviderConfigResolver, ProviderRegistry } from "@lcode/provider";
import {
  decodeLCodeBuiltinRelease,
  decodeProviderConfigFile,
  resolveNodeProviderRuntimePaths,
} from "@lcode/provider-node";
import { OUTPUT_CAP, SELECTION } from "./fixtures.js";

export async function prepareProvider() {
  const paths = resolveNodeProviderRuntimePaths(process.env);
  if (!paths) throw new Error("provider_paths_missing");
  const [builtinText, personalText] = await Promise.all([
    readFile(paths.lcodeBuiltinFilePath, "utf8"),
    readFile(paths.personalFilePath, "utf8"),
  ]);
  const builtin = decodeLCodeBuiltinRelease(JSON.parse(builtinText)).config;
  const personal = decodeProviderConfigFile(JSON.parse(personalText));
  const resolution = new ProviderConfigResolver().resolve({
    lcodeBuiltinProviders: builtin.providers,
    lcodeBuiltinProviderTemplates: builtin.providerTemplates,
    lcodeBuiltinModelRules: builtin.modelConfigRules,
    personalProviders: personal.providers,
    personalModels: personal.models,
    personalProviderOrder: personal.providerOrder,
    accountProviders: ProviderConfigMap.empty(),
  });
  const registry = new ProviderRegistry(resolution.registryProviders);
  if (!registry.validateSelection(SELECTION).ok) throw new Error("selection_invalid");
  const provider = registry.getProvider(SELECTION.providerId)!;
  const entry = registry.getModel(SELECTION.providerId, SELECTION.modelId)!;
  if (provider.config.access.type !== "api-key") throw new Error("api_key_provider_required");
  if (entry.config.optionSpecs.maxOutputTokens.max < OUTPUT_CAP)
    throw new Error("output_cap_unsupported");

  // bootstrap 不直接依赖 option-map；从其既有 provider 依赖解析公开入口，不改 package.json。
  const providerRequire = createRequire(import.meta.resolve("@lcode/provider"));
  const { compileModelOptionMaps } = await import(
    pathToFileURL(providerRequire.resolve("@lcode/model-option-map")).href
  );
  const patch = compileModelOptionMaps(entry.config.optionSpecs).apply(
    {},
    {
      ...SELECTION.options,
      maxOutputTokens: OUTPUT_CAP,
    },
  );
  const reasoning = patch.reasoning;
  const nestedEffort =
    reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
      ? reasoning.effort
      : undefined;
  if (nestedEffort !== "max" && patch.reasoning_effort !== "max")
    throw new Error("reasoning_map_changed");
  if (patch.service_tier !== "priority") throw new Error("speed_map_changed");

  // 修复依据：false 只关闭全量保留，adapter 默认仍写 rollout；测试态才关闭全部 model-I/O 落盘。
  // 只改此 adapter 的 env 副本，不改进程环境、个人设置、凭据或生产重试策略。
  const env = { ...process.env, LCODE_RUNTIME_ENV: "test" };
  const adapter = new AiSdkModelAdapter({ env, modelIoFullRetentionEnabled: false });
  const model = adapter.createModel({
    ...SELECTION,
    providerConfig: provider.config,
    modelConfig: entry.config,
  });
  if (model.options.reasoningLevel !== "max" || model.options.speed !== "fast")
    throw new Error("effective_selection_changed");
  return {
    model,
    publicSettings: {
      selection: SELECTION,
      maxOutputTokens: OUTPUT_CAP,
      wireReasoningEffort: "max",
      wireServiceTier: "priority",
      credentials: "existing_adapter_in_memory_only",
      modelIoRecording: false,
      adapterRetrySettings: resolveAiSdkModelRetryOptions(undefined, env),
    },
  };
}
