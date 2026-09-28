// 冻结的数据迁移只生成 SQL，checksum 覆盖最终 SQL；不调用可变账号/Registry。
// 旧对象不删除、不覆盖，历史消息来源只换结构，当前 Session 选择才使用既有身份映射。
const value = (path: string) => `json_extract(data, '$.${path}')`;
const text = (expression: string) =>
  `(typeof(${expression}) = 'text' and length(trim(${expression})) > 0)`;

function selection(provider: string, model: string, level: string, label = "NULL"): string {
  return `case when ${text(provider)} and ${text(model)} then
    json_patch(
      json_patch(json_object('providerId', ${provider}, 'modelId', ${model}),
        case when ${text(level)} then json_object('options', json_object('reasoningLevel', ${level})) else '{}' end),
      case when typeof(${label}) = 'text' then json_object('label', ${label}) else '{}' end)
    else NULL end`;
}

function migratedProvider(input: string): string {
  const provider = `trim(${input})`;
  // 与已裁决的 migrateLegacyModelProviderId 对照测试；不可按当前连接改写。
  return `case ${provider}
    when 'builtin:bigmodel' then 'bigmodel-api'
    when 'builtin:zai' then 'zai-api'
    when 'builtin:bigmodel-start-plan' then 'account:bigmodel-start-plan'
    when 'builtin:zai-start-plan' then 'account:zai-start-plan'
    when 'builtin:bigmodel-coding-plan' then 'account:bigmodel-individual-coding-plan'
    when 'builtin:zai-coding-plan' then 'account:zai-individual-coding-plan'
    else case when substr(${provider}, 1, 8) = 'builtin:' then NULL else ${provider} end end`;
}

const legacyUserSelection = selection(
  value("model.providerID"),
  value("model.modelID"),
  value("model.variant"),
);
const legacyAssistantSelection = selection(value("providerID"), value("modelID"), value("variant"));
const entrySelection = selection(
  migratedProvider(value("providerId")),
  `trim(${value("modelId")})`,
  `trim(${value("thoughtLevel")})`,
);
const messageCandidate = `case
  when ${value("role")} = 'user' then
    case when json_type(data, '$.modelSelection') is not null
      then case when substr(${value("modelSelection.providerId")}, 1, 8) = 'builtin:'
        then ${selection(value("modelSelection.providerId"), value("modelSelection.modelId"), value("modelSelection.options.reasoningLevel"))}
        else NULL end
      else ${legacyUserSelection} end
  else case when json_type(data, '$.providerId') is not null or json_type(data, '$.modelId') is not null or json_type(data, '$.reasoningLevel') is not null
    then case when substr(${value("providerId")}, 1, 8) = 'builtin:'
      then ${selection(value("providerId"), value("modelId"), value("reasoningLevel"))} else NULL end
    else ${legacyAssistantSelection} end end`;

function migratePartMember(source: string, target: string): string {
  const converted = selection(
    value(`${source}.providerID`),
    value(`${source}.modelID`),
    value(`${source}.variant`),
    value(`${source}.label`),
  );
  return `update part set data = json_set(data, '$.${target}', json(${converted}))
    where json_valid(data) and json_type(data) = 'object'
      and ((${value("type")} = 'timeline' and ${value("timelineType")} = 'model_change' and '${source}' in ('fromModel','toModel'))
        or (${value("type")} = 'subtask' and '${source}' = 'model'))
      and json_type(data, '$.${source}') = 'object'
      and (json_type(data, '$.${source}.providerID') is not null or json_type(data, '$.${source}.modelID') is not null);`;
}

export const PROVIDER_MODEL_SELECTION_MIGRATION_SQL = `
  -- 无 entry 时沿用既有最后一个明确消息来源规则；不能越过损坏/明确空选择找更早的值。
  with ranked as (
    select message.*, row_number() over (
      partition by session_id order by sequence desc, time_created desc, rowid desc
    ) as rank
    from message
    where json_valid(data) and json_type(data) = 'object'
      and ((${value("role")} = 'user' and (json_type(data, '$.model') is not null or json_type(data, '$.modelSelection') is not null))
        or (${value("role")} = 'assistant' and (json_type(data, '$.providerID') is not null or json_type(data, '$.modelID') is not null
          or json_type(data, '$.providerId') is not null or json_type(data, '$.modelId') is not null or json_type(data, '$.reasoningLevel') is not null)))
      and not exists (select 1 from session_entry e where e.session_id = message.session_id and e.type = 'runtime/model_selection')
  ), candidates as (
    select *, ${messageCandidate} as candidate from ranked where rank = 1
  ), migrated as (
    select *, ${selection(
      migratedProvider("json_extract(candidate, '$.providerId')"),
      "trim(json_extract(candidate, '$.modelId'))",
      "trim(json_extract(candidate, '$.options.reasoningLevel'))",
    )} as normalized from candidates
  )
  insert into session_entry(id, session_id, type, time_created, time_updated, data)
    select session_id || ':runtime-model-selection', session_id, 'runtime/model_selection', time_created, time_updated,
      json_object('modelSelection', json(normalized))
    from migrated where normalized is not null
    on conflict(id) do nothing;

  update session_entry set data = json_set(data, '$.modelSelection', json(${entrySelection}))
    where type = 'runtime/model_selection' and json_valid(data) and json_type(data) = 'object'
      and ${text(value("providerId"))} and ${text(value("modelId"))} and ${entrySelection} is not null;

  -- 已发布 User 消息也可能含 modelSelection；它本身不是可覆盖的未发布新目标字段。
  update message set data = json_set(data, '$.modelSelection', json(${legacyUserSelection}))
    where json_valid(data) and json_type(data) = 'object' and ${value("role")} = 'user'
      and json_type(data, '$.modelSelection') is null and json_type(data, '$.model') = 'object';

  update message set data = json_patch(data, json_patch(
      json_object('providerId', ${value("providerID")}, 'modelId', ${value("modelID")}),
      case when ${text(value("variant"))} then json_object('reasoningLevel', ${value("variant")}) else '{}' end))
    where json_valid(data) and json_type(data) = 'object' and ${value("role")} = 'assistant'
      and ${text(value("providerID"))} and ${text(value("modelID"))};

  ${migratePartMember("fromModel", "fromModelSelection")}
  ${migratePartMember("toModel", "toModelSelection")}
  ${migratePartMember("model", "modelSelection")}
`;
