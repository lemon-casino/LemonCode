import { z } from "zod";
import { modelConfigDataSchema } from "@lcode/shared/model-config";
import { accountModelCatalogSchema } from "@lcode/shared/model-catalog";
import {
  oauthAccountAccessDataSchema,
  providerApiTypeDataSchema,
  providerConfigDataSchema,
  zhipuAccountAccessDataSchema,
} from "./provider-data-schema.js";
import { ModelConfig, ModelConfigRules } from "./model-config.js";
import {
  ApiKeyAccessConfig,
  OAuthAccountAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplate,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
} from "./provider-config.js";
import {
  builtinModelConfigRulesSchema,
  personalModelConfigRulesSchema,
  builtinProviderConfigRulesSchema,
  personalProviderConfigRulesSchema,
  providerConfigRuleSchema,
  providerTemplateConfigRuleSchema,
  builtinProviderConfigRuleSchema,
  providerModelConfigRuleSchema,
  type ProviderConfigRuleData,
  type ProviderTemplateConfigRuleData,
} from "./rule-data-schema.js";

const accountProviderConfigSchema = providerConfigDataSchema
  .pick({ builtinModelIds: true })
  .extend({
    access: zhipuAccountAccessDataSchema.pick({ type: true, entitled: true }).nullable().optional(),
  });
// OAuth 是独立账号来源；旧 schema 只认识智谱权益，导致整个账号池在正式发送前被拒绝。
const oauthProviderConfigSchema = providerConfigDataSchema.pick({ builtinModelIds: true }).extend({
  group: z.literal("standard-personal"),
  access: oauthAccountAccessDataSchema,
  api: z
    .object({ type: providerApiTypeDataSchema, baseUrl: z.literal("https://oauth.invalid/v1") })
    .strict(),
});

export function parseProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(providerConfigRuleSchema).parse(input));
}

export function parseLCodeBuiltinProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(z.array(builtinProviderConfigRuleSchema).parse(input));
}

export function parseProviderTemplateMap(input: unknown): ProviderTemplateMap {
  return createTemplateRules(z.array(providerTemplateConfigRuleSchema).parse(input));
}

export function parseLCodeBuiltinProviderConfigRules(input: unknown): {
  providers: ProviderConfigMap;
  providerTemplates: ProviderTemplateMap;
} {
  const parsed = builtinProviderConfigRulesSchema.parse(input);
  return {
    providers: createProviderRules(parsed.providerRules),
    providerTemplates: createTemplateRules(parsed.templateRules),
  };
}

export function parsePersonalProviderConfigMap(input: unknown): ProviderConfigMap {
  return createProviderRules(personalProviderConfigRulesSchema.parse(input).providerRules);
}

/** Account 只传旧智谱权益或 OAuth 安全目录，不接受凭据和个人编辑规则。 */
export function parseAccountProviderConfigMap(input: unknown): ProviderConfigMap {
  const parsed = z
    .record(z.string().min(1), z.union([accountProviderConfigSchema, oauthProviderConfigSchema]))
    .parse(input);
  for (const [providerId, config] of Object.entries(parsed)) {
    if (
      config.access?.type === "oauth-account" &&
      providerId !== `oauth:${config.access.channelId}`
    )
      throw new Error("OAuth Provider 身份与渠道不一致");
  }
  return new ProviderConfigMap(
    Object.entries(parsed).map(([providerId, config]) => [
      providerId,
      createProviderConfig(config),
    ]),
  );
}

/** 精确目录规则随同一账号快照交付，不能覆盖其他来源或供应商。 */
export function parseAccountModelConfigRules(
  input: unknown,
  providers: ProviderConfigMap,
): ModelConfigRules {
  const rules = z.array(providerModelConfigRuleSchema).parse(input);
  for (const rule of rules) {
    const provider = providers.get(rule.providerId);
    if (
      provider?.access?.type !== "oauth-account" ||
      !provider.builtinModelIds?.includes(rule.modelId)
    )
      throw new Error("Account Model 规则不属于当前 OAuth 目录");
  }
  return new ModelConfigRules(
    rules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  );
}

/** 目录展示元数据只属于当前账号供应商与已授予模型，不能覆盖其他供应商。 */
export function parseAccountModelCatalog(input: unknown, providers: ProviderConfigMap) {
  const catalog = accountModelCatalogSchema.parse(input);
  for (const [providerId, models] of Object.entries(catalog)) {
    const provider = providers.get(providerId);
    if (
      provider?.access?.type !== "oauth-account" ||
      Object.keys(models).some((id) => !provider.builtinModelIds?.includes(id))
    )
      throw new Error("Account catalog metadata is outside its OAuth model scope");
  }
  return catalog;
}

export function parseProviderConfig(input: unknown): ProviderConfig {
  return createProviderConfig(providerConfigDataSchema.parse(input));
}

export function parseModelConfig(input: unknown): ModelConfig {
  return createModelConfig(modelConfigDataSchema.parse(input));
}

export function parseLCodeBuiltinModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = builtinModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.modelRules.map((rule) => ({
      ...rule,
      type: "model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.modelApiRules.map((rule) => ({
      ...rule,
      type: "model-api" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.providerSiteRules.map((rule) => ({
      ...rule,
      type: "provider-site" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.templateModelRules.map((rule) => ({
      ...rule,
      type: "template-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.builtinProviderModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

export function parsePersonalModelConfigRules(input: unknown): ModelConfigRules {
  const parsed = personalModelConfigRulesSchema.parse(input);
  return new ModelConfigRules([
    ...parsed.providerModelRules.map((rule) => ({
      ...rule,
      type: "provider-model" as const,
      config: createModelConfig(rule.config),
    })),
    ...parsed.manualProviderModelRules.map((rule) => ({
      ...rule,
      type: "manual-provider-model" as const,
      config: createModelConfig(rule.config),
    })),
  ]);
}

function createProviderRules(rules: readonly ProviderConfigRuleData[]): ProviderConfigMap {
  return new ProviderConfigMap(
    rules.map(({ config, ...rule }) => ({
      ...rule,
      config: createProviderConfig(config),
    })),
  );
}

function createTemplateRules(
  rules: readonly ProviderTemplateConfigRuleData[],
): ProviderTemplateMap {
  return new ProviderTemplateMap(
    rules.map((rule) => [
      rule.templateId,
      new ProviderTemplate({ ...rule, config: createProviderConfig(rule.config) }),
    ]),
  );
}

function createProviderConfig(config: z.infer<typeof providerConfigDataSchema>): ProviderConfig {
  return new ProviderConfig({
    ...config,
    access:
      config.access == null
        ? config.access
        : config.access.type === "oauth-account"
          ? new OAuthAccountAccessConfig(config.access)
          : config.access.type !== "zhipu-account"
            ? new ApiKeyAccessConfig(config.access)
            : new ZhipuAccountAccessConfig(config.access),
    api: config.api == null ? config.api : new ProviderApiConfig(config.api),
  });
}

function createModelConfig(config: z.infer<typeof modelConfigDataSchema>): ModelConfig {
  return ModelConfig.fromData(config);
}
