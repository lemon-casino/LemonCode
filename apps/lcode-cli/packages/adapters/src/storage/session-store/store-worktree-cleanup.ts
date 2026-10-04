import type { SessionStorePort } from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";

type Input = Parameters<NonNullable<SessionStorePort["worktreeCleanup"]>>[0];
export const worktreeCleanupMethods = {
  async worktreeCleanup(this: SqliteStoreAccess, input: Input): Promise<{ sessionIds: string[] }> {
    const query = () =>
      this.db
        .prepare(`
      with refs as (
        select session_id, data, row_number() over (partition by session_id order by time_created desc, rowid desc) as rank
        from session_entry where type = 'runtime/worktree_binding'
      )
      select s.id from session s join refs e on s.id = e.session_id
      where e.rank = 1 and json_valid(e.data)
        and json_extract(e.data, '$.executionBindingId') = ?
        and json_extract(e.data, '$.workspacePath') = ?
        and coalesce(s.workspace_id, s.directory) = ?
        and coalesce(json_extract(e.data, '$.originWorkspacePath'), ?) = ?
        and coalesce(json_extract(e.data, '$.originWorkspaceIdentity'), '') = ?
      order by s.id
    `)
        .all(
          input.executionBindingId,
          input.workspacePath,
          input.workspaceIdentity?.trim() || input.workspacePath,
          input.originWorkspacePath,
          input.originWorkspacePath,
          input.originWorkspaceIdentity?.trim() || "",
        ) as { id: string }[];
    if (input.sessionIds === undefined) return { sessionIds: query().map((row) => row.id) };
    this.throwBeforeWrite();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const allowed = new Set(query().map((row) => row.id));
      const ids = [...new Set(input.sessionIds)];
      // 目录删除后的重试允许已消失的 ID；仍存在的记录必须逐一证明属于原绑定。
      for (const id of ids) {
        if (!allowed.has(id) && this.db.prepare("select id from session where id = ?").get(id))
          throw new Error("Session is outside the confirmed worktree cleanup scope");
      }
      for (const id of ids) {
        this.db.prepare("delete from input_history where session_id = ?").run(id);
        this.db.prepare("delete from dwf_run where parent_session_id = ?").run(id);
        this.db.prepare("delete from workflow_run where parent_session_id = ?").run(id);
        this.db.prepare("delete from session where id = ?").run(id);
      }
      this.db.exec("COMMIT");
      return { sessionIds: ids };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },
};
