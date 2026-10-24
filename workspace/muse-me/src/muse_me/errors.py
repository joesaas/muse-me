"""异常收敛：全部业务异常继承 DemoError，API 层只认这一族。"""
from __future__ import annotations


class DemoError(Exception):
    """业务异常基类。"""

    code = "demo_error"


class NotFound(DemoError):
    code = "not_found"


class PermissionDenied(DemoError):
    code = "permission_denied"


class GuardrailDenied(DemoError):
    """护栏拒绝（fail-closed 的默认出口）。"""

    code = "guardrail_denied"


class RuntimeNotConfigured(DemoError):
    code = "runtime_not_configured"


class InvalidTransition(DemoError):
    """Run 状态机非法迁移。"""

    code = "invalid_transition"


class ValidationFailed(DemoError):
    code = "validation_failed"


# 别名（Error 后缀风格），同一类不另起炉灶
NotFoundError = NotFound
PermissionDeniedError = PermissionDenied
GuardrailDeniedError = GuardrailDenied
ValidationError = ValidationFailed
