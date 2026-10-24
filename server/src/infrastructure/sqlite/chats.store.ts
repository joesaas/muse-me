import type { DatabaseSync } from "node:sqlite";
import type { ChatStore } from "../../domain/ports.js";
import type { Chat, Message } from "../../domain/types.js";

interface ChatRow {
  id: string;
  user_id: string;
  title: string;
  kind: string;
  feed_item_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  created_at: string;
}

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    kind: row.kind === "side" ? "side" : "main",
    feedItemId: row.feed_item_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as Message["role"],
    content: row.content,
    createdAt: row.created_at,
  };
}

/** ChatStore 的 SQLite 实现：只管 chats / messages 两张表。 */
export class SqliteChatStore implements ChatStore {
  constructor(private readonly db: DatabaseSync) {}

  createChat(chat: Chat): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, user_id, title, kind, feed_item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chat.id, chat.userId, chat.title, chat.kind, chat.feedItemId, chat.createdAt, chat.updatedAt);
  }

  getChat(id: string): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
      | ChatRow
      | undefined;
    return row ? toChat(row) : undefined;
  }

  listChats(userId: string): Chat[] {
    const rows = this.db
      .prepare("SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC")
      .all(userId) as unknown as ChatRow[];
    return rows.map(toChat);
  }

  addMessage(message: Message): void {
    this.db
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(message.id, message.chatId, message.role, message.content, message.createdAt);
    this.db
      .prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(message.createdAt, message.chatId);
  }

  listMessages(chatId: string): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(chatId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }
}
