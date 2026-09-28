import armsRum from "@arms/rum-electron";
import {
  LCODE_VERSION,
  type DatabaseStartupState,
  type ArmsCustomEventPayload,
} from "@lcode/shared";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import { buildFinalArmsCustomEventPayload } from "./desktopArmsCustomEvent.js";
import { logger } from "./logger.js";

const deviceMid = ensureDesktopDeviceMidSync();
type Attempt = { lastStage: string; stageAt: number; databaseFinished: boolean; terminal: boolean };
const attempts = new Map<string, Attempt>();

function send(
  state: DatabaseStartupState,
  name: string,
  value: number,
  properties: ArmsCustomEventPayload["properties"] = {},
) {
  const eventId = `${state.attemptId}:${name}:${properties?.scope_id ?? properties?.database_id ?? state.sequence}`;
  try {
    const payload = buildFinalArmsCustomEventPayload({
      payload: {
        name,
        group: "database_startup",
        value,
        properties: {
          startup_event_id: eventId,
          startup_id: state.startupId,
          attempt_id: state.attemptId,
          status: state.phase,
          stage: state.failedPhase ?? state.phase,
          error_code: state.errorCode ?? "none",
          ...properties,
        },
      },
      context: {
        deviceMid,
        platform: process.platform,
        appVersion: LCODE_VERSION,
        armsEnv: armsRum.getConfig().env === "prod" ? "prod" : "local",
        rendererId: 0,
      },
    });
    armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]);
  } catch {
    /* 上报入口失败不能阻断启动或失败提示。 */
  }
}

/** 输入是 Host 聚合镜像；不访问数据库/故障磁盘、不写逐样本日志。 */
export function reportDatabaseStartupState(state: DatabaseStartupState): void {
  let attempt = attempts.get(state.attemptId);
  if (!attempt) {
    if (attempts.size >= 128) attempts.delete(attempts.keys().next().value!);
    attempt = {
      lastStage: "starting",
      stageAt: state.startedAt,
      databaseFinished: false,
      terminal: false,
    };
    attempts.set(state.attemptId, attempt);
    send(state, "database_startup_started", 1);
  }
  if (attempt.terminal) return;
  const stage = `${state.phase}:${state.databasePhase ?? "none"}`;
  if (stage !== attempt.lastStage) {
    send(state, "database_startup_stage", Math.max(0, state.updatedAt - attempt.stageAt), {
      completed_stage: attempt.lastStage,
    });
    attempt.lastStage = stage;
    attempt.stageAt = state.updatedAt;
  }
  if (!attempt.databaseFinished && ["starting_services", "ready", "failed"].includes(state.phase)) {
    attempt.databaseFinished = true;
    send(state, "database_startup_result", state.updatedAt - state.startedAt, {
      status: state.phase === "failed" ? "failed" : "ready",
      sqlite_code: state.sqliteCode,
      system_code: state.systemCode,
      migration_id: state.migrationId,
      migration_kind:
        state.phase === "failed" && state.migration?.kind === "none"
          ? "unknown"
          : (state.migration?.kind ?? "unknown"),
      migration_executed_count: state.migration?.executedCount,
      migration_committed_count: state.migration?.committedCount,
    });
    for (const baseline of state.migrationBaselines ?? [])
      send(state, "database_startup_baseline", 1, {
        database_id: baseline.databaseId,
        database_kind: baseline.databaseKind,
        last_applied_migration_id:
          baseline.lastAppliedMigrationId === null
            ? "none"
            : (baseline.lastAppliedMigrationId ?? "unknown"),
      });
  }
  if (state.phase !== "ready" && state.phase !== "failed") return;
  attempt.terminal = true;
  send(
    state,
    state.phase === "ready" ? "app_startup_ready" : "app_startup_failed",
    state.updatedAt - state.startedAt,
  );
  for (const disk of state.disk)
    send(
      state,
      disk.observedAvailableDropPeakBytes === null
        ? "database_startup_disk_unavailable"
        : "database_startup_disk",
      disk.observedAvailableDropPeakBytes ?? 1,
      {
        scope_id: disk.scopeId,
        quality: disk.quality,
        peak_known: disk.observedAvailableDropPeakBytes !== null,
        observed_available_drop_peak_bytes: disk.observedAvailableDropPeakBytes ?? "unknown",
        stale_ms:
          disk.sampledAt === null ? "unknown" : Math.max(0, state.updatedAt - disk.sampledAt),
      },
    );
  logger.info("[database-startup] terminal", {
    attemptId: state.attemptId,
    status: state.phase,
    durationMs: state.updatedAt - state.startedAt,
    errorCode: state.errorCode,
    disk: state.disk,
  });
}
