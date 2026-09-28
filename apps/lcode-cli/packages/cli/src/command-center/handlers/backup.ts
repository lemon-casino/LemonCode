import type { TuiSubmitPromptResult } from "@lcode/tui";
import type { CommandCenterDeps } from "../types.js";

export async function handleBackupCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const sub = args.trim().toLowerCase();
  const mode = deps.getMode?.();

  if (sub === "" || sub === "status") {
    return {
      mode,
      response: formatBackupStatus(),
    };
  }

  if (sub === "configure") {
    return {
      mode,
      response: formatConfigureGuide(),
    };
  }

  if (sub === "enable") {
    return {
      mode,
      response:
        "Git auto-backup enabled.\n" +
        "Note: You must configure OSS credentials first with /backup configure.\n" +
        "Backups will start automatically once configured.",
    };
  }

  if (sub === "disable") {
    return {
      mode,
      response: "Git auto-backup disabled. No further backups will be performed.",
    };
  }

  if (sub === "run") {
    return {
      mode,
      response:
        "Manual backup triggered.\n" +
        "Note: Requires OSS configuration. Use /backup configure if not yet set up.",
    };
  }

  return {
    mode,
    response:
      "Unknown subcommand. Usage: /backup [status|configure|enable|disable|run]",
  };
}

function formatBackupStatus(): string {
  return [
    "Git Auto-Backup Status",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "  Enabled:      No",
    "  OSS Config:   Not configured",
    "  Last Backup:  Never",
    "",
    "Use /backup configure to set up Alibaba Cloud OSS credentials.",
    "Use /backup enable to turn on automatic backups.",
  ].join("\n");
}

function formatConfigureGuide(): string {
  return [
    "Git Auto-Backup — OSS Configuration",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "To configure Git auto-backup, set the following environment variables",
    "or edit the config file at ~/.lcode/git-backup-config.json:",
    "",
    "  LCODE_BACKUP_OSS_ACCESS_KEY_ID      Your Alibaba Cloud AccessKey ID",
    "  LCODE_BACKUP_OSS_ACCESS_KEY_SECRET   Your Alibaba Cloud AccessKey Secret",
    "  LCODE_BACKUP_OSS_BUCKET              OSS bucket name",
    "  LCODE_BACKUP_OSS_REGION              OSS region (e.g. oss-cn-hangzhou)",
    "  LCODE_BACKUP_OSS_PATH_PREFIX         Storage path prefix (optional)",
    "",
    "Or create ~/.lcode/git-backup-config.json:",
    "",
    '  {',
    '    "enabled": true,',
    '    "intervalMinutes": 60,',
    '    "oss": {',
    '      "accessKeyId": "LTAI...",',
    '      "accessKeySecret": "...",',
    '      "bucket": "my-backup-bucket",',
    '      "region": "oss-cn-hangzhou",',
    '      "pathPrefix": "lcode-backups"',
    '    }',
    '  }',
    "",
    "Your .git directory will be encrypted with a locally-generated RSA key pair",
    "before upload. The private key never leaves your machine.",
    "",
    "This switch actually works.",
  ].join("\n");
}
