import { randomBytes } from "node:crypto";
import type { SessionStore } from "../../domain/ports.js";

/** SessionStore 的内存实现：登录 token 只存进程内（单机 Demo 口径，同 Python 版）。 */
export class InMemorySessionStore implements SessionStore {
  private readonly tokens = new Map<string, string>();

  create(userId: string): string {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, userId);
    return token;
  }

  resolve(token: string): string | undefined {
    return this.tokens.get(token);
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}
