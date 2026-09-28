// ============================================================
// Dynamic Workflow Run Service：孤儿 run 的构造时收敛
// ============================================================
// dynamic-workflow-run-service.ts 顶到 oxlint max-lines 上限（400 行），把孤儿收敛
// （interruptedRunFailure / reconcileOrphanRuns）拆到本文件；公开面仍从
// dynamic-workflow-run-service.ts 导出。语义见那边文件头的不变式 4。

import type { Logger } from "@lcode/contracts";
import type { JournalStorePort, RunRecord, WorkflowErrorJson } from "@lcode/dynamic-workflow";
import { supportsNonTerminalRunQuery } from "./dynamic-workflow-run-journal.js";
import {
  INTERRUPTED_FAILURE_CODE,
  TERMINAL_RUN_STATUSES,
} from "./dynamic-workflow-run-observation.js";

/**
 * 收敛所需的 deps 子集（DynamicWorkflowRunServiceDeps 的结构子集，service 原样递进来）。
 * 只列这三项而不引整个 deps 类型：收敛只读 journal、只认本会话，多出来的依赖只会让「它到底
 * 碰了什么」变得不可见。
 */
interface DynamicWorkflowOrphanReconcileDeps {
  journal: JournalStorePort;
  parentSessionId: string;
  logger?: Logger;
}

/**
 * interrupted 的失败编码。沿用引擎的 {@link WorkflowErrorJson} 形态（落 dwf_run.failure_json，
 * 与引擎自己的失败同一个读面），但 code 是**专属的**：
 *
 *   - 不能是 `DriverError`——脚本自己抛错也编码成它（dynamic-workflow-runtime/src/harness.ts），
 *     同码就只能靠 message 文本区分「进程被杀」与「脚本真失败」；
 *   - 状态不能是 `cancelled`——那是「用户取消」的语义。两者都可恢复（resume 门认
 *     {@link INTERRUPTED_FAILURE_CODE}），但语义必须保持可分辨。
 */
function interruptedRunFailure(runId: string): WorkflowErrorJson {
  return {
    code: INTERRUPTED_FAILURE_CODE,
    message: `dynamic workflow run ${runId} was interrupted: the owning process exited before the run settled`,
  };
}

/**
 * 构造时收敛本父会话的孤儿 run（曾经的问题：
 * run-started 之后进程被关掉，dwf_run 行**永远停在 running**，而 getTask/waitForTask 对不在
 * 本进程注册表里的 run 直接回 journal 快照，于是恢复会话后每个 journal 读面都被告知「还在跑」，
 * 永不自愈）。
 *
 * 为什么时机是**构造**：这一刻本服务实例名下零个在飞 run，所以 journal 里属于本会话的任何
 * 非终态行都只可能是死进程的遗物。二次构造因此天然幂等（已无非终态项）。
 *
 * 三条边界：
 *   - **只收敛本会话**（`deps.parentSessionId`）。全局清扫会把同进程兄弟会话正在飞的 run 标死；
 *     同会话双进程由会话单属主排除。
 *   - **不合成 dwf_event**。事件日志的契约是「引擎发过什么」，状态权威在 run 行上；
 *     `run-settled` 是引擎的收口，不是清扫者的。
 *   - **不让收敛失败拖垮构造**。收敛是自愈动作而不是 run 的前提：查询或写入失败时记 warn 并
 *     继续（后果只是那行谎言还在），绝不把一次 app 构造变成启动失败。
 */
export function reconcileOrphanRuns(deps: DynamicWorkflowOrphanReconcileDeps): void {
  const { journal, logger, parentSessionId } = deps;
  if (!supportsNonTerminalRunQuery(journal)) {
    logger?.warn?.("Dynamic workflow orphan run reconciliation skipped", {
      event: "dynamic_workflow.run.reconcile_skipped",
      module: "bootstrap.app",
      reason: "journal_missing_list_non_terminal_runs",
    });
    return;
  }

  let orphans: RunRecord[];
  try {
    orphans = journal.listNonTerminalRuns(parentSessionId);
  } catch (error) {
    logger?.warn?.("Dynamic workflow orphan run query failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.run.reconcile_failed",
      module: "bootstrap.app",
    });
    return;
  }

  for (const record of orphans) {
    // 终态判定的权威在本文件（TERMINAL_RUN_STATUSES）：journal 的 status 过滤只是预筛。
    if (TERMINAL_RUN_STATUSES.has(record.status)) continue;
    try {
      // stopped(interrupted)：可恢复，且与用户
      // 取消 / 模型侧停止分辨得开——reason 说「进程死了」，code 是同一事实的第二证据。
      journal.updateRunStatus(record.runId, "stopped", {
        stopReason: "interrupted",
        failure: interruptedRunFailure(record.runId),
      });
      logger?.warn?.("Dynamic workflow run reconciled as interrupted", {
        event: "dynamic_workflow.run.reconciled_interrupted",
        module: "bootstrap.app",
        previousStatus: record.status,
        runId: record.runId,
      });
    } catch (error) {
      logger?.warn?.("Dynamic workflow orphan run reconciliation failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.run.reconcile_failed",
        module: "bootstrap.app",
        runId: record.runId,
      });
    }
  }
}
