export const GOAL_ACCEPTANCE_MIGRATION_SQL = `
alter table session_target add column acceptance_json text;
alter table session_target add column state_revision integer not null default 0;
`;
