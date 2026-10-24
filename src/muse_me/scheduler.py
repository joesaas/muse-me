"""调度引擎（定时任务 Bot）：独立守护线程 + 可手动 tick（测试用 fake clock）。

三类触发（架构 §6）：
- time：every_minutes 间隔 / cron_daily "HH:MM" 每天定点。Job.next_fire_at 为正本，
  到点即触发，触发后按规格滚动计算下一次。
- event：Feed 出现匹配关键词的新条目。守护进程以「首次 tick 见到的条目为基线」，
  之后新增且命中的条目各触发一次，参数带入条目实体（token 等）。
- condition：轮询原子工具返回值与阈值比较（metric 语法见 _eval_condition），
  命中即触发；同一任务有冷却（默认 60 秒）防连发。

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


def next_fire(job: Job, now: datetime) -> str:
    """按 trigger_spec 计算严格晚于 now 的下一次触发时刻（ISO 字符串）。

    event / condition 触发没有时间表，返回原 next_fire_at 不变。
    """
    spec = job.trigger_spec or {}
    if job.trigger_type == "time":
        daily = spec.get("cron_daily")
        if daily:
            hh, mm = (int(x) for x in str(daily).split(":"))
            candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if candidate <= now:
                candidate += timedelta(days=1)
            return fmt_iso(candidate)
        minutes = int(spec.get("every_minutes") or 60)
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
            except Exception:
                pass  # 守护线程不因单轮异常退出；单任务失败在 tick 内各自收口
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
            try:
                fired.extend(self._maybe_fire(job, moment))
            except Exception as exc:  # 单任务异常隔离
                fired.append(self._record_failure(job, None, 1, f"scheduler: {exc}"))
        return fired

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
                return [self._execute(job, dict(job.params or {}), None)]
            return []
        if job.trigger_type == "event":
            return self._check_event(job)
        if job.trigger_type == "condition":
            return self._check_condition(job, now)
        return []

    def _check_event(self, job: Job) -> list[JobRun]:
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
                fired.append(self._execute(job, params, entity))
        return fired

    def _check_condition(self, job: Job, now: datetime) -> list[JobRun]:
        last = self._last_condition_fire.get(job.id, 0.0)
        if now.timestamp() - last < self._condition_cooldown:
            return []
        if self._eval_condition(job.trigger_spec or {}):
            self._last_condition_fire[job.id] = now.timestamp()
            return [self._execute(job, dict(job.params or {}), None)]
        return []

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
        self, job: Job, params: dict[str, Any], entity: dict[str, Any] | None
    ) -> JobRun:
        script = self._store.get_script(job.script_id)
        version = job.script_version or (script.current_version if script else None)
        attempt = 0
        last_error = ""
        result: dict[str, Any] = {}
        while attempt < self._max_attempts:
            attempt += 1
            job_run = JobRun(job_id=job.id, script_version=version,
                             status="running", attempt=attempt,
                             started_at=fmt_iso(self._now(None)))
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
                job_run.finished_at = fmt_iso(self._now(None))
                self._store.add_job_run(job_run)
                self._notify(
                    job, "定时任务等你确认",
                    f"任务《{job.name}》已执行到敏感步骤，停在「待我确认」里等你拍板。")
                return job_run
            if status != "failed":
                job_run.status = "done"
                job_run.run_id = result.get("run_id")
                job_run.finished_at = fmt_iso(self._now(None))
                self._store.add_job_run(job_run)
                return job_run
            job_run.status = "failed"
            job_run.run_id = result.get("run_id")
            job_run.error = last_error or str(result.get("error") or "执行失败")
            job_run.finished_at = fmt_iso(self._now(None))
            self._store.add_job_run(job_run)
            if attempt < self._max_attempts and self._retry_backoff > 0:
                self._sleeper(self._retry_backoff * (2 ** (attempt - 1)))
            last = job_run
        self._notify(job, "定时任务执行失败",
                     f"任务《{job.name}》重试 {self._max_attempts} 次仍失败：{last_error}")
        return last

    def _record_failure(
        self, job: Job, run_id: str | None, attempt: int, error: str
    ) -> JobRun:
        job_run = JobRun(job_id=job.id, run_id=run_id, status="failed",
                         attempt=attempt, error=error,
                         finished_at=fmt_iso(self._now(None)))
        self._store.add_job_run(job_run)
        return job_run

    def _notify(self, job: Job, title: str, body: str) -> None:
        self._store.add_notification(Notification(
            user_id=job.user_id, title=title, body=body, kind="job"))

    # ---------------- pause / resume ----------------
    def set_enabled(self, job: Job, enabled: bool, now: datetime | None = None) -> Job:
        job.enabled = enabled
        if enabled and job.trigger_type == "time":
            due = parse_iso(job.next_fire_at)
            moment = self._now(now)
            if due is None or due <= moment:
                job.next_fire_at = next_fire(job, moment)
        self._store.update_job(job)
        return job
