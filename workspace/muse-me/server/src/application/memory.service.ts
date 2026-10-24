import { randomUUID } from "node:crypto";
import {
  GuardrailDenied,
  InvalidTransition,
  NotFound,
} from "../domain/errors.js";
import type { MemoryStore } from "../domain/ports.js";
import type { MemoryRecord } from "../domain/types.js";
import { nowIso } from "../infrastructure/sqlite/database.js";

/**
 * 记忆用例（同 Python MemoryService）：写入分级——fact 直接 active、
 * inference 入 pending、never 拒收（403）；未给级别归 inference。
 * decide 只许 pending：非 pending 在服务层先抛 409，store 原子条件是并发防线。
 */
export class MemoryService {
  constructor(
    private readonly memories: MemoryStore,
    private readonly userId: string,
  ) {}

  add(content: string, level?: string | null, source = ""): MemoryRecord {
    const finalLevel = level || "inference";
    if (finalLevel === "never") {
      throw new GuardrailDenied("这条内容被标记为「说过不记」，拒绝入库");
    }
    const item: MemoryRecord = {
      id: randomUUID(),
      userId: this.userId,
      content,
      level: finalLevel,
      status: finalLevel === "fact" ? "active" : "pending",
      source,
      createdAt: nowIso(),
    };
    this.memories.addMemory(item);
    return item;
  }

  list(status?: string): MemoryRecord[] {
    return this.memories.listMemories(this.userId, status);
  }

  get(memoryId: string): MemoryRecord {
    const item = this.memories.getMemory(memoryId);
    if (!item) throw new NotFound(`记忆不存在：${memoryId}`);
    return item;
  }

  decide(memoryId: string, approved: boolean): MemoryRecord {
    const item = this.get(memoryId);
    if (item.status !== "pending") {
      throw new InvalidTransition(
        `记忆已不在待批准区（当前状态 ${item.status}），不可再裁决：${memoryId}`,
      );
    }
    const applied = this.memories.decideMemory(memoryId, approved);
    if (!applied) {
      const fresh = this.get(memoryId);
      throw new InvalidTransition(
        `记忆已决策（当前状态 ${fresh.status}），不可重复决策：${memoryId}`,
      );
    }
    return this.get(memoryId);
  }

  delete(memoryId: string): void {
    if (!this.memories.deleteMemory(memoryId)) {
      throw new NotFound(`记忆不存在：${memoryId}`);
    }
  }
}
