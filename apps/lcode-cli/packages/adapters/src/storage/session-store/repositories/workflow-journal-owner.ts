import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { JournalStorePort, WorkflowJournalOwnerLease } from "@lcode/dynamic-workflow";
import {
  currentWorkflowProcessIdentity,
  probeWorkflowOwner,
  type WorkflowProcessIdentity,
} from "../../workflow-process-owner.js";

const OWNER_NAMESPACE = "workflow.execution";
const OWNER_KEY = "owner";
const SAVEPOINT = "workflow_owner_write";
const WRITES = new Set([
  "createRun",
  "updateRunStatus",
  "updateRunUsage",
  "putActor",
  "putNode",
  "appendEvent",
]);
const ownerSchema = z
  .object({
    version: z.literal(1),
    token: z.string().min(1),
    generation: z.number().int().positive(),
    workspaceKey: z.string().min(1),
    state: z.enum(["active", "retired"]),
    hostId: z.string().min(1),
    processId: z.number().int().positive(),
    startedAt: z.number().finite(),
  })
  .strict();

export class WorkflowExecutionOwnerError extends Error {
  constructor(readonly code: "owner_active" | "owner_unknown" | "owner_changed") {
    super(`Workflow execution unavailable: ${code}`);
    this.name = "WorkflowExecutionOwnerError";
  }
}

/** 现有 KV 中保存一个执行 lease；没有 schema migration，也不复制 run 状态。 */
export async function acquireWorkflowJournalOwner(options: {
  db: DatabaseSync;
  journal: JournalStorePort;
  parentSessionId: string;
  workspaceKey: string;
  processIdentity?: WorkflowProcessIdentity;
  probeOwner?: (
    owner: WorkflowProcessIdentity,
    current: WorkflowProcessIdentity,
  ) => Promise<"alive" | "retired" | "unknown">;
}): Promise<WorkflowJournalOwnerLease> {
  const { db, journal, parentSessionId, workspaceKey } = options;
  const read = () =>
    (
      db
        .prepare(
          "select value from local_setting where scope = 'session' and scope_id = ? and namespace = ? and key = ?",
        )
        .get(parentSessionId, OWNER_NAMESPACE, OWNER_KEY) as { value: string } | undefined
    )?.value;
  const expected = read();
  const identity = options.processIdentity ?? currentWorkflowProcessIdentity();
  let generation = 1;
  if (expected !== undefined) {
    let parsed: ReturnType<typeof ownerSchema.safeParse>;
    try {
      parsed = ownerSchema.safeParse(JSON.parse(expected));
    } catch {
      throw new WorkflowExecutionOwnerError("owner_unknown");
    }
    if (!parsed.success || parsed.data.workspaceKey !== workspaceKey)
      throw new WorkflowExecutionOwnerError("owner_unknown");
    const owner = parsed.data;
    if (owner.state === "active") {
      const state = await (options.probeOwner ?? probeWorkflowOwner)(owner, identity);
      if (state !== "retired")
        throw new WorkflowExecutionOwnerError(state === "alive" ? "owner_active" : "owner_unknown");
    }
    generation = owner.generation + 1;
  } else {
    // 旧版本未携带 owner 时，空本地注册表不能证明 journal 中的运行已经死亡。
    const active = db
      .prepare(
        "select 1 from dwf_run where parent_session_id = ? and status in ('pending', 'running') limit 1",
      )
      .get(parentSessionId);
    if (active) throw new WorkflowExecutionOwnerError("owner_unknown");
  }
  const record = {
    version: 1 as const,
    token: randomUUID(),
    generation,
    workspaceKey,
    state: "active" as const,
    ...identity,
  };
  const value = JSON.stringify(record);
  const now = Date.now();
  const claimed = db
    .prepare(`insert into local_setting (scope, scope_id, namespace, key, value, schema_version, time_created, time_updated)
    values ('session', ?, ?, ?, ?, 1, ?, ?)
    on conflict(scope, scope_id, namespace, key) do update set value = excluded.value, time_updated = excluded.time_updated
    where local_setting.value = ?`)
    .run(parentSessionId, OWNER_NAMESPACE, OWNER_KEY, value, now, now, expected ?? null);
  if (!claimed.changes) throw new WorkflowExecutionOwnerError("owner_changed");
  const assertOwned = () => {
    if (read() !== value) throw new WorkflowExecutionOwnerError("owner_changed");
  };
  const guarded = <T>(operation: () => T): T => {
    // 校验和写入必须处于同一 SQLite 事务，不能 await 后用旧 token 写新代。
    db.exec(`savepoint ${SAVEPOINT}`);
    try {
      // SAVEPOINT 是延迟事务；先 SELECT owner 会在并发连接提交后留下旧 WAL 快照，
      // 后续 appendEvent 升级写锁即报 SQLITE_BUSY_SNAPSHOT，busy_timeout 也无法等待解决。
      // 第一条语句用完整 owner 值做条件 UPDATE，先取得写锁并完成 fencing；值和时间均不变。
      const owned = db
        .prepare(
          "update local_setting set value = value where scope = 'session' and scope_id = ? and namespace = ? and key = ? and value = ?",
        )
        .run(parentSessionId, OWNER_NAMESPACE, OWNER_KEY, value);
      if (!owned.changes) throw new WorkflowExecutionOwnerError("owner_changed");
      const result = operation();
      db.exec(`release savepoint ${SAVEPOINT}`);
      return result;
    } catch (error) {
      db.exec(`rollback to savepoint ${SAVEPOINT}`);
      db.exec(`release savepoint ${SAVEPOINT}`);
      throw error;
    }
  };
  const assertRunScope = (runId: string) => {
    const run = journal.getRun(runId);
    if (run && run.parentSessionId !== parentSessionId)
      throw new WorkflowExecutionOwnerError("owner_changed");
  };
  const ownedJournal = new Proxy(journal, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      if (typeof member !== "function") return member;
      if (!WRITES.has(String(key))) return member.bind(target);
      return (...args: unknown[]) =>
        guarded(() => {
          if (key === "createRun") {
            if ((args[0] as { parentSessionId?: string }).parentSessionId !== parentSessionId)
              throw new WorkflowExecutionOwnerError("owner_changed");
          } else
            assertRunScope(
              typeof args[0] === "string" ? args[0] : (args[0] as { runId: string }).runId,
            );
          return member.apply(target, args);
        });
    },
  });
  return {
    journal: ownedJournal,
    generation,
    assertOwned,
    reconcileInterrupted: (runId, status, settlement) =>
      guarded(() => {
        assertRunScope(runId);
        if (
          journal.getRun(runId)?.status !== status ||
          (status !== "pending" && status !== "running")
        )
          return false;
        journal.updateRunStatus(runId, "stopped", settlement);
        return true;
      }),
    release() {
      db.prepare(
        "update local_setting set value = ?, time_updated = ? where scope = 'session' and scope_id = ? and namespace = ? and key = ? and value = ?",
      ).run(
        JSON.stringify({ ...record, state: "retired" }),
        Date.now(),
        parentSessionId,
        OWNER_NAMESPACE,
        OWNER_KEY,
        value,
      );
    },
  };
}
