/**
 * `resolved_model` 与来源共同组成 actor 模型绑定。旧行保留 NULL，由 bootstrap 按仍可证明的
 * 显式配置重建；没有证据时解释为 sessionInherited，迁移本身不猜来源。
 */
export const DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL = `
ALTER TABLE dwf_actor ADD COLUMN model_provenance text
  CHECK (
    model_provenance IS NULL OR (
      resolved_model IS NOT NULL AND model_provenance IN (
        'approvedActorOverride',
        'scriptActorModel',
        'runModel',
        'resumePin',
        'sessionInherited'
      )
    )
  );
`;
