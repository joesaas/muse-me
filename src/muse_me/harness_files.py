"""驾驭层文件读取：harness/ 目录为正本（git 管理的 Markdown）。

- load_guardrails()：解析 guardrails/policy.md 的 ```policy 代码块为 GuardrailPolicy。
  文件缺失、解析失败、缺必需键或风险处置非法时一律 fail-closed：限额归零、
  全部单独审批（approval_default=deny），不再静默回落出厂默认值。
- assemble_context(scene)：按 scenarios/<scene>.md 的组装清单拼上下文
  （原则在最前，其次手册，再次工具目录）。
- harness_version()：聚合 harness/ 全部正本文件（含 playbooks 手册）的内容哈希，
  任一文件变更都会改变版本号，轨迹据此可追溯。
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .domain import GuardrailPolicy
from .errors import DemoError

# 参与版本聚合的子目录（手册 playbooks 必须在内——ShadowClaw 已修缺口）
_VERSION_DIRS = ("principles", "playbooks", "guardrails", "scenarios", "tools", "memory")


def default_harness_root() -> Path:
    """仓库根/harness：本文件位于 src/muse_me/ 下，向上三级即仓库根。"""
    return Path(__file__).resolve().parents[2] / "harness"


# 护栏文件必需键：缺任一键即视为残缺，整体 fail-closed（不再用
# dataclass 出厂默认值静默补齐）。风险处置只许这四个值。
_REQUIRED_POLICY_KEYS = (
    "max_cost_per_run_usd",
    "max_cost_per_day_usd",
    "max_sim_amount_usd",
    "approval_timeout_minutes",
)
_REQUIRED_RISK_LEVELS = ("read", "write", "irreversible")
_ALLOWED_ACTIONS = ("auto", "batch_approval", "single_approval", "deny")


def _parse_policy_block(text: str) -> GuardrailPolicy:
    match = re.search(r"```policy\s*\n(.*?)```", text, re.DOTALL)
    if not match:
        raise DemoError("policy.md 缺少 ```policy 代码块")
    policy = GuardrailPolicy()
    # 从空风险表起步：缺 risk_levels 段必须被检出，不能靠出厂默认值掩盖。
    policy.risk_levels = {}
    seen: set[str] = set()
    section: str | None = None
    for raw in match.group(1).splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if indent == 0:
            section = key if value == "" else None
            if value == "":
                continue
            seen.add(key)
            if key == "max_cost_per_run_usd":
                policy.max_cost_per_run_usd = float(value)
            elif key == "max_cost_per_day_usd":
                policy.max_cost_per_day_usd = float(value)
            elif key == "max_sim_amount_usd":
                policy.max_sim_amount_usd = float(value)
            elif key == "approval_timeout_minutes":
                policy.approval_timeout_minutes = int(float(value))
            elif key == "approval_default":
                policy.approval_default = value
        elif section == "risk_levels":
            policy.risk_levels[key] = value
    missing = [k for k in _REQUIRED_POLICY_KEYS if k not in seen]
    missing_risks = [r for r in _REQUIRED_RISK_LEVELS
                     if r not in policy.risk_levels]
    if missing or missing_risks:
        raise DemoError(
            f"policy.md 残缺（缺键 {missing}、缺风险级 {missing_risks}），"
            "拒绝以出厂默认值运行")
    bad_actions = [r for r in _REQUIRED_RISK_LEVELS
                   if policy.risk_levels[r] not in _ALLOWED_ACTIONS]
    if bad_actions or policy.approval_default not in _ALLOWED_ACTIONS:
        raise DemoError(
            f"policy.md 风险处置非法（{bad_actions}、"
            f"approval_default={policy.approval_default}），拒绝运行")
    if policy.approval_timeout_minutes <= 0:
        raise DemoError("policy.md 的 approval_timeout_minutes 须为正数")
    return policy


def _fail_closed_policy() -> GuardrailPolicy:
    """护栏不可读时的从严策略：限额归零、全部单独审批（架构 §1.3）。

    注意：fail-closed 仍保留 approval_timeout_minutes=60（文档化默认值），
    避免文件一丢就把全部待审批瞬间过期；过期语义见审批超时接线。
    """
    return GuardrailPolicy(
        max_cost_per_run_usd=0.0,
        max_cost_per_day_usd=0.0,
        max_sim_amount_usd=0.0,
        approval_timeout_minutes=60,
        risk_levels={
            "read": "single_approval",
            "write": "single_approval",
            "irreversible": "single_approval",
        },
        approval_default="deny",
    )


class HarnessFiles:
    """FileHarnessSource：以只读方式访问 harness/ 正本。"""

    def __init__(self, root: str | Path | None = None):
        self.root = Path(root) if root is not None else default_harness_root()

    def _read(self, rel: str) -> str:
        path = self.root / rel
        if not path.is_file():
            raise DemoError(f"harness 文件缺失：{rel}")
        return path.read_text(encoding="utf-8")

    # ---------------- guardrails ----------------
    def load_guardrails(self) -> GuardrailPolicy:
        try:
            text = self._read("guardrails/policy.md")
            return _parse_policy_block(text)
        except (DemoError, ValueError, OSError):
            return _fail_closed_policy()

    # 别名（与细节设计模块表签名一致的另一常见叫法）
    def guardrails(self) -> GuardrailPolicy:
        return self.load_guardrails()

    # ---------------- 场景组装 ----------------
    def _scenario_spec(self, scene: str) -> dict[str, str]:
        text = self._read(f"scenarios/{scene}.md")
        spec: dict[str, str] = {}
        for line in text.splitlines():
            if ":" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition(":")
                spec[key.strip()] = value.strip()
        return spec

    def assemble_context(self, scene: str) -> str:
        """按场景清单组装上下文：场景说明 -> 原则 -> 手册 -> 工具目录。"""
        spec = self._scenario_spec(scene)
        parts: list[str] = [f"# 场景 {scene}"]
        principles = spec.get("principles", "")
        if principles and principles != "-":
            parts.append(self._read(f"principles/{principles}.md"))
        playbooks = spec.get("playbooks", "")
        if playbooks and playbooks != "-":
            for name in [p.strip() for p in playbooks.split(",") if p.strip()]:
                parts.append(self._read(f"playbooks/{name}.md"))
        tools = spec.get("tools", "")
        if tools == "catalog-all":
            parts.append(self._read("tools/catalog.md"))
        elif tools and tools != "-":
            parts.append(f"# 可用工具\n{tools}")
        return "\n\n".join(parts)

    def catalog_text(self) -> str:
        return self._read("tools/catalog.md")

    # ---------------- 版本号 ----------------
    def harness_version(self) -> str:
        digest = hashlib.sha256()
        files: list[Path] = []
        for sub in _VERSION_DIRS:
            base = self.root / sub
            if base.is_dir():
                files.extend(p for p in base.rglob("*") if p.is_file())
        for path in sorted(files, key=lambda p: str(p.relative_to(self.root))):
            rel = str(path.relative_to(self.root))
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
        return "h-" + digest.hexdigest()[:12]


# 模块级便捷函数（默认根目录）
def load_guardrails(root: str | Path | None = None) -> GuardrailPolicy:
    return HarnessFiles(root).load_guardrails()


def assemble_context(scene: str, root: str | Path | None = None) -> str:
    return HarnessFiles(root).assemble_context(scene)


def harness_version(root: str | Path | None = None) -> str:
    return HarnessFiles(root).harness_version()
