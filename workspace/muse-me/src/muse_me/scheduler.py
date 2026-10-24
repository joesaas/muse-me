"""调度引擎（定时任务 Bot）：独立守护线程 + 可手动 tick（测试用 fake clock）。

三类触发（架构 §6）：
- time：every_minutes 间隔 / cron_daily "HH:MM" 每天定点。Job.next_fire_at 为正本，
  到点即触发，触发后按规格滚动计算下一次。
- event：Feed 出现匹配关键词的新条目。守护进程以「首次 tick 见到的条目为基线」，
  之后新增且命中的条目各触发一次，参数带入条目实体（token 等）。
- condition：轮询原子工具返回值与阈值比较（metric 语法见 _eval_condition），
  **边沿触发**：上次评估为假、本次为真才执行一次；条件持续为真不重复执行，
  变假再变真才再触发。评估状态只存内存：进程重启后首次评估只建基线、
  不触发（防重启把持续为真的条件重复执行一遍）。另有冷却（默认 60 秒）
  作为边沿之外的防连发兜底。

输入保险：time 规格经 validate_trigger 校验（every_minutes ≥ 1、
cron_daily 为合法 HH:MM）；非法 job 在 tick/启用时被禁用并只通知一次，
不落 failure JobRun。next_fire 内部对非法值再做防御（钳制/返回空），
任何输入都不许让守护线程挂死或每秒灌 JobRun：tick 的失败记录按
（job, 错误）节流，60 秒内同错误只记一条；守护线程级异常写站内通知。

执行走注入的 script_runner(job, params, entity) -> {"run_id", "status", ...}；
每次尝试落一条 JobRun；执行返回 failed 或抛错算失败，最多 3 次尝试（退避可注入）。
结果 awaiting_approval 不算失败：写站内通知，JobRun 记 awaiting_approval。
"""
from __future__ import annotations

import operator
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .domain import Job, JobRun, Notification
from .ports import SystemClock

_ISO_FMT = "%Y-%m-%dT%H:%M:%S%z"
_OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt,
        "<=": operator.le, "==": operator.eq, "!=": operator.ne}


def parse_iso(text: str) -> datetime | None:
    if not text:
        return None
    for fmt in (_ISO_FMT, "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(text, fmt)
            return dt if dt.tzinfo else dt.astimezone()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def fmt_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.strftime(_ISO_FMT)


def validate_trigger(job: Job) -> str | None:
    """校验 trigger_spec 是否合法；合法返回 None，非法返回原因字符串。

    只校验 time 类（event/condition 无时间表可验）：
    - cron_daily 必须是 HH:MM 且 0≤HH≤23、0≤MM≤59；
    - every_minutes 若给出必须是整数且 ≥ 1。
    非法 job 由守护进程在 tick/启用时禁用并通知一次（见 SchedulerDaemon），
    不让非法值流进 next_fire 的计算。
    """
    spec = job.trigger_spec or {}
    if job.trigger_type != "time":
        return None
    daily = spec.get("cron_daily")
    if daily not in (None, ""):
        parts = str(daily).split(":")
        if len(parts) != 2:
            return f"cron_daily 格式应为 HH:MM，实际是「{daily}」"
        try:
            hh, mm = int(parts[0]), int(parts[1])
        except ValueError:
            return f"cron_daily 不是数字时间：「{daily}」"
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            return f"cron_daily 超出范围（00:00–23:59）：「{daily}」"
        return None
    every = spec.get("every_minutes")
    if every is not None:
        try:
            minutes = int(every)
        except (TypeError, ValueError):
            return f"every_minutes 不是整数：「{every}」"
        if minutes < 1:
            return f"every_minutes 必须 ≥ 1，实际是 {minutes}"
    return None


def next_fire(job: Job, now: datetime) -> str:
    """按 trigger_spec 计算严格晚于 now 的下一次触发时刻（ISO 字符串）。

    event / condition 触发没有时间表，返回原 next_fire_at 不变。
    防御口径（即使非法规格绕过 validate_trigger 漏进来也不许挂死）：
    cron_daily 解析/范围失败返回 ""（无触发时刻）；every_minutes 解析
    失败按 60、小于 1 一律钳到 1，保证 while 滚动必然前进。
    """
    spec = job.trigger_spec or {}
    if job.trigger_type == "time":
        daily = spec.get("cron_daily")
        if daily:
            parts = str(daily).split(":")
            try:
                if len(parts) != 2:
                    raise ValueError("bad cron_daily")
                hh, mm = int(parts[0]), int(parts[1])
                if not (0 <= hh <= 23 and 0 <= mm <= 59):
                    raise ValueError("cron_daily out of range")
            except ValueError:
                return ""
            candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if candidate <= now:
                candidate += timedelta(days=1)
            return fmt_iso(candidate)
        try:
            minutes = int(spec.get("every_minutes") or 60)
        except (TypeError, ValueError):
            minutes = 60
        minutes = max(1, minutes)
        prev = parse_iso(job.next_fire_at)
        candidate = prev if prev is not None else now + timedelta(minutes=minutes)
        while candidate <= now:
            candidate += timedelta(minutes=minutes)
        return fmt_iso(candidate)
    return job.next_fire_at or ""


class SchedulerDaemon:
    """调度守护：start() 起线程按 tick_seconds 轮询；tick() 可手动单步。"""

    def __init__(
        self,
        store: Any,
        script_runner: Callable[..., dict[str, Any]],
        registry: Any,
        *,
        user_id: str = "demo-user",
        clock: Any = None,
        tick_seconds: float = 1.0,
        retry_backoff: float = 0.5,
        max_attempts: int = 3,
        condition_cooldown_seconds: float = 60.0,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self._store = store
        self._runner = script_runner
        self._registry = registry
        self._user_id = user_id
        self._clock = clock or SystemClock()
        self._tick_seconds = tick_seconds
        self._retry_backoff = retry_backoff
        self._max_attempts = max_attempts
        self._condition_cooldown = condition_cooldown_seconds
        self._sleeper = sleeper
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seen_feed: dict[str, set[str]] = {}
        self._last_condition_fire: dict[str, float] = {}
        self._condition_state: dict[str, bool] = {}  # condition 边沿：上次评估值
        self._failure_last: dict[tuple[str, str], float] = {}  # 失败记录节流
        self._last_daemon_error_note: float = 0.0

    _FAILURE_THROTTLE_SECONDS = 60.0

    # ---------------- 线程管理 ----------------
    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="muse-me-scheduler", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:
                # 守护线程不因单轮异常退出，但不许静默：写一条站内通知（60 秒节流防刷屏）
                now_ts = self._clock.now_ts()
                if now_ts - self._last_daemon_error_note >= self._FAILURE_THROTTLE_SECONDS:
                    self._last_daemon_error_note = now_ts
                    try:
                        self._store.add_notification(Notification(
                            user_id=self._user_id, title="调度守护异常",
                            body=f"调度线程一轮执行出错：{exc}", kind="job"))
                    except Exception:
                        pass  # 通知本身失败不能拖垮守护线程
            self._stop.wait(self._tick_seconds)

    def _now(self, now: datetime | None) -> datetime:
        if now is not None:
            return now if now.tzinfo else now.astimezone()
        return datetime.fromtimestamp(self._clock.now_ts()).astimezone()

    # ---------------- 单步 ----------------
    def tick(self, now: datetime | None = None) -> list[JobRun]:
        """处理全部 enabled 任务中已到触发条件的，返回本轮新建的 JobRun 列表。"""
        moment = self._now(now)
        fired: list[JobRun] = []
        for job in self._store.list_jobs(self._user_id):
            if not job.enabled:
                continue
            invalid = validate_trigger(job)
            if invalid is not None:
                self._disable_invalid(job, invalid)
                continue
            try:
                fired.extend(self._maybe_fire(job, moment))
            except Exception as exc:  # 单任务异常隔离（记录带节流，见 _record_failure）
                failure = self._record_failure(
                    job, None, 1, f"scheduler: {exc}", moment)
                if failure is not None:
                    fired.append(failure)
        return fired

    def _disable_invalid(self, job: Job, reason: str) -> None:
        """非法规格：禁用 job 并只通知一次（禁用后 tick 跳过，不再重复通知/记账）。"""
        job.enabled = False
        self._store.update_job(job)
        self._notify(job, "定时任务已自动停用",
                     f"任务《{job.name}》的触发设置不合法（{reason}），"
                     "已自动停用；改好设置后重新启用即可。")

    def _maybe_fire(self, job: Job, now: datetime) -> list[JobRun]:
        if job.trigger_type == "time":
            due = parse_iso(job.next_fire_at)
            if due is None:
                job.next_fire_at = next_fire(job, now)
                self._store.update_job(job)
                return []
            if due <= now:
                job.next_fire_at = next_fire(job, now)
                self._store.update_job(job)
                return [self._execute(job, dict(job.params or {}), None, now)]
            return []
        if job.trigger_type == "event":
            return self._check_event(job, now)
        if job.trigger_type == "condition":
            return self._check_condition(job, now)
        return []

    def _check_event(self, job: Job, now: datetime) -> list[JobRun]:
        keyword = str((job.trigger_spec or {}).get("keyword") or "").lower()
        items = self._store.list_feed_items(self._user_id, limit=200)
        current_ids = {item.id for item in items}
        if job.id not in self._seen_feed:
            self._seen_feed[job.id] = set(current_ids)  # 基线：既有条目不触发
            return []
        seen = self._seen_feed[job.id]
        fired: list[JobRun] = []
        for item in items:
            if item.id in seen:
                continue
            seen.add(item.id)
            haystack = f"{item.title} {item.summary} {item.topic}".lower()
            if not keyword or keyword in haystack:
                params = dict(job.params or {})
                entity = dict(item.entities or {})
                if entity.get("token"):
                    params.setdefault("token", entity["token"])
                fired.append(self._execute(job, params, entity, now))
        return fired

    def _check_condition(self, job: Job, now: datetime) -> list[JobRun]:
        """边沿触发：假→真才执行。首次见到该 job 只记基线不触发
        （进程重启后持续为真的条件不会因此被重复执行）。"""
        current = bool(self._eval_condition(job.trigger_spec or {}))
        if job.id not in self._condition_state:
            self._condition_state[job.id] = current
            return []
        previous = self._condition_state[job.id]
        self._condition_state[job.id] = current
        if not (current and not previous):
            return []
        last = self._last_condition_fire.get(job.id, 0.0)
        if now.timestamp() - last < self._condition_cooldown:
            return []  # 边沿被冷却吞掉（状态已更新，不会补发）
        self._last_condition_fire[job.id] = now.timestamp()
        return [self._execute(job, dict(job.params or {}), None, now)]

    def _eval_condition(self, spec: dict[str, Any]) -> bool:
        """condition 规格：{metric, op, threshold, args?}。

        metric 语法：
        - "ETH" / "ETH.price_usd" → market.quote(symbol=ETH) 取 price_usd；
        - "market.quote|price_usd" → 任意工具取字段，args 从 spec["args"] 读。
        """
        metric = str(spec.get("metric") or "")
        op_text = str(spec.get("op") or ">=")
        threshold = float(spec.get("threshold") or 0)
        if "|" in metric:
            tool, field = metric.split("|", 1)
            args = dict(spec.get("args") or {})
        elif "." in metric:
            symbol, field = metric.split(".", 1)
            tool, args = "market.quote", {"symbol": symbol.upper()}
        else:
            tool, field = "market.quote", "price_usd"
            args = {"symbol": metric.upper()}
        result = self._registry.call(tool, args, mode="simulate")
        value = result.get(field)
        if not isinstance(value, (int, float)):
            return False
        return bool(_OPS.get(op_text, operator.ge)(float(value), threshold))

    # ---------------- 执行与重试 ----------------
    def _execute(
        self, job: Job, params: dict[str, Any], entity: dict[str, Any] | None,
        now: datetime | None = None,
    ) -> JobRun:
        """执行并落 JobRun；时间戳统一用 tick 传入的 now（与注入时钟一致，
        不再在执行内部另取真实钟——fake clock 下 started/finished 也可断言）。"""
        stamp = fmt_iso(self._now(now))
        script = self._store.get_script(job.script_id)
        version = job.script_version or (script.current_version if script else None)
        attempt = 0
        last_error = ""
        result: dict[str, Any] = {}
        while attempt < self._max_attempts:
            attempt += 1
            job_run = JobRun(job_id=job.id, script_version=version,
                             status="running", attempt=attempt,
                             started_at=stamp)
            self._store.add_job_run(job_run)
            try:
                result = self._runner(job, params, entity) or {}
                status = str(result.get("status") or "done")
            except Exception as exc:
                status, last_error = "failed", str(exc)
                result = {}
            if status == "awaiting_approval":
                job_run.status = "awaiting_approval"
                job_run.run_id = result.get("run_id")
                job_run.finished_at = stamp
                self._store.add_job_run(job_run)
                self._notify(
                    job, "定时任务等你确认",
                    f"任务《{job.name}》已执行到敏感步骤，停在「待我确认」里等你拍板。")
                return job_run
            if status != "failed":
                job_run.status = "done"
                job_run.run_id = result.get("run_id")
                job_run.finished_at = stamp
                self._store.add_job_run(job_run)
                return job_run
            job_run.status = "failed"
            job_run.run_id = result.get("run_id")
            job_run.error = last_error or str(result.get("error") or "执行失败")
            job_run.finished_at = stamp
            self._store.add_job_run(job_run)
            if attempt < self._max_attempts and self._retry_backoff > 0:
                self._sleeper(self._retry_backoff * (2 ** (attempt - 1)))
            last = job_run
        self._notify(job, "定时任务执行失败",
                     f"任务《{job.name}》重试 {self._max_attempts} 次仍失败：{last_error}")
        return last

    def _record_failure(
        self, job: Job, run_id: str | None, attempt: int, error: str,
        now: datetime | None = None,
    ) -> JobRun | None:
        """落一条 failure JobRun；同 job 同错误在节流窗口内重复发生只记
        第一条（返回 None 表示本条被节流）——防配错的 job 以 tick 频率灌库。"""
        moment = self._now(now)
        key = (job.id, error)
        last = self._failure_last.get(key)
        if last is not None and moment.timestamp() - last < self._FAILURE_THROTTLE_SECONDS:
            return None
        self._failure_last[key] = moment.timestamp()
        job_run = JobRun(job_id=job.id, run_id=run_id, status="failed",
                         attempt=attempt, error=error,
                         finished_at=fmt_iso(moment))
        self._store.add_job_run(job_run)
        return job_run

    def _notify(self, job: Job, title: str, body: str) -> None:
        self._store.add_notification(Notification(
            user_id=job.user_id, title=title, body=body, kind="job"))

    # ---------------- pause / resume ----------------
    def set_enabled(self, job: Job, enabled: bool, now: datetime | None = None) -> Job:
        if enabled:
            invalid = validate_trigger(job)
            if invalid is not None:
                self._disable_invalid(job, invalid)
                return job
        job.enabled = enabled
        if enabled and job.trigger_type == "time":
            due = parse_iso(job.next_fire_at)
            moment = self._now(now)
            if due is None or due <= moment:
                job.next_fire_at = next_fire(job, moment)
        self._store.update_job(job)
        return job
