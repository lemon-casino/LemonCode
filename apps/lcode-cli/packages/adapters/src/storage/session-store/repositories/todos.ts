import type { DatabaseSync } from "node:sqlite";
import type { SessionId, TodoItem } from "@lcode/contracts";
import { decodeTodoRow } from "../codecs.js";
import type { TodoRow } from "../rows.js";
import { touchSession } from "./sessions.js";

export async function readTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<TodoItem[]> {
  const rows = db
    .prepare(
      `
      select * from todo
      where session_id = ?
      order by position asc
      `,
    )
    .all(input.sessionID) as unknown as TodoRow[];

  return rows.map(decodeTodoRow);
}

export async function updateTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId; todos: TodoItem[] },
): Promise<void> {
  const now = Date.now();

  db.exec("begin immediate");
  try {
    db.prepare("delete from todo where session_id = ?").run(input.sessionID);
    if (input.todos.length > 0) {
      const insert = db.prepare(
        `
        insert into todo (
          session_id, content, status, priority, position, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [position, todo] of input.todos.entries()) {
        insert.run(input.sessionID, todo.content, todo.status, todo.priority, position, now, now);
      }
    }
    touchSession(db, input.sessionID, now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
