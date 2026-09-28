// 0020 可能以不带档位的 assistant 回填会话选择；只能给迁移后未动过的会话补同模型 user 档位。
// 本表冻结 0020/0021 的身份规则，不引用实时目录，也不改旧 migration 的内容或 checksum。
const officialProviders = [
  "account:zai-start-plan",
  "account:bigmodel-start-plan",
  "account:zai-individual-coding-plan",
  "account:bigmodel-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:bigmodel-team-coding-plan",
];
const officialModels = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5V-Turbo",
  "GLM-5.2",
  "GLM-5.1",
  "GLM-5.1-Highspeed",
  "GLM-5",
  "GLM-5-Turbo",
  "GLM-4.7",
  "GLM-4.7-FlashX",
  "GLM-4.7-Flash",
  "GLM-4.6",
  "GLM-4.5-Air",
  "GLM-4.5",
  "GLM-4.6V",
  "GLM-4.6V-Flash",
  "GLM-4.6V-FlashX",
  "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash",
  "GLM-4-FlashX-250414",
  "GLM-4-Flash-250414",
  "GLM-4V-Flash",
];

export const BACKFILLED_SESSION_REASONING_MIGRATION_SQL = `
WITH last_user AS (
  SELECT session_id, data, row_number() OVER (
    PARTITION BY session_id ORDER BY sequence DESC, time_created DESC, rowid DESC
  ) AS rank
  FROM message
  WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.role') = 'user' ELSE 0 END
), normalized_user AS (
  SELECT session_id,
    CASE trim(json_extract(data, '$.modelSelection.providerId'))
      WHEN 'builtin:bigmodel' THEN 'bigmodel-api'
      WHEN 'builtin:zai' THEN 'zai-api'
      WHEN 'builtin:bigmodel-start-plan' THEN 'account:bigmodel-start-plan'
      WHEN 'builtin:zai-start-plan' THEN 'account:zai-start-plan'
      WHEN 'builtin:bigmodel-coding-plan' THEN 'account:bigmodel-individual-coding-plan'
      WHEN 'builtin:zai-coding-plan' THEN 'account:zai-individual-coding-plan'
      ELSE CASE WHEN substr(trim(json_extract(data, '$.modelSelection.providerId')), 1, 8) = 'builtin:'
        THEN NULL ELSE trim(json_extract(data, '$.modelSelection.providerId')) END
    END AS provider_id,
    trim(json_extract(data, '$.modelSelection.modelId')) AS model_id,
    json_extract(data, '$.modelSelection.options.reasoningLevel') AS level
  FROM last_user
  WHERE rank = 1
    AND json_type(data, '$.modelSelection.providerId') = 'text'
    AND json_type(data, '$.modelSelection.modelId') = 'text'
    AND json_type(data, '$.modelSelection.options.reasoningLevel') = 'text'
    AND length(trim(json_extract(data, '$.modelSelection.options.reasoningLevel'))) > 0
), canonical_user AS (
  SELECT session_id, provider_id, level,
    CASE WHEN provider_id IN (${officialProviders.map((id) => `'${id}'`).join(", ")})
      THEN CASE lower(model_id)
        ${officialModels.map((id) => `WHEN '${id.toLowerCase()}' THEN '${id}'`).join("\n        ")}
        ELSE model_id END
      ELSE model_id END AS model_id
  FROM normalized_user
), untouched_entries AS (
  SELECT e.id, CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END AS data, e.session_id
  FROM session_entry e
  JOIN session s ON s.id = e.session_id
  JOIN schema_migration m ON m.id = '0020_provider_model_selection'
  WHERE e.type = 'runtime/model_selection'
    AND e.id = e.session_id || ':runtime-model-selection'
    AND e.time_updated <= m.time_applied AND s.time_updated <= m.time_applied
), repairs AS (
  SELECT e.id, u.level
  FROM untouched_entries e JOIN canonical_user u ON u.session_id = e.session_id
  WHERE json_type(e.data, '$.providerId') IS NULL
    AND json_type(e.data, '$.modelId') IS NULL
    AND json_type(e.data, '$.thoughtLevel') IS NULL
    AND json_type(e.data, '$.modelSelection.options') IS NULL
    AND json_type(e.data, '$.modelSelection.providerId') = 'text'
    AND json_type(e.data, '$.modelSelection.modelId') = 'text'
    AND length(u.provider_id) > 0 AND length(u.model_id) > 0
    AND json_extract(e.data, '$.modelSelection.providerId') = u.provider_id
    AND json_extract(e.data, '$.modelSelection.modelId') = u.model_id
)
UPDATE session_entry AS e
SET data = json_set(data, '$.modelSelection.options.reasoningLevel',
  (SELECT level FROM repairs WHERE repairs.id = e.id))
WHERE id IN (SELECT id FROM repairs);
`;
