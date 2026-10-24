import type { DatabaseSync } from "node:sqlite";
import type { NotificationStore } from "../../domain/ports.js";
import type { NotificationRecord } from "../../domain/types.js";

interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  read: number;
  created_at: string;
}

/** NotificationStore 的 SQLite 实现：站内通知（调度与 notify.send 的落点）。 */
export class SqliteNotificationStore implements NotificationStore {
  constructor(private readonly db: DatabaseSync) {}

  addNotification(note: NotificationRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO notifications
           (id, user_id, kind, title, body, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id, note.userId, note.kind, note.title, note.body,
        note.read ? 1 : 0, note.createdAt,
      );
  }

  listNotifications(userId: string): NotificationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, rowid")
      .all(userId) as unknown as NotificationRow[];
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      read: Boolean(row.read),
      createdAt: row.created_at,
    }));
  }
}
