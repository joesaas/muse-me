import type { DatabaseSync } from "node:sqlite";
import type { SecretRefStore } from "../../domain/ports.js";
import type { SecretRefRecord } from "../../domain/types.js";

/** SecretRefStore 的 SQLite 实现：只读引用清单（只存引用名，不存明文）。 */
export class SqliteSecretRefStore implements SecretRefStore {
  constructor(private readonly db: DatabaseSync) {}

  listSecretRefs(userId: string): SecretRefRecord[] {
    const rows = this.db
      .prepare(
        "SELECT name, ref, created_at FROM secrets_ref WHERE user_id = ? ORDER BY name",
      )
      .all(userId) as unknown as Array<{
        name: string;
        ref: string;
        created_at: string;
      }>;
    return rows.map((row) => ({
      name: row.name,
      ref: row.ref,
      createdAt: row.created_at,
    }));
  }
}
