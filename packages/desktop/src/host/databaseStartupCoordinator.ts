import { randomUUID } from "node:crypto";
import {
  classifyDatabaseStartupError,
  canRetryDatabaseStartup,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
  type DatabaseStartupState,
  type DatabaseMigrationFacts,
  type StartupDiskSummary,
} from "@lcode/shared";

type Report = (
  phase: DatabaseStartupState["phase"],
  databasePhase?: DatabaseStartupState["databasePhase"],
  details?: { databaseId: string; migration?: DatabaseMigrationFacts; finalDatabase?: boolean },
) => void;

/** 每窗口一个启动所有者。失败只由显式 retry 推进，刷新和重复请求不重新执行 SQL。 */
export class DatabaseStartupCoordinator {
  private readonly baselines = new Map<string, string | null | undefined>();
  private readonly migrations = new Map<string, DatabaseMigrationFacts>();
  private running = false;
  private started = false;
  private state: DatabaseStartupState;
  constructor(
    private readonly options: {
      startupId?: string;
      prepare: (report: Report) => Promise<void>;
      publish: (state: DatabaseStartupState) => void;
    },
  ) {
    const now = Date.now();
    this.state = {
      schemaVersion: 1,
      startupId: options.startupId ?? randomUUID(),
      attemptId: randomUUID(),
      sequence: 0,
      startedAt: now,
      updatedAt: now,
      phase: "starting",
      disk: [],
    };
  }
  get snapshot(): DatabaseStartupState {
    return structuredClone(this.state);
  }
  publish(): void {
    try {
      this.options.publish(this.snapshot);
    } catch {
      /* 通知故障不能改变数据库执行结果。 */
    }
  }
  updateDisk(disk: StartupDiskSummary[]): void {
    this.state = { ...this.state, disk, sequence: this.state.sequence + 1, updatedAt: Date.now() };
    this.publish();
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.run();
  }
  async retry(attemptId: string): Promise<void> {
    if (this.running || !canRetryDatabaseStartup(this.state) || attemptId !== this.state.attemptId)
      return;
    this.migrations.clear();
    this.baselines.clear();
    this.state = {
      ...this.state,
      migration: undefined,
      currentMigration: undefined,
      migrationBaselines: undefined,
      finalDatabase: undefined,
      attemptId: randomUUID(),
      startedAt: Date.now(),
      phase: "starting",
      errorCode: undefined,
      sqliteCode: undefined,
      systemCode: undefined,
      migrationId: undefined,
      failedPhase: undefined,
      databasePhase: undefined,
      disk: [],
    };
    await this.run();
  }
  private async run(): Promise<void> {
    this.running = true;
    const report: Report = (phase, databasePhase, details) => {
      if (details) {
        // 仅首次可信锁内值可替换 unknown；后续无事实通知不能抹掉起点。
        if (
          !this.baselines.has(details.databaseId) ||
          this.baselines.get(details.databaseId) === undefined
        )
          this.baselines.set(details.databaseId, details.migration?.lastAppliedMigrationId);
      }
      if (details?.migration) {
        const previous = this.migrations.get(details.databaseId);
        const next = details.migration;
        // 预检可能发现待迁移、拿锁后却由别的执行者完成；需求不丢，执行/提交不虚增。
        const kind =
          previous?.kind === "upgrade" || next.kind === "upgrade"
            ? "upgrade"
            : previous?.kind === "initialize" || next.kind === "initialize"
              ? "initialize"
              : "none";
        this.migrations.set(details.databaseId, { ...next, kind });
      }
      const migration = this.migrations.size
        ? [...this.migrations.values()].reduce<DatabaseMigrationFacts>(
            (sum, facts) => ({
              kind:
                sum.kind === "upgrade" || facts.kind === "upgrade"
                  ? "upgrade"
                  : sum.kind === "initialize" || facts.kind === "initialize"
                    ? "initialize"
                    : "none",
              executedCount: sum.executedCount + facts.executedCount,
              committedCount: sum.committedCount + facts.committedCount,
            }),
            { kind: "none", executedCount: 0, committedCount: 0 },
          )
        : undefined;
      this.state = {
        ...this.state,
        phase,
        databasePhase,
        migration,
        // tasks-index 是固定内部 ID，会话库 ID 由 CLI 对真实路径哈希生成。
        migrationBaselines: [...this.baselines].map(([databaseId, lastAppliedMigrationId]) => ({
          databaseId,
          databaseKind: databaseId === "tasks-index" ? "tasks-index" : "session",
          lastAppliedMigrationId,
        })),
        currentMigration: details?.migration,
        finalDatabase: details?.finalDatabase,
        sequence: this.state.sequence + 1,
        updatedAt: Date.now(),
      };
      this.publish();
    };
    report("starting");
    try {
      await this.options.prepare(report);
      report("ready");
    } catch (error) {
      this.state = {
        ...this.state,
        failedPhase: this.state.phase,
        errorCode: classifyDatabaseStartupError(error),
        ...databaseStartupErrorDetails(error),
      };
      const update = (
        error as { migrationUpdate?: { databaseId?: unknown; migration?: unknown } } | null
      )?.migrationUpdate;
      const facts = databaseMigrationFactsSchema.safeParse(update?.migration);
      report(
        "failed",
        undefined,
        facts.success && typeof update?.databaseId === "string"
          ? { databaseId: update.databaseId, migration: facts.data }
          : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
