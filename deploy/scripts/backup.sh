#!/usr/bin/env bash
# MuseMe 数据备份：停服 → 拷库 → 起服。
# 先停服再拷：server 的库开了 WAL，热拷主文件会漏 -wal 里未落盘的页。
#
# 用法（仓库根目录）：bash deploy/scripts/backup.sh
set -euo pipefail

# 必须以本人账号跑，不要 sudo：systemd 用户服务与口令文件都属于当前用户；
# sudo 会切到 root，既连不上用户总线（Failed to connect to bus），又会把文件写进 /root。
# nginx 那几步脚本内自己会 sudo。
if [ "${EUID}" -eq 0 ]; then
  echo "请不要用 sudo 跑本脚本：直接 bash deploy/scripts/backup.sh，不要加 sudo。" >&2
  echo "（如果已经用 sudo 跑过，先清掉 /root/.config/museme 与 /root/.config/systemd/user/museme.service，再以本人账号重跑。）" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"
STAMP="$(date +%F-%H%M%S)"
BACKUP_DIR="$REPO_DIR/backups/$STAMP"

systemctl --user stop museme 2>/dev/null || echo "（museme 服务未在运行，跳过停服）"
mkdir -p "$BACKUP_DIR"
[ -d "$REPO_DIR/data" ] && cp -r "$REPO_DIR/data" "$BACKUP_DIR/data" || true
[ -d "$REPO_DIR/server/data" ] && cp -r "$REPO_DIR/server/data" "$BACKUP_DIR/server-data" || true
systemctl --user start museme 2>/dev/null || echo "（服务未起，请手动检查 systemctl --user status museme）"
echo "备份完成：$BACKUP_DIR"
ls "$BACKUP_DIR"
