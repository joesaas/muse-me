import { timingSafeEqual } from "node:crypto";
import type { SessionStore } from "../domain/ports.js";

/**
 * 登录用例：口令校验（恒定时间比较）+ 会话签发/校验。
 * 会话存储经 SessionStore 小接口注入，本类不关心存储介质。
 */
export class AuthService {
  constructor(
    private readonly password: string,
    private readonly userId: string,
    private readonly sessions: SessionStore,
  ) {}

  /** 口令正确返回会话 token，错误返回 null。 */
  login(password: string): string | null {
    const expected = Buffer.from(this.password, "utf-8");
    const given = Buffer.from(password ?? "", "utf-8");
    const ok =
      expected.length === given.length && timingSafeEqual(expected, given);
    return ok ? this.sessions.create(this.userId) : null;
  }

  /** token -> userId；无效返回 undefined。 */
  authenticate(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return this.sessions.resolve(token);
  }
}
