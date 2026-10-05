import type {
  FrozenManifest,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";

/**
 * 落盘记录形状说明（spec §8.2/§8.3）：
 * 唯一事实源在 @lcode/shared 的 runtimeEnvironmentRecordSchema /
 * runtimePreparationOperationSchema / frozenManifestSchema（strict + schemaVersion）。
 * store 直接使用这些 schema 校验读写；本文件只做类型再导出，避免第二份校验定义。
 */
export type EnvironmentRecordFile = RuntimeEnvironmentRecord;
export type OperationRecordFile = RuntimePreparationOperation;
export type ManifestRecordFile = FrozenManifest;
