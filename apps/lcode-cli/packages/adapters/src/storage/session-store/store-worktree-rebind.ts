import type { SessionStorePort } from "@lcode/contracts";
import {
  lcodeSessionWorktreeRebindParamsSchema,
  lcodeWorkspaceRefSchema,
  type LCodeSessionWorktreeRebindParams,
  type RuntimeEnvironmentReference,
} from "@lcode/shared";
import type { SqliteStoreAccess } from "./store-access.js";

type Input = Parameters<NonNullable<SessionStorePort["worktreeRebind"]>>[0];
interface BindingRow {
  id: string;
  entry_id: string;
  directory: string;
  path: string | null;
  workspace_id: string | null;
  data: string;
}
const identityKey = (path: string, identity?: string | null) => identity?.trim() || path;
const sameRef = (
  left: RuntimeEnvironmentReference | undefined,
  right: RuntimeEnvironmentReference,
) =>
  left?.environmentId === right.environmentId &&
  left.revision === right.revision &&
  left.manifestDigest === right.manifestDigest;

function readBindings(owner: SqliteStoreAccess, input: LCodeSessionWorktreeRebindParams) {
  // 先排序取每个 session 的最新引用再过滤；不能让旧引用、归档或隐藏投影决定迁移集合。
  const rows = owner.db
    .prepare(`
    with refs as (
      select id, session_id, data,
        row_number() over (partition by session_id order by time_created desc, rowid desc) as rank
      from session_entry where type = 'runtime/worktree_binding'
    )
    select s.id, e.id as entry_id, s.directory, s.path, s.workspace_id, e.data
    from session s join refs e on s.id = e.session_id
    where e.rank = 1 and json_valid(e.data)
      and json_extract(e.data, '$.executionBindingId') = ?
      and coalesce(nullif(trim(json_extract(e.data, '$.originWorkspaceIdentity')), ''),
        json_extract(e.data, '$.originWorkspacePath')) = ?
      and coalesce(nullif(trim(json_extract(e.data, '$.workspaceIdentity')), ''),
        json_extract(e.data, '$.workspacePath')) = ?
    order by s.id
  `)
    .all(
      input.executionBindingId,
      identityKey(input.originWorkspacePath, input.originWorkspaceIdentity),
      identityKey(input.workspacePath, input.workspaceIdentity),
    ) as unknown as BindingRow[];
  return rows.map((row) => {
    const parsed = lcodeWorkspaceRefSchema.safeParse(JSON.parse(row.data));
    if (!parsed.success)
      throw new Error("Worktree rebind scope contains an invalid binding reference");
    const reference = parsed.data;
    if (
      reference.originWorkspacePath !== input.originWorkspacePath ||
      reference.workspacePath !== input.workspacePath ||
      reference.workspaceKey !== identityKey(input.workspacePath, input.workspaceIdentity) ||
      row.directory !== input.workspacePath ||
      (row.path !== null && row.path !== input.workspacePath) ||
      identityKey(row.directory, row.workspace_id) !==
        identityKey(input.workspacePath, input.workspaceIdentity)
    )
      throw new Error("Session is outside the confirmed worktree rebind scope");
    if (
      !sameRef(reference.environmentRef, input.oldEnvironmentRef) &&
      !sameRef(reference.environmentRef, input.newEnvironmentRef)
    )
      throw new Error("Worktree rebind environment reference mismatch");
    return { ...row, alreadyNew: sameRef(reference.environmentRef, input.newEnvironmentRef) };
  });
}

export const worktreeRebindMethods = {
  async worktreeRebind(this: SqliteStoreAccess, input: Input): Promise<{ sessionIds: string[] }> {
    const { expectedSessionIds, ...rawParams } = input;
    const params = lcodeSessionWorktreeRebindParamsSchema.parse(rawParams);
    if (expectedSessionIds === undefined)
      return { sessionIds: readBindings(this, params).map((row) => row.id) };
    this.throwBeforeWrite();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = readBindings(this, params);
      const sessionIds = rows.map((row) => row.id);
      const expected = [...new Set(expectedSessionIds)].sort();
      if (
        sessionIds.length !== expected.length ||
        sessionIds.some((id, index) => id !== expected[index])
      )
        throw new Error("Worktree rebind session scope changed before commit");
      for (const row of rows) {
        if (row.alreadyNew) continue;
        // 完整旧 JSON 作为 CAS 条件，json_set 只替换引用；child owner/identity/历史均原样保留。
        const result = this.db
          .prepare(`
          update session_entry set data = json_set(data, '$.environmentRef', json(?))
          where id = ? and session_id = ? and data = ?
        `)
          .run(JSON.stringify(params.newEnvironmentRef), row.entry_id, row.id, row.data);
        if (result.changes !== 1)
          throw new Error("Worktree rebind reference changed before commit");
      }
      this.db.exec("COMMIT");
      return { sessionIds };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },
};
