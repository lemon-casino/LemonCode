import type { SessionStorePort } from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";

type Input = Parameters<NonNullable<SessionStorePort["worktreeCleanup"]>>[0];
export const worktreeCleanupMethods = {
  async worktreeCleanup(this: SqliteStoreAccess, input: Input): Promise<{ sessionIds: string[] }> {
    const query = () => {
      const seeds = [...new Set(input.seedSessionIds ?? input.sessionIds ?? [])];
      const exists = this.db.prepare("select id from session where id = ?");
      // 子代理未保存 runtime binding 条目；原主会话被旧版删除后，只能沿原 journal 的父子链恢复范围。
      // 存在的 seed 不能自行变成授权根，否则会把同路径的外来会话纳入永久删除。
      const rows = this.db
        .prepare(`
        with recursive refs as (
          select session_id, data, row_number() over (partition by session_id order by time_created desc, rowid desc) as rank
          from session_entry where type = 'runtime/worktree_binding'
        ), owned_roots(id) as (
          select s.id from session s join refs e on s.id = e.session_id
          where e.rank = 1 and json_valid(e.data)
            and json_extract(e.data, '$.executionBindingId') = ?
            and json_extract(e.data, '$.workspacePath') = ?
            and coalesce(nullif(trim(s.workspace_id), ''), s.directory) = ?
            and coalesce(json_extract(e.data, '$.originWorkspacePath'), ?) = ?
            and coalesce(json_extract(e.data, '$.originWorkspaceIdentity'), '') = ?
        ), descendants(id) as (
          select id from owned_roots
          union
          select j.value from json_each(?) j where not exists (select 1 from session s where s.id = j.value)
          union
          select s.id from session s join descendants p on s.parent_id = p.id
          left join refs e on e.session_id = s.id and e.rank = 1
          where s.directory = ? and coalesce(nullif(trim(s.workspace_id), ''), s.directory) = ?
            and (e.session_id is null or case when json_valid(e.data) then
              json_extract(e.data, '$.executionBindingId') = ?
              and json_extract(e.data, '$.workspacePath') = ?
              and coalesce(json_extract(e.data, '$.originWorkspacePath'), ?) = ?
              and coalesce(json_extract(e.data, '$.originWorkspaceIdentity'), '') = ?
            else 0 end)
        )
        select s.id from session s join descendants d on s.id = d.id order by s.id
      `)
        .all(
          input.executionBindingId,
          input.workspacePath,
          input.workspaceIdentity?.trim() || input.workspacePath,
          input.originWorkspacePath,
          input.originWorkspacePath,
          input.originWorkspaceIdentity?.trim() || "",
          JSON.stringify(seeds),
          input.workspacePath,
          input.workspaceIdentity?.trim() || input.workspacePath,
          input.executionBindingId,
          input.workspacePath,
          input.originWorkspacePath,
          input.originWorkspacePath,
          input.originWorkspaceIdentity?.trim() || "",
        ) as { id: string }[];
      const allowed = new Set(rows.map((row) => row.id));
      for (const id of seeds)
        if (!allowed.has(id) && exists.get(id))
          throw new Error("Session is outside the confirmed worktree cleanup scope");
      return rows;
    };
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
      // 完整集合必须先由 Worktree owner 持久化；不能 purge 后才发现子会话，使诊断文件重试失去 ID。
      const requested = new Set(ids);
      if ([...allowed].some((id) => !requested.has(id)))
        throw new Error("Worktree cleanup set changed; recollect sessions before deleting");
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
