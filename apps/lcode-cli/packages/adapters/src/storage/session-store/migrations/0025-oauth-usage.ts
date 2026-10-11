export const OAUTH_USAGE_MIGRATION_SQL = `
  alter table model_usage add column auth_channel_id text;
  alter table model_usage add column account_connection_id text;
  alter table model_usage add column usage_known integer check(usage_known in (0, 1));
  alter table model_usage add column context_window_tokens integer;
  alter table model_usage add column context_used_tokens integer;
  update model_usage set usage_known = 1 where input_tokens > 0 or output_tokens > 0
    or cache_read_input_tokens > 0 or cache_creation_input_tokens > 0;
  create index model_usage_account_time_idx on model_usage(provider_id, account_connection_id, started_at);
`;
