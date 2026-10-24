#!/usr/bin/env bash
# 打包 MuseMe Agent 本体为 AgentCore「直接代码部署」zip（形态 C，见 DEPLOYMENT.md Step 5）。
#
# 产物：dist/muse-me-agentcore.zip，布局：
#   agentcore_app.py        部署入口（本脚本生成的薄垫片：导入 muse_me.agentcore_app 并 app.run()）
#   muse_me/                Agent 本体源码（自 src/muse_me 拷贝，不含 __pycache__）
#   harness/                驾驭层文件（policy/catalog 等正本，入口按 zip 布局定位）
#   <依赖包目录...>          bedrock-agentcore 及其依赖（pip -t 装到根目录）
#   requirements-agentcore.txt
# 部署时在 AgentCore 侧选：运行时 PYTHON_3_12、架构 linux/arm64、入口 agentcore_app.py。
#
# 关于 arm64 依赖（如实说明）：
#   AgentCore microVM 是 linux/arm64。纯 Python 依赖（botocore/starlette/uvicorn 等）
#   与平台无关；带二进制扩展的依赖（如 pydantic-core、websockets）必须用 arm64 wheel。
#   本脚本默认以 --platform manylinux2014_aarch64 --only-binary 下载 arm64 wheel，
#   在 x86 本机也能完成（pip 只是下载、不执行目标代码）。若某个包没有 arm64 wheel
#   导致下载失败，脚本会明确报错并提示：改在 arm64 机器/容器内打包，或改用容器镜像
#   部署（Dockerfile 内 pip install）。可用环境变量：
#     AGENTCORE_PACKAGE_PLATFORM=host  改按本机平台装依赖（仅供本地解压检查，勿部署）
#     AGENTCORE_PACKAGE_SKIP_DEPS=1    跳过依赖安装（只打源码，部署前需另行补齐依赖）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/dist"
BUILD="$DIST/agentcore-build"
ZIP="$DIST/muse-me-agentcore.zip"
PY_BIN="${PYTHON:-python3}"
PLATFORM="${AGENTCORE_PACKAGE_PLATFORM:-arm64}"

rm -rf "$BUILD"
mkdir -p "$BUILD"

echo "== 1/4 拷贝源码（muse_me + harness）"
cp -r "$REPO_ROOT/src/muse_me" "$BUILD/muse_me"
cp -r "$REPO_ROOT/harness" "$BUILD/harness"
cp "$REPO_ROOT/requirements-agentcore.txt" "$BUILD/"
find "$BUILD" -type d -name __pycache__ -prune -exec rm -rf {} +

echo "== 2/4 生成部署入口 agentcore_app.py（薄垫片）"
cat > "$BUILD/agentcore_app.py" <<'EOF'
"""AgentCore 直接代码部署入口（scripts/package_agentcore.sh 生成，勿手改）。

真正的入口实现在 muse_me/agentcore_app.py（SDK 入口 + 组件组装）；
本文件只负责让部署包根目录成为平台入口：被以 __main__ 执行时启动 8080
契约服务（GET /ping + POST /invocations）。
"""
from muse_me.agentcore_app import app, invoke_agent  # noqa: F401

if __name__ == "__main__":
    app.run()
EOF

echo "== 3/4 安装依赖到包根目录（platform=$PLATFORM）"
if [ "${AGENTCORE_PACKAGE_SKIP_DEPS:-0}" = "1" ]; then
    echo "  !! AGENTCORE_PACKAGE_SKIP_DEPS=1：跳过依赖安装。本 zip 不能直接部署，"
    echo "     部署前须在包根目录补装：pip install -r requirements-agentcore.txt -t ."
elif [ "$PLATFORM" = "arm64" ]; then
    if ! "$PY_BIN" -m pip install -r "$REPO_ROOT/requirements-agentcore.txt" \
            -t "$BUILD" --platform manylinux2014_aarch64 \
            --python-version 3.12 --implementation cp --abi cp312 \
            --only-binary=:all:; then
        echo "  !! arm64 wheel 下载失败（可能有包未发布 arm64 wheel）。处理方式：" >&2
        echo "     ① 在 arm64 机器/容器内重跑本脚本；或 ② 改用容器镜像部署；" >&2
        echo "     ③ 仅本地检查可用 AGENTCORE_PACKAGE_PLATFORM=host 重跑（产物不可部署）。" >&2
        exit 1
    fi
else
    echo "  !! platform=host：按本机平台装依赖，产物仅供本地解压检查，勿部署到 arm64。"
    "$PY_BIN" -m pip install -r "$REPO_ROOT/requirements-agentcore.txt" -t "$BUILD"
fi

echo "== 4/4 打 zip 并列清单"
rm -rf "$BUILD/bin"
find "$BUILD" -type d -name __pycache__ -prune -exec rm -rf {} +
rm -f "$ZIP"
(cd "$BUILD" && "$PY_BIN" -m zipfile -c "$ZIP" .)
echo "产物：$ZIP"
"$PY_BIN" - <<PYEOF
import os, zipfile
z = zipfile.ZipFile("$ZIP")
names = z.namelist()
size = os.path.getsize("$ZIP")
print("文件数：%d，压缩后字节：%d" % (len(names), size))
top = sorted({n.split('/')[0] for n in names})
print("顶层条目：", ", ".join(top))
for probe in ("agentcore_app.py", "muse_me/agentcore_app.py",
              "harness/guardrails/policy.md", "harness/tools/catalog.md",
              "bedrock_agentcore/__init__.py"):
    print(("  OK  " if probe in names else "  缺失 ") + probe)
PYEOF
