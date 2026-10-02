import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./migrations/0020-provider-model-selection.js";
import { DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL } from "./migrations/0023-dwf-actor-model-provenance.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./migrations/0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./migrations/0022-backfilled-session-reasoning.js";
import type { SqliteMigration } from "./migrations/definition.js";
import { SESSION_BASE_MIGRATIONS } from "./migrations/session-base.js";
import { WORKFLOW_SCRIPT_MIGRATIONS } from "./migrations/workflow-script.js";
import { USAGE_ACCOUNTING_MIGRATIONS } from "./migrations/usage-accounting.js";
import { MESSAGE_ORDER_INPUT_MIGRATIONS } from "./migrations/message-order-input.js";
import { DWF_JOURNAL_MIGRATIONS } from "./migrations/dwf-journal.js";

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  ...SESSION_BASE_MIGRATIONS,
  ...WORKFLOW_SCRIPT_MIGRATIONS,
  ...USAGE_ACCOUNTING_MIGRATIONS,
  ...MESSAGE_ORDER_INPUT_MIGRATIONS,
  ...DWF_JOURNAL_MIGRATIONS,
  {
    appVersion: "0.16.5",
    id: "0020_provider_model_selection",
    sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL,
  },
  {
    appVersion: "0.16.5",
    id: "0021_official_glm_selection",
    sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL,
  },
  {
    appVersion: "0.16.5",
    id: "0022_backfilled_session_reasoning",
    sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL,
  },
  {
    appVersion: "0.16.9",
    id: "0023_dwf_actor_model_provenance",
    sql: DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL,
  },
];
