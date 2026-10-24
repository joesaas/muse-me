"""AgentCore Agent 侧入口契约测试（src/muse_me/agentcore_app.py）。

契约正本：server/src/infrastructure/runtime/agentcore-runtime.ts——
控制面以 {prompt, scene, chatId, source, resume} 调 InvokeAgentRuntime，
响应按 SSE 帧 `data: {"type","payload"}` 解析。本测试起真实子进程监听
8080，用与控制面完全同形的 payload 验证三段：
1. 新调用：旗舰句 → plan_created … approval_required（停在审批）；
2. 同 session resume（approvedStep=挂起步）→ 续跑到 run_done，含成交步；
3. 无挂起态的 session resume → run_failed 且 error 如实说明挂起态不存在。

环境要求：官方 SDK bedrock-agentcore 已安装（pip install
-r requirements-agentcore.txt）。未装时整类 skip 并说明——主测试套件
（python3 -m unittest discover -s tests）在无 SDK 环境下不受影响。
本文件为 unittest.TestCase 风格，pytest 与 unittest discover 均可收集。
"""
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"
sys.path.insert(0, str(SRC))

try:
    import bedrock_agentcore  # noqa: F401

    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

BASE = "http://127.0.0.1:8080"
SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
FLAGSHIP = "买这个 meme，100 美元，先查流动性"
MISSING_TEXT = "挂起态不存在（会话已回收或进程重启），请重新发起"


def _session_id() -> str:
    # 与控制面同口径：museme-<uuid>，≥33 字符，同一聊天会话恒定
    return f"museme-{uuid.uuid4()}"


def _post_invocations(session_id: str, payload: dict) -> list[dict]:
    req = urllib.request.Request(
        f"{BASE}/invocations",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            SESSION_HEADER: session_id,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    frames = []
    for chunk in raw.split("\n\n"):
        data_lines = [ln[5:].strip() for ln in chunk.split("\n")
                      if ln.strip().startswith("data:")]
        if data_lines:
            frames.append(json.loads("".join(data_lines)))
    return frames


class TestImportErrorIsClear(unittest.TestCase):
    """未装 SDK 时 import agentcore_app 应给出带安装指引的清晰报错。

    手法：临时目录放一个 import 即抛错的 bedrock_agentcore 替身包，
    置于 PYTHONPATH 最前，遮蔽真实 SDK（无论当前环境是否装了 SDK 都可测）。
    """

    def test_missing_sdk_error_mentions_install(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            stub = Path(td) / "bedrock_agentcore"
            stub.mkdir()
            (stub / "__init__.py").write_text(
                "raise ImportError('stubbed: no sdk')\n", encoding="utf-8")
            (stub / "runtime.py").write_text(
                "raise ImportError('stubbed: no sdk')\n", encoding="utf-8")
            env = dict(os.environ)
            env["PYTHONPATH"] = os.pathsep.join([td, str(SRC)])
            proc = subprocess.run(
                [sys.executable, "-c", "import muse_me.agentcore_app"],
                capture_output=True, text=True, env=env, timeout=60)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("bedrock-agentcore", proc.stderr)
            self.assertIn("requirements-agentcore.txt", proc.stderr)


@unittest.skipUnless(
    SDK_AVAILABLE,
    "未安装 bedrock-agentcore，跳过 AgentCore 契约测试；"
    "安装：pip install -r requirements-agentcore.txt",
)
class TestAgentCoreContract(unittest.TestCase):
    proc: subprocess.Popen | None = None

    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env["PYTHONPATH"] = str(SRC)
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "muse_me.agentcore_app"],
            cwd=str(REPO_ROOT), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 60
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                out = cls.proc.stdout.read() if cls.proc.stdout else ""
                raise RuntimeError(f"agentcore_app 进程提前退出：\n{out}")
            try:
                with urllib.request.urlopen(f"{BASE}/ping", timeout=2) as resp:
                    if resp.status == 200:
                        return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("agentcore_app 60 秒内未在 8080 就绪")

    @classmethod
    def tearDownClass(cls):
        if cls.proc is not None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls.proc.kill()

    def test_ping_healthy(self):
        with urllib.request.urlopen(f"{BASE}/ping", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            body = json.loads(resp.read().decode("utf-8"))
        self.assertIn("Healthy", str(body.get("status", "")))

    def test_invoke_suspends_then_resume_completes(self):
        session = _session_id()
        frames = _post_invocations(session, {
            "prompt": FLAGSHIP, "scene": "chat", "chatId": None,
            "source": "chat", "resume": None,
        })
        types = [f["type"] for f in frames]
        self.assertEqual(types[0], "plan_created")
        self.assertIn("approval_required", types)
        self.assertNotIn("run_done", types)
        # 事件形状与本地运行时同形：审批帧 payload 带 step/label/tool
        approval = frames[types.index("approval_required")]
        self.assertEqual(approval["payload"]["tool"], "dex.sim_swap")
        step_path = str(approval["payload"]["step"])
        approved_step = int(step_path.split(".", 1)[0])
        # 成交步在挂起前只应被「调用计划」提及、未执行：无 sim_swap 的 step_done
        done_tools = [f["payload"].get("tool") for f in frames
                      if f["type"] == "step_done"]
        self.assertNotIn("dex.sim_swap", done_tools)

        frames2 = _post_invocations(session, {
            "prompt": "", "scene": "chat", "chatId": None, "source": "chat",
            "resume": {"runId": "any-control-plane-run-id",
                       "approvedStep": approved_step},
        })
        types2 = [f["type"] for f in frames2]
        self.assertIn("run_done", types2)
        self.assertNotIn("run_failed", types2)
        done_tools2 = [f["payload"].get("tool") for f in frames2
                       if f["type"] == "step_done"]
        self.assertIn("dex.sim_swap", done_tools2)  # 成交步已执行

    def test_resume_without_suspended_state_fails_honestly(self):
        frames = _post_invocations(_session_id(), {
            "prompt": "", "scene": "chat", "chatId": None, "source": "chat",
            "resume": {"runId": "nope", "approvedStep": 2},
        })
        self.assertEqual([f["type"] for f in frames], ["run_failed"])
        self.assertEqual(frames[0]["payload"]["error"], MISSING_TEXT)


if __name__ == "__main__":
    unittest.main()
