import type { LCodeSessionFile, LCodeTaskMeta } from "@lcode/shared";
import { lcodeSessionFileSchema, lcodeTaskMetaSchema, lcodeTaskModeSchema } from "@lcode/shared";

export type LegacyTaskSessionFile = Omit<LCodeSessionFile, "meta"> & {
  meta: Omit<LCodeTaskMeta, "mode"> & { mode?: LCodeTaskMeta["mode"] };
};

const legacyTaskSessionFileSchema = lcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: lcodeTaskMetaSchema.extend({
    mode: lcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
