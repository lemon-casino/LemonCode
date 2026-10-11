/** 只投影已知 API 请求及其关联轮次/工具，OAuth 和未知历史身份不能归为 API。 */
export const API_USAGE_SCOPE = `with model_usage as (
  select * from main.model_usage
  where nullif(trim(provider_id), '') is not null
    and provider_id not like 'oauth:%' and provider_id not like 'account:%'
    and provider_id not in ('builtin:zai-start-plan', 'builtin:bigmodel-start-plan',
      'builtin:zai-coding-plan', 'builtin:bigmodel-coding-plan')
    and auth_channel_id is null and account_connection_id is null
), turn_usage as (
  select t.* from main.turn_usage t
  where exists(select 1 from model_usage m where m.session_id = t.session_id and m.turn_id = t.turn_id)
), tool_usage as (
  select t.* from main.tool_usage t
  where exists(select 1 from model_usage m where m.session_id = t.session_id and m.turn_id = t.turn_id)
) `;
