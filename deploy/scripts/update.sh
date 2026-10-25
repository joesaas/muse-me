#!/usr/bin/env bash
# MuseMe 更新：停服 → 备份数据 → 拉代码 → （可选重构建）→ 起服 → 验证。
#
# 用法（仓库根目录）：
#   bash deploy/scripts/update.sh [--rebuild]
#   --rebuild  前端或 server 有改动时加：重跑 frontend 与 server 的构建
set -euo pipefail

# 必须以本人账号跑，不要 sudo：systemd 用户服务与口令文件都属于当前用户；
# sudo 会切到 root，既连不上用户总线（Failed to connect to bus），又会把文件写进 /root。
# nginx 那几步脚本内自己会 sudo。
if [ "${EUID}" -eq 0 ]; then
  echo "请不要用 sudo 跑本脚本：直接 bash deploy/scripts/update.sh，不要加 sudo。" >&2
  echo "（如果已经用 sudo 跑过，先清掉 /root/.config/museme 与 /root/.config/systemd/user/museme.service，再以本人账号重跑。）" >&2
  exit 1
fi

REBUILD=0
[ "${1:-}" = "--rebuild" ] && REBUILD=1

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"
STAMP="$(date +%F-%H%M%S)"
BACKUP_DIR="$REPO_DIR/backups/$STAMP"

echo "== 停服并备份 =="
systemctl --user stop museme 2>/dev/null || echo "（museme 服务未在运行，跳过停服）"
mkdir -p "$BACKUP_DIR"
# 先停服再拷，WAL 里的页已落盘，不会漏拷
[ -d "$REPO_DIR/data" ] && cp -r "$REPO_DIR/data" "$BACKUP_DIR/data" || true
[ -d "$REPO_DIR/server/data" ] && cp -r "$REPO_DIR/server/data" "$BACKUP_DIR/server-data" || true
echo "备份在 $BACKUP_DIR"

echo "== 拉代码 =="
git pull

if [ "$REBUILD" = "1" ]; then
  echo "== 重构建 =="
  cd "$REPO_DIR/frontend" && npm install && npm run build && cd "$REPO_DIR"
  cd "$REPO_DIR/server" && npm install && npm run build && cd "$REPO_DIR"
fi

echo "== 起服并验证 =="
systemctl --user start museme
sleep 2
systemctl --user is-active museme
echo "更新完成。如验证清单不过，停服后用 $BACKUP_DIR 覆盖回 data/ 再起服（见 DEPLOYMENT.md Step 4）。"
