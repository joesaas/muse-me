/**
 * 调度时间与触发校验（纯函数，移植 Python scheduler.py 的
 * parse_iso / validate_trigger / next_fire 口径）：
 * - validate_trigger 只验 time 类：cron_daily 须 HH:MM 且在范围内，
 *   every_minutes 给出时须为整数 ≥ 1；非法返回原因字符串，合法返回 null。
 * - next_fire 以 Job.nextFireAt 为正本滚动；event/condition 无时间表，原样返回。
 * 时刻字符串统一用 ISO（UTC），与本包 nowIso 口径一致。
 */

/** 宽容解析 ISO 时刻（Date.parse 兼容 Python parse_iso 的常见格式）；失败返回 undefined。 */
export function parseIso(text: string | null | undefined): Date | undefined {
  if (!text) return undefined;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/** Python int(str) 口径：可选符号 + 纯数字（容忍首尾空白），否则 null。 */
function pyIntOfString(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** Python int(value) 口径：数字截断、数字字符串解析、bool 取 0/1，其余 null。 */
function pyIntOfValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string") return pyIntOfString(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

export interface TriggerLike {
  triggerType: string;
  triggerSpec: Record<string, unknown>;
  nextFireAt?: string;
}

/** 校验 trigger_spec 是否合法；合法返回 null，非法返回原因（同 Python validate_trigger）。 */
export function validateTrigger(job: TriggerLike): string | null {
  const spec = job.triggerSpec ?? {};
  if (job.triggerType !== "time") return null;
  const daily = spec.cron_daily;
  if (daily !== undefined && daily !== null && daily !== "") {
    const parts = String(daily).split(":");
    if (parts.length !== 2) {
      return `cron_daily 格式应为 HH:MM，实际是「${String(daily)}」`;
    }
    const hh = pyIntOfString(parts[0]!);
    const mm = pyIntOfString(parts[1]!);
    if (hh === null || mm === null) {
      return `cron_daily 不是数字时间：「${String(daily)}」`;
    }
    if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) {
      return `cron_daily 超出范围（00:00–23:59）：「${String(daily)}」`;
    }
    return null;
  }
  const every = spec.every_minutes;
  if (every !== undefined && every !== null) {
    const minutes = pyIntOfValue(every);
    if (minutes === null) return `every_minutes 不是整数：「${String(every)}」`;
    if (minutes < 1) return `every_minutes 必须 ≥ 1，实际是 ${minutes}`;
  }
  return null;
}

/**
 * 计算严格晚于 now 的下一次触发时刻（ISO 字符串）。
 * 防御口径同 Python：cron_daily 解析/范围失败返回 ""；every_minutes 解析
 * 失败按 60、小于 1 钳到 1，保证滚动必然前进、不挂死。
 */
export function nextFire(job: TriggerLike, now: Date): string {
  const spec = job.triggerSpec ?? {};
  if (job.triggerType === "time") {
    const daily = spec.cron_daily;
    if (daily) {
      const parts = String(daily).split(":");
      const hh = parts.length === 2 ? pyIntOfString(parts[0]!) : null;
      const mm = parts.length === 2 ? pyIntOfString(parts[1]!) : null;
      if (hh === null || mm === null || !(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) {
        return "";
      }
      const candidate = new Date(now);
      candidate.setHours(hh, mm, 0, 0);
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate.toISOString();
    }
    const raw = spec.every_minutes;
    let minutes =
      raw === undefined || raw === null || raw === 0 || raw === ""
        ? 60
        : (pyIntOfValue(raw) ?? 60);
    minutes = Math.max(1, minutes);
    const prev = parseIso(job.nextFireAt);
    let candidate = prev
      ? new Date(prev)
      : new Date(now.getTime() + minutes * 60_000);
    while (candidate.getTime() <= now.getTime()) {
      candidate = new Date(candidate.getTime() + minutes * 60_000);
    }
    return candidate.toISOString();
  }
  return job.nextFireAt ?? "";
}
