# deploy/ —— MuseMe 服务器部署文件

目标：应用只监听回环地址（127.0.0.1），nginx 在前面接 80/443，**安全组只需放行 80（与 443），应用端口（8765/8787）不用、也不应对外开**。

## 目录

| 文件 | 用途 |
|---|---|
| `nginx/museme-a.conf` | 形态 A（Python 单机全栈，8765）的 nginx 站点 |
| `nginx/museme-b.conf` | 形态 B（server 控制面，8787）的 nginx 站点 |
| `systemd/museme-a.service` | 形态 A 的 systemd 用户服务模板 |
| `systemd/museme-b.service` | 形态 B 的 systemd 用户服务模板 |
| `scripts/setup.sh` | 首次部署：一键装服务 + 接 nginx + 验证 |
| `scripts/update.sh` | 更新：停服 → 备份 → 拉代码 →（可选重构建）→ 起服 |
| `scripts/backup.sh` | 备份：停服后拷库（WAL 安全）再起服 |
| `scripts/status.sh` | 状态速查：服务、nginx 配置、端口、探活 |

## 首次部署（服务器上，仓库根目录）

```bash
bash deploy/scripts/setup.sh --form a        # 形态 A（默认）；形态 B 用 --form b
bash deploy/scripts/setup.sh --form a --password <口令>   # 不给则交互式密文输入
```

setup.sh 依次做：环境检查（形态 A 要 Python ≥ 3.11 且 `web/index.html` 已存在；形态 B 要 Node ≥ 22 并自动 `npm install + build`）→ 口令写进 `~/.config/museme/museme.env`（600，不进仓库）→ 装 systemd 用户服务并 `enable-linger`（退出登录后继续跑）→ 把对应形态的 nginx 站点链进 `sites-enabled` 并 `nginx -t` 后 reload → 本机探活验证。

做完后你那边只剩两件事：安全组放行 80（与 443），浏览器打开 `http://<服务器公网 IP>/` 用口令登录。

## 日常运维

```bash
bash deploy/scripts/status.sh              # 状态速查
bash deploy/scripts/update.sh              # 更新（前端/server 有改动时加 --rebuild）
bash deploy/scripts/backup.sh              # 备份（备份在 backups/<日期-时间>/）
journalctl --user -u museme -f             # 看日志
```

## 切换形态

```bash
bash deploy/scripts/setup.sh --form b      # 重新跑一次：服务单元与 nginx 站点都会被当前形态覆盖
```

注意：形态 A 与 B 的调度守护不要同时常驻（各扫各库的种子任务会双跑）；切形态前确认另一形态的服务已停（setup.sh 只装当前形态的单元，旧单元同名会被覆盖，不会双跑）。

## HTTPS

有域名后：把 nginx 配置里的 `server_name _` 改成你的域名，跑 `sudo certbot --nginx -d 你的域名`（certbot 自动写 443 段并加 80 跳 443），再 `sudo nginx -t && sudo systemctl reload nginx`。没拿到证书前不要手写 443 段。

## 注意事项

- 脚本一律用 `bash deploy/scripts/xxx.sh` 调用，不要依赖可执行位（git 推送不保留可执行位）。
- 口令不要写进 nginx 配置、systemd 单元或仓库任何文件，只放 `~/.config/museme/museme.env`。
- SSE 事件流（`/api/events`）在 nginx 配置里已关缓冲；如果你自己改 nginx 配置，不要删 `proxy_buffering off`，否则页面会表现为“发了消息但一直没动静”。
- 故障先跑 `bash deploy/scripts/status.sh`，再按 DEPLOYMENT.md Step 7 的表查。

## 故障速查

| 症状 | 先查什么 |
|---|---|
| `nginx -t` 失败 | 站点文件语法或证书路径；`sites-enabled` 里不要同时链两个形态 |
| 打开页面 502 | 应用没起来：`systemctl --user status museme` 与 `journalctl` |
| 登录页打不开但 nginx 正常 | 服务监听地址是不是 127.0.0.1、口令文件是否在位 |
| 发了消息没事件流 | nginx 的 `/api/events` 段是否丢了 `proxy_buffering off` |
| 启动即退出、提示拒绝启动 | 绑了非回环地址但口令是默认 `demo`——改口令（DEPLOYMENT.md Step 3） |
