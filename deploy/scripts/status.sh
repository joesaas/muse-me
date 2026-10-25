#!/usr/bin/env bash
# MuseMe 状态速查：服务、nginx 配置、端口、应用探活。
# 用法（仓库根目录）：bash deploy/scripts/status.sh
set -u

echo "--- 服务 ---"
systemctl --user is-active museme 2>&1 || true
systemctl --user status museme --no-pager -l 2>&1 | head -12 || true

echo "--- nginx 配置 ---"
sudo nginx -t 2>&1 || true

echo "--- 监听端口（应只有 80/443 对外，应用端口只在 127.0.0.1）---"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(80|443|8765|8787)\b' || echo "（未看到相关端口，可能服务未起）"

echo "--- 应用探活（经 nginx）---"
curl -fsS -o /dev/null -w "首页经 nginx：%{http_code}\n" http://127.0.0.1/ || echo "首页经 nginx：不通"
curl -fsS http://127.0.0.1:8787/api/agent/health 2>/dev/null | head -c 200 && echo "（形态 B 健康检查）" || true
