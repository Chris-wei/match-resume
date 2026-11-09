# 上线部署清单（云服务器 + 备案域名 + HTTPS）

从「本地开发版」到「正式发布小程序」，服务端要走完：**买服务器 → 域名 + ICP 备案 → HTTPS 证书 → 部署 → nginx 反代 → 小程序后台配置**。本文按依赖顺序给出每一步的可复制操作。

> 另一条路是微信云托管（免域名免备案），但前端要从 `wx.request` 改成 `wx.cloud.callContainer`，会话逻辑要动，不在本文范围。

## 0. 时间线：备案是关键路径，先启动

| 步骤 | 耗时 | 说明 |
|---|---|---|
| 域名注册 + 实名 | 1~2 天 | 国内注册商（腾讯云/阿里云），`.com`/`.cn` 均可 |
| ICP 备案 | **2~4 周** | 在云厂商备案系统提交，服务器和域名要在同一家最省事 |
| 小程序备案 | 数个工作日 | mp.weixin.qq.com → 设置 → 基本设置 → 小程序备案（2023-09 起未备案不能发布） |

ICP 备案期间可以并行做 §3~§6 的所有事。

## 1. 服务器

- 腾讯云/阿里云**轻量应用服务器**即可：2C2G 足够（唯一的重活是 PDF 解析，有独立 worker + 内存上限）
- 地域选离用户近的大陆节点（用备案域名必须大陆）
- **安全组只开 80 / 443 / 22**（22 限自己的源 IP）。Node 服务 `server.listen` 默认绑 `0.0.0.0`，8787 绝不能暴露公网，只允许 nginx 从 127.0.0.1 反代

```bash
# 装 Node 18+（pdfjs-dist 要求；Debian/Ubuntu 示例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v
```

## 2. 拉代码 + 生产环境变量

```bash
sudo useradd -m -s /bin/bash airesume
sudo mkdir -p /opt/ai-resume && sudo chown airesume:airesume /opt/ai-resume
sudo -u airesume git clone <你的仓库地址> /opt/ai-resume   # 或本机 rsync 上去
cd /opt/ai-resume && npm install --omit=dev
```

写 `/opt/ai-resume/.env`（`server/config.js` 启动时自动读取；`chmod 600 .env`）：

```bash
# ---- 模型（上线推荐百炼千问；判定用强模型）----
LLM_API_KEY=你的百炼key
LLM_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-flash
LLM_JUDGE_MODEL=qwen-plus

# ---- 微信（上线必配）：openid 身份 + msgSecCheck 内容安全 ----
WX_APPID=wx301bc1c1859feeab
WX_APPSECRET=小程序后台「开发管理→开发设置」里拿

# ---- nginx 反代后面必须设：信任并只信代理覆盖过的真实 IP 头 ----
TRUST_PROXY=1

# ---- 内测白名单（可选）：逗号分隔的 openid（只支持 openid，设备 ID 不生效）----
# 仅首次启动作种子写入库；之后在后台 /admin「内测白名单」卡片在线增删（即时生效、重启不丢），
# 改这里不再生效。白名单不限身份/IP 限次；全站日限、内容安全、试探限制照常。正式版在后台清空即可
# LIMIT_WHITELIST=

# ---- 每身份每日分析次数（默认 3）----
# 仅首次启动作种子；之后在后台 /admin「运行参数」卡片在线调整（即时生效），改这里不再生效
# ANALYZE_PER_IDENTITY_PER_DAY=3

# ---- 网页后台：公网首版建议不设（/admin* 一律 404，攻击面最小）----
# ADMIN_PASSWORD=想远程看反馈再设，且必须走 HTTPS
# ADMIN_USERNAME=配上则登录需「账号+密码」都匹配（只配密码则不校验账号）

# 数据目录（默认 <仓库>/data，一般不用动）
# DATA_DIR=/opt/ai-resume/data
```

验证：`node server/index.js` 后 `curl -s http://127.0.0.1:8787/api/health`，确认 `model` / `judgeModel` 正确、`moderation` 为 `local+wechat`、不是 mock 模式。启动日志同时会打印这两个模型。

## 3. systemd 常驻

`/etc/systemd/system/ai-resume.service`（`ExecStart` 的 node 路径用 `which node` 的实际结果）：

```ini
[Unit]
Description=ai-resume server
After=network.target

[Service]
Type=simple
User=airesume
WorkingDirectory=/opt/ai-resume
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/ai-resume/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-resume
systemctl status ai-resume        # 看启动日志：确认两个模型名 + moderation 模式
journalctl -u ai-resume -f        # 平时排障
```

> 服务退出时会同步刷盘（data/db.json），`Restart=always` 兜底崩溃重启；重启时会自动退还未完成任务的预占次数，不用人工处理。

## 4. HTTPS 证书（Let's Encrypt 自动续期）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com        # 换成你的备案域名
sudo certbot renew --dry-run                    # 续期由 systemd timer 自动跑
```

微信要求 TLS ≥ 1.2，nginx 配置里显式锁 `TLSv1.2 TLSv1.3`。

## 5. nginx 反向代理

`/etc/nginx/sites-available/ai-resume`：

```nginx
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # PDF 走 base64 直传 JSON：5MB 文件编码后 ~6.7MB，必须放开 body 上限
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;

        # ⚠️ 覆盖式写法，不要用 $proxy_add_x_forwarded_for（那是追加）。
        # 服务端设了 TRUST_PROXY=1 后会信任这两个头，覆盖才能保证客户端伪造的
        # X-Real-IP / X-Forwarded-For 被替换掉，IP 风控才有效
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;

        proxy_read_timeout 90s;   # 覆盖 /api/extract-pdf（解析 15s）+ 余量；主报告是轮询，不受影响
        proxy_send_timeout 30s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ai-resume /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

上线后核对 IP 风控真的生效：换网络（如手机热点）访问，后台/日志里的 IP 哈希应随网络变化。

## 6. 数据备份（data/db.json 是唯一状态）

```bash
mkdir -p ~/backups
crontab -e   # 加一行（crontab 里 % 要转义）：
# 17 4 * * * cd /opt/ai-resume && tar czf $HOME/backups/db-$(date +\%F).tar.gz data/db.json && find $HOME/backups -name 'db-*.tar.gz' -mtime +30 -delete
```

恢复：停服务 → 解包覆盖 `data/db.json` → 起服务。存量数据只有脱敏报告和限流计数（隐私政策 §4），丢了不影响用户输入中的简历。

## 7. 日常更新流程

```bash
cd /opt/ai-resume && sudo -u airesume git pull && sudo -u airesume npm install --omit=dev
sudo systemctl restart ai-resume
curl -s http://127.0.0.1:8787/api/health
```

改了 `server/sensitive-words.txt` / `sensitive-allow.txt` 同样要 `systemctl restart`（词库启动时加载）。

## 8. 小程序后台配套（与服务器并行做）

| 事项 | 位置 | 要点 |
|---|---|---|
| request 合法域名 | 开发管理 → 开发设置 → 服务器域名 | 填 `https://api.example.com`；每月只能改 50 次 |
| 用户隐私保护指引 | 设置 → 服务内容声明 → 用户隐私保护指引 | 必须声明「剪贴板」（`wx.getClipboardData`）和「选中的文件」（`wx.chooseMessageFile`），并写明收集简历/JD 文本、设备标识、留存期限（与小程序内隐私政策页一致）。**不配置这些接口会直接失败** |
| IP 白名单（如果开了） | 开发设置 → IP 白名单 | 加服务器公网 IP，否则 `getStableAccessToken`（msgSecCheck 用）被拒 |
| 基础库最低版本 | 设置 → 基础库最低版本 | 建议 ≥ 2.32.3（隐私能力强制版） |
| 类目 | 设置 → 基本设置 | 「工具 → 效率」；别选人力资源/招聘（要前置审批） |

前端只改一处：`miniprogram/config.js` 的 `API_BASE` 切到 `https://api.example.com`。

## 9. 发布前自查

- [ ] `npm test` 全绿；`npm run eval -- --label 上线基线` 存基线
- [ ] 补充 `server/sensitive-words.txt`（当前是种子词表，README 明确要求上线前按业务补充）
- [ ] 复核 `GLOBAL_DAILY_CAP`（默认 200）等风控参数对真实流量的合理性
- [ ] `LIMIT_WHITELIST` 用完即清（正式版不该有不限次用户）——在后台「内测白名单」卡片清空，`/api/health` 的 `limitWhitelist` 应为 0
- [ ] `ADMIN_PASSWORD` 决策（首版建议不设）
- [ ] 体验版真机回归：隐私弹窗（粘贴/PDF 首次调用）、PDF 上传、复制、反馈、连不上服务的降级提示
- [ ] 上传代码 → 提交审核（版本描述主动写清内容安全机制：敏感词库 + msgSecCheck + 引用逐字校验，用户提交自用简历）
- [ ] 审核通过 → 全量发布
