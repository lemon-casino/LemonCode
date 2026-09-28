import type { DatabaseStartupErrorCode } from "@lcode/shared";
export type SqliteSessionMigrationErrorKind = DatabaseStartupErrorCode;

export interface SqliteSessionMigrationErrorOptions {
  cause?: unknown;
  dbPath: string;
  kind: SqliteSessionMigrationErrorKind;
  migrationId?: string;
}

export class SqliteSessionMigrationError extends Error {
  readonly dbPath: string;
  readonly kind: SqliteSessionMigrationErrorKind;
  readonly migrationId?: string;

  constructor(message: string, options: SqliteSessionMigrationErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SqliteSessionMigrationError";
    this.dbPath = options.dbPath;
    this.kind = options.kind;
    this.migrationId = options.migrationId;
  }
}
