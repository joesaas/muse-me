#!/usr/bin/env bash
# MuseMe 数据备份：停服 → 拷库 → 起服。
# 先停服再拷：server 的库开了 WAL，热拷主文件会漏 -wal 里未落盘的页。
#
# 用法（仓库根目录）：bash deploy/scripts/backup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
