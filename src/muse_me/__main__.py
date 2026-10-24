"""python -m muse_me：起服务（默认 127.0.0.1:8765）。

环境变量：MUSE_ME_HOST / MUSE_ME_PORT / MUSE_ME_PASSWORD（默认 demo）/
MUSE_ME_DB / MUSE_ME_MODEL（mock|openrouter）。
"""
from __future__ import annotations

import os

from .bootstrap import create_app


def main() -> None:
    host = os.environ.get("MUSE_ME_HOST", "127.0.0.1")
    port = int(os.environ.get("MUSE_ME_PORT", "8765"))
    app = create_app({})
    app.start(host, port)
    print(f"muse-me 已启动：http://{host}:{app.port}/")
    print(f"登录口令：{app.password}（可用环境变量 MUSE_ME_PASSWORD 修改）")
    print("按 Ctrl+C 停止。")
    try:
        assert app._thread is not None
        app._thread.join()
    except KeyboardInterrupt:
        app.stop()


if __name__ == "__main__":
    main()
