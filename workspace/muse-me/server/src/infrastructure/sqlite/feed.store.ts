import type { DatabaseSync } from "node:sqlite";
import type { FeedStore } from "../../domain/ports.js";
import type { FeedItemRecord } from "../../domain/types.js";
import { nowIso } from "./database.js";
import { parseJsonObject } from "./json.js";

interface FeedRow {
  id: string;
  user_id: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  topic: string;
  entities: string;
  published_at: string;
  prompt_version: number | null;
  created_at: string;
}

function toItem(row: FeedRow): FeedItemRecord {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    summary: row.summary,
    source: row.source,
    url: row.url,
    topic: row.topic,
    entities: parseJsonObject(row.entities),
    publishedAt: row.published_at,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/** FeedStore 的 SQLite 实现：replace 为整表替换（同 Python replace_feed_items）。 */
export class SqliteFeedStore implements FeedStore {
  constructor(private readonly db: DatabaseSync) {}

  replaceFeedItems(userId: string, items: FeedItemRecord[]): void {
    this.db.prepare("DELETE FROM feed_items WHERE user_id = ?").run(userId);
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO feed_items
         (id, user_id, title, summary, source, url, topic, entities,
          published_at, prompt_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      stmt.run(
        item.id, userId, item.title, item.summary, item.source, item.url,
        item.topic, JSON.stringify(item.entities ?? {}), item.publishedAt,
        item.promptVersion, item.createdAt || nowIso(),
      );
    }
  }

  listFeedItems(userId: string, limit = 50): FeedItemRecord[] {
    // 与 Python list_feed_items 同序：created_at DESC, rowid DESC。
    const rows = this.db
      .prepare(
        "SELECT * FROM feed_items WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(userId, limit) as unknown as FeedRow[];
    return rows.map(toItem);
  }

  getFeedItem(id: string): FeedItemRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM feed_items WHERE id = ?")
      .get(id) as unknown as FeedRow | undefined;
    return row ? toItem(row) : undefined;
  }
}
