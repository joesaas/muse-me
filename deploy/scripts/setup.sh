#!/usr/bin/env bash
# MuseMe 首次部署：装服务 + 接 nginx，一次跑通。
#
# 用法（在服务器上，仓库根目录）：
#   bash deploy/scripts/setup.sh [--form a|b] [--domain example.com] [--password <口令>]
#
# 说明：
#   --form    a = Python 单机全栈（默认，8765）；b = server 控制面（8787，需 Node ≥ 22）
#   --domain  可选；只写进提示，不改 nginx 配置（nginx 文件里 server_name 默认为 _，IP 也能访问）
#   --password 不给则交互式密文输入；口令只写进 ~/.config/museme/museme.env（600），不进仓库
#   脚本用 bash 显式调用，不依赖文件可执行位（git 推送不保留可执行位）
set -euo pipefail

FORM="a"
DOMAIN=""
PASSWORD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --form) FORM="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    *) echo "未知参数：$1（可用：--form a|b、--domain、--password）" >&2; exit 1 ;;
  esac
done
[ "$FORM" = "a" ] || [ "$FORM" = "b" ] || { echo "FORM 只能是 a 或 b" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.config/museme/museme.env"
UNIT_DIR="$HOME/.config/systemd/user"

if [ "$FORM" = "a" ]; then
  PORT=8765
  PASS_VAR="MUSE_ME_PASSWORD"
else
  PORT=8787
  PASS_VAR="SERVER_PASSWORD"
fi

echo "== Step 1/5：检查环境 =="
if [ "$FORM" = "a" ]; then
  command -v python3 >/dev/null || { echo "未找到 python3" >&2; exit 1; }
  PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' \
    || { echo "Python $PY_VER 低于 3.11，请先装 Python 3.11+ 再跑本脚本" >&2; exit 1; }
  echo "Python $PY_VER OK"
  if [ ! -f "$REPO_DIR/web/index.html" ]; then
    echo "web/index.html 不存在，需要先构建前端："
    echo "  cd $REPO_DIR/frontend && npm install && npm run build"
    exit 1
  fi
else
  command -v node >/dev/null || { echo "形态 B 需要 Node，请先装 Node ≥ 22" >&2; exit 1; }
  NODE_MAJOR="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$NODE_MAJOR" -ge 22 ] || { echo "Node $(node -v) 低于 22，请先升级" >&2; exit 1; }
  echo "Node $(node -v) OK"
fi
command -v nginx >/dev/null || { echo "未找到 nginx，请先安装（如 sudo apt install nginx）" >&2; exit 1; }

echo "== Step 2/5：准备运行文件 =="
if [ "$FORM" = "b" ]; then
  cd "$REPO_DIR/server" && npm install && npm run build && cd "$REPO_DIR"
fi
mkdir -p "$REPO_DIR/data" "$REPO_DIR/server/data" "$(dirname "$ENV_FILE")" "$UNIT_DIR"

if [ -z "$PASSWORD" ]; then
  if [ -f "$ENV_FILE" ] && grep -q "^$PASS_VAR=" "$ENV_FILE"; then
    echo "沿用 $ENV_FILE 里已有的口令（想换口令用 --password 重新跑）"
  else
    printf "请输入登录口令（不能是默认 demo，输入不回显）："
    read -rs PASSWORD; echo
    [ -n "$PASSWORD" ] && [ "$PASSWORD" != "demo" ] \
      || { echo "口令不能为空且不能是 demo" >&2; exit 1; }
    printf '%s=%s\n' "$PASS_VAR" "$PASSWORD" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
else
  [ "$PASSWORD" != "demo" ] || { echo "口令不能是 demo" >&2; exit 1; }
  printf '%s=%s\n' "$PASS_VAR" "$PASSWORD" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

echo "== Step 3/5：安装 systemd 用户服务 =="
# 单元模板里的 %h/muse-me 按实际仓库路径替换（仓库不在 ~ 时也能用）
sed "s|%h/muse-me|$REPO_DIR|g" "$REPO_DIR/deploy/systemd/museme-$FORM.service" \
  > "$UNIT_DIR/museme.service"
systemctl --user daemon-reload
systemctl --user enable --now museme
loginctl enable-linger "$USER" 2>/dev/null || echo "注意：loginctl enable-linger 未成功，退出登录后服务可能停，请手动跑一次"

echo "== Step 4/5：接 nginx =="
sudo cp "$REPO_DIR/deploy/nginx/museme-$FORM.conf" /etc/nginx/sites-available/museme
sudo ln -sf /etc/nginx/sites-available/museme /etc/nginx/sites-enabled/museme
# 同一时刻只启用一个形态：若另一形态的旧链接存在会冲突，上面 ln -sf 已覆盖为当前形态
sudo nginx -t
sudo systemctl reload nginx

echo "== Step 5/5：验证 =="
sleep 2
if [ "$FORM" = "a" ]; then
  curl -fsS "http://127.0.0.1:$PORT/" >/dev/null && echo "应用首页 OK（经本机 $PORT）"
else
  curl -fsS "http://127.0.0.1:$PORT/api/agent/health" && echo && echo "控制面健康检查 OK"
fi
curl -fsS "http://127.0.0.1/" >/dev/null && echo "经 nginx（80 端口）访问 OK"

echo
echo "完成。接下来两件事在你那边做："
echo "  1. 安全组只放行 80（与 443），不要放行 $PORT；"
echo "  2. 浏览器打开 http://<服务器公网 IP>/（有域名则把 nginx 的 server_name 改成域名后 reload），用 $ENV_FILE 里的口令登录。"
if [ -n "$DOMAIN" ]; then
  echo "  有域名 $DOMAIN 后：sudo certbot --nginx -d $DOMAIN，再 sudo nginx -t && sudo systemctl reload nginx。"
fi
echo "  日常运维：bash deploy/scripts/status.sh（状态）、bash deploy/scripts/update.sh（更新）、bash deploy/scripts/backup.sh（备份）。"
