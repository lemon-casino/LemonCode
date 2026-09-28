import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE } from "./bash-readonly-policy-git-subcommands-core.js";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY } from "./bash-readonly-policy-git-subcommands-history.js";
import { READONLY_MULTIWORD_POLICY_ENTRIES_CORE } from "./bash-readonly-policy-multiword-core.js";
import { READONLY_MULTIWORD_POLICY_ENTRIES_GH } from "./bash-readonly-policy-multiword-gh.js";

export {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES,
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
} from "./bash-readonly-policy-simple-commands.js";

export const GIT_READONLY_SUBCOMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE,
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY,
]);

export const READONLY_MULTIWORD_COMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...READONLY_MULTIWORD_POLICY_ENTRIES_CORE,
  ...READONLY_MULTIWORD_POLICY_ENTRIES_GH,
]);
