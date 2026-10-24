"""python -m muse_me：起服务（默认 127.0.0.1:8765）。

环境变量：MUSE_ME_HOST / MUSE_ME_PORT / MUSE_ME_PASSWORD（默认 demo）/
MUSE_ME_DB / MUSE_ME_MODEL（mock|openrouter）。

口令收口：启动日志永不打印口令明文；host 非本机回环且口令仍为默认
"demo" 时拒绝启动（默认口令只许本地用，架构 §9）。
"""
from __future__ import annotations

import os

from .bootstrap import create_app

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def guard_remote_default_password(host: str, password: str) -> None:
    """非本机绑定 + 默认口令 → 拒绝启动（SystemExit 带明确报错）。"""
    if host not in _LOCAL_HOSTS and password == "demo":
        raise SystemExit(
            f"拒绝启动：监听地址 {host} 不是本机回环，但登录口令仍是默认 "
            "「demo」。请先设置环境变量 MUSE_ME_PASSWORD 为自定义口令，"
            "或改绑 127.0.0.1 仅本地使用。")


def main() -> None:
    host = os.environ.get("MUSE_ME_HOST", "127.0.0.1")
    port = int(os.environ.get("MUSE_ME_PORT", "8765"))
    app = create_app({})
    guard_remote_default_password(host, app.password)
    app.start(host, port)
    print(f"muse-me 已启动：http://{host}:{app.port}/")
    if app.password == "demo":
        print("登录口令：当前为默认口令 demo（仅限本地）；"
              "可用环境变量 MUSE_ME_PASSWORD 修改。")
    else:
        print("登录口令：已由环境变量 MUSE_ME_PASSWORD 设置（不显示）。")
    print("按 Ctrl+C 停止。")
    try:
        assert app._thread is not None
        app._thread.join()
    except KeyboardInterrupt:
        app.stop()


if __name__ == "__main__":
    main()
