import { z } from "zod";

/**
 * LCode agent 提供方的单一真源。
 *
 * 类型 LCodeProvider、运行时 schema lcodeProviderSchema 都从这里派生,
 * 避免各处内联 z.enum([...]) 副本随新增/删除 provider 漂移。
 * 本模块只依赖 zod(叶子),可被 validation / lcode-protocol 等无环引用。
 */
const LCODE_PROVIDERS = ["glm"] as const;

export const lcodeProviderSchema = z.enum(LCODE_PROVIDERS);

export type LCodeProvider = (typeof LCODE_PROVIDERS)[number];
