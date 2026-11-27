# 安全评估与公网部署指南

本项目是**单用户个人 Agent**：一个人通过网页/手机访问，并且 Agent 模式允许在服务器上执行 Python、读写工作区文件。它不是一个多租户 SaaS。下面按“能否公网部署”给出结论、已加固项和剩余风险。

## 结论

- **仅 Web/手机聊天 + 记忆 + 会话同步**：在启用 HTTPS、强访问密码、`REQUIRE_AUTH=true`、只暴露 80/443 的前提下，可以公网部署。
- **开放 Agent 模式到公网**：Agent 本质上是**远程代码执行**能力。Python 子进程已降权到 UID 10001，读不到 root 0600 的加密密钥与会话密文；但 server 本体仍以 root 运行，能访问数据卷、环境变量和 Docker 内网。只建议自己使用；不要把密码分享给他人，也不要在不可信环境开放。没有独立沙箱前，不建议作为多用户服务公网运行。

## 已实施的加固

### 认证与会话

- 访问密码只保存 scrypt 哈希；登录失败按 IP 限速：10 分钟内 5 次失败后封禁 15 分钟，避免暴力破解和同步 scrypt 造成的 DoS。
- 登录/改密请求体限制 4KB，生产 nginx 对 `/api/auth/login` 另做 20 次/分钟、burst 5 的前置限速；会话同步单会话上限 20MB。
- 新密码至少 10 位；修改密码后会**轮换会话签名密钥**，所有旧 Cookie 和手机 Bearer token 立即失效。
- 会话 token 带随机 nonce 和过期时间，HMAC-SHA256 签名；Cookie 为 `HttpOnly; SameSite=Lax; Path=/`，HTTPS 下自动加 `Secure`。
- 网页登录不再把 token 返回给 JS（仍使用 HttpOnly Cookie）；只有带 `x-myagent-client: mobile` 的手机 App 才拿到 Bearer token。
- 新增 `REQUIRE_AUTH=true`：未设置访问密码时直接拒绝所有业务接口，防止“忘记设密码就公网裸奔”。
- 登录/聊天限速默认不再信任客户端可伪造的 `X-Forwarded-For`；只有 `TRUST_PROXY=true`（服务端仅经会覆写该头的 nginx/Caddy 暴露）时才按真实 IP 限速。
- 登出会把当前 token 的哈希写入 `data/revoked-sessions.json`，被复制的 Cookie/Bearer 在登出后立即失效；签名密钥轮换仍用于“改密后全端下线”。

### 接口与浏览器安全

- CORS 从“反射任意 Origin + 允许携带 Cookie”改为**来源白名单**（默认只允许手机 WebView 的 `https://appassets.androidplatform.net` 与本地预览）；可用 `CORS_ORIGINS` 追加。
- 所有 `/api` 响应加 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- 生产 nginx 增加 CSP、X-Frame-Options、HSTS、Permissions-Policy；反向代理传递 `X-Forwarded-Proto`，保证 HTTPS 下 Cookie 正确标记 Secure。
- 手机端交付文件/工作区文件改为带 `Authorization` 头的 `fetch` 读取，移除 URL 中的长期 `token` 查询参数，避免 token 进入访问日志、Referer 或截图分享。
- Markdown 渲染走 AST 白名单；Mermaid `securityLevel: strict`；KaTeX `trust` 默认关闭；已用 `<script>`、`onerror`、`javascript:` 链接做注入测试，未触发执行。
- 状态变更接口校验 `Origin`（同源需 scheme+host+port 完全一致，或命中 `CORS_ORIGINS`）；nginx 用 `$http_host` 覆写 `X-Forwarded-Host`，客户端伪造的该头不会进入后端判断。
- 统一错误出口：畸形 JSON 返回 400 泛化提示；5xx 只回“服务器内部错误”并记录日志；上游 DeepSeek 的反序列化/递归/请求头错误也会被清洗，不再回显解析器细节或 `request_id`。
- 会话同步新增结构校验：`messages` 必须为数组、时间戳必须为有限数字、嵌套不超过 200 层、单会话最多 2 万条消息，避免 `Infinity → null` 污染 LWW 排序和超深 JSON 栈溢出。
- `/api/chat`、`/api/mobile/messages`、`/api/compress` 共用每客户端 30 次/分钟限速（`CHAT_RATE_LIMIT_PER_MINUTE`）；模型限制为 `ALLOWED_MODELS` 白名单（默认 `deepseek-flash,deepseek-v4-pro`），`apiKey` 只接受 8–512 位可打印 ASCII，防止换行注入。
- 后台记忆写入、SSE 收尾等 fire-and-forget 路径全部加 `.catch`，并增加进程级 `unhandledRejection`/`uncaughtException` 兜底：单个坏请求不再能让 Node 进程退出。

### 静态加密

- 会话正文/摘要、压缩摘要、参考资料、Agent 工作区文件、SQLite FTS 索引、用量样本和会话签名密钥均使用 **AES-256-GCM** 加密落盘；文件带 `MAG1` 魔数，直接读取只能看到密文。
- 每个文件独立随机 IV；AAD 绑定逻辑路径/会话，密文复制到其他文件会触发 GCM 校验失败。
- 主密钥优先取 `DATA_ENCRYPTION_KEY`，否则读取 `myagent_secrets` 卷中的 `DATA_ENCRYPTION_KEY_FILE`（默认 `/app/secrets/encryption.key`，0600，首次启动生成）。密钥与数据分卷。
- 启动时自动迁移历史明文文件；密钥指纹存在 `data/encryption.meta`，用错密钥会拒绝启动，不会把数据静默显示为空。
- FTS 索引不再以明文 SQLite 落盘：查询时解密到内存，修改后重新序列化并加密写回。
- Python 执行时解密到 tmpfs（`/run/myagent-exec`），子进程降权到 UID 10001；模型生成的代码无法读取 root 密钥、会话密文或 Honcho 凭据。
- **边界**：这是服务端静态加密，不是端到端加密。server root/拿到密钥的人仍可解密；Honcho 的 Postgres/Redis 仍是明文；浏览器 IndexedDB、手机 SQLite 是设备本地明文；加密前的 Docker 卷备份/NAS 快照仍可能含明文。

### 依赖

- 升级 Mermaid `11.10.1 → 11.17.2`、KaTeX `0.16.22 → 0.18.2`，并强制 `lodash-es 4.18.1` 覆盖，修复已知 HTML/CSS 注入、原型污染和 DoS 通告。
- `pnpm audit --prod`：web / mobile / server 均为 **0 个已知漏洞**（截至本次检查）。

### Agent 执行

- Python 子进程不再继承服务端环境变量中的 `DEEPSEEK_API_KEY`、`HONCHO_*`、`ACCESS_PASSWORD`，并以 UID 10001 运行；容器 root 的 0600 密钥/密文不可读。
- Python 在 tmpfs 中看到工作区明文副本（执行所必需），执行完立即写回密文；tmpfs 父目录 0711、会话临时目录 0700，进程退出后清理。
- 工作区路径继续做前缀校验；Agent 工具只允许操作会话工作区。
- 会话同步时会剥离 `ssh` 凭据，SSH 密码/私钥不上传服务端、不下发手机。
- SSH 连通性测试默认禁止连接回环、内网、链路本地与云元数据地址（防 SSRF）；需要连局域网机器时显式设 `SSH_ALLOW_PRIVATE_HOSTS=true`。返回给前端的错误只保留“认证失败/超时/不可达”分类，不暴露内网 IP、端口或 errno。
- SSH 测试单独限速 10 次/分钟。

## 本轮渗透测试记录（ARTEX 2.2.0）

2026-11-26 在隔离测试实例（`REQUIRE_AUTH=true`、独立数据卷）上用 ARTEX 做授权自测，未触碰真实会话数据。测试完成后 ARTEX 容器、网络、卷和临时数据已全部删除。发现与处置：

| # | 发现 | 级别 | 处置 |
| --- | --- | --- | --- |
| 1 | `POST /api/chat/complete` 缺少 `assistantContent` 触发未处理 Promise 拒绝，Node 进程退出，所有 `/api` 502 | 高（可用性） | `sanitizeContext` 容错、所有 fire-and-forget 加 `.catch`、进程级兜底；已复测进程存活 |
| 2 | 登录/聊天限速信任可伪造的 `X-Forwarded-For`，可绕过单口令爆破防护 | 中 | 默认按 TCP 对端地址限速；仅 `TRUST_PROXY=true` 时读 XFF；已复测伪造头无效 |
| 3 | `/api/agent/ssh/test` 可连接任意内网/元数据地址并回显 errno（SSRF/端口探测） | 中 | 默认阻断内网/回环/链路本地/元数据，DNS 解析后固定 IP 防重绑定；错误泛化；已复测被拦截 |
| 4 | 服务端 DeepSeek 密钥可被任意登录用户无配额使用，且可自选模型 | 中 | 每客户端 30 次/分钟限速 + 模型白名单 + apiKey 格式校验；残余风险见下表 |
| 5 | 状态变更接口无 Origin/CSRF 校验，仅依赖 SameSite=Lax | 低 | 增加 Origin 同源校验；已复测跨站 403、同源 200 |
| 6 | Origin 校验曾因 nginx `$host` 丢端口而误拒真实源；无 XFH 时忽略端口；XFH 可被客户端伪造 | 中 | nginx 覆写 `X-Forwarded-Host: $http_host`，后端按 scheme+host+port 精确比对；已复测 `:18081`、`https://`、伪造 XFH 均 403 |
| 7 | 登出只清 Cookie，被复制的签名 token 仍可用；HTTP 下 Cookie 无 Secure | 低 | 登出持久化撤销 token；HTTPS 下仍自动加 Secure（HTTP 局域网无法加，见部署说明） |
| 8 | `/api/agent/ssh/test` 把底层 Node 错误原样回显 | 低 | 改为“认证失败/超时/不可达”三类提示 |
| 9 | 会话同步接受 `updatedAt: Infinity`（序列化为 null），超深 JSON 500 | 低 | 时间戳必须有限、嵌套 ≤200 层、消息 ≤2 万条，非法返回 400 |
| 10 | 畸形 JSON 返回 500 并回显解析器位置 | 低 | 统一 400“请求体不是合法 JSON”，5xx 只回通用文案 |
| 11 | `/api/chat` 透传上游 serde/递归/`request_id` 错误细节 | 低 | 上游错误清洗；`messages` 深度预检 |
| 12 | `apiKey` 含换行时回显 Node `Headers.append` 运行时错误 | 低 | apiKey 格式白名单，非法直接 400 |
| 13 | 移动端 `/api/mobile/messages` 是第二个服务端密钥入口且可指定模型 | 中 | 与 Web 共用限速、模型白名单、apiKey 校验 |

未发现：未授权访问（除公开 `/api/health`、`/api/auth/status`、`/api/auth/login`）、会话 ID/工作区路径穿越、CORS 任意源放行、SQL/命令注入、前端可利用 XSS。依赖审计仍为 0 个已知漏洞。

## 公网部署清单

1. **先设密码再暴露端口**。在根目录 `.env`：
   ```dotenv
   ACCESS_PASSWORD=至少16位的随机强密码
   REQUIRE_AUTH=true
   PUBLIC_DOMAIN=agent.example.com
   ACME_EMAIL=you@example.com
   PROD_BIND=127.0.0.1
   TRUST_PROXY=true
   SSH_ALLOW_PRIVATE_HOSTS=false
   CHAT_RATE_LIMIT_PER_MINUTE=30
   ALLOWED_MODELS=deepseek-flash,deepseek-v4-pro
   ```
   如果 `data/auth.json` 已存在，启动不会覆盖；请先在网页端改密，或删除该文件让 `ACCESS_PASSWORD` 初始化。
2. **只开 80/443**。不要映射 8090（rspack dev server，无生产安全头）、3000（后端调试端口）到公网。
3. 启动生产 + HTTPS 入口：
   ```bash
   docker compose --profile prod --profile public up -d --build
   ```
   Caddy 自动申请/续期证书，HTTP 自动跳 HTTPS。
4. **手机端服务器地址改成 HTTPS 域名**（例如 `https://agent.example.com`）。不要用公网 HTTP，否则密码、Bearer token 和聊天内容会明文传输。
5. 云防火墙只放行 80/443；如需 SSH 管理，限制来源 IP。
6. `.env` 含 DeepSeek Key 与访问密码，权限设为 `chmod 600 .env`，不要提交到公开仓库。
7. 定期备份 `myagent_data` / `myagent_workspaces`，并**单独备份 `myagent_secrets` 卷中的加密密钥**（丢失密钥会导致数据永久不可读）；保持宿主机与镜像更新。
8. 若 Web 前端与 API 不同源，在 `.env` 的 `CORS_ORIGINS` 填前端 Origin（逗号分隔，必须带 `https://` 和端口）。
9. `TRUST_PROXY=true` 只适用于“服务端仅经本仓库 nginx/Caddy 暴露”的场景：两者都会覆写 `X-Forwarded-Host`/`X-Forwarded-For`。若自己改反代，必须确保这两个头被覆盖，否则客户端可伪造。直接暴露 3000 端口时应设 `TRUST_PROXY=false`。
10. 不需要 SSH 工具时保持 `SSH_ALLOW_PRIVATE_HOSTS=false`；确需连局域网机器再临时开启。

## 剩余风险（需要知悉）

| 风险 | 说明 | 建议 |
| --- | --- | --- |
| Agent 代码执行 | 登录后可让模型执行 Python；子进程已降权 UID 10001、读不到加密密钥，但仍可访问 Docker 内网和运行时解密出的工作区明文 | 仅自己使用；公网高安全场景应把 Agent 执行拆到独立无密钥、无内网权限的 runner 容器 |
| 单用户模型 | 所有会话/记忆/工作区共享一个密码，无用户隔离 | 不要共享密码，不要当多人服务 |
| 服务端 LLM 密钥 | 任一登录用户都可用服务端 Key 发起真实调用；限速是按客户端内存计数，重启会清零 | 公网务必强密码；可设更低的 `CHAT_RATE_LIMIT_PER_MINUTE`，并在 DeepSeek 控制台设额度告警 |
| 反代头信任 | `TRUST_PROXY=true` 与 Origin 校验都依赖反代覆写 `X-Forwarded-*` | 使用仓库自带 nginx/Caddy；自定义反代必须覆盖这两个头 |
| 限速状态 | 登录/聊天限速存在单进程内存，重启或多实例部署会失效 | 公网多实例时用网关/WAF 做限速 |
| 静态加密边界 | 应用层加密保护会话/资料/索引/工作区，但 root 或密钥持有者可解密；Honcho 的 Postgres/Redis 仍明文，设备本地存储也明文；旧快照可能保留明文 | 密钥单独备份并限权；敏感会话关闭记忆写入；对 Honcho 卷和整机做 ZFS/LUKS 加密；删除旧快照 |
| 手机 Bearer token | token 存在 WebView localStorage，30 天有效 | 手机丢失后在网页端改密（会轮换密钥使旧 token 失效） |
| Debug APK | 当前分发的 `WyDeepSeek-debug.apk` 允许 WebView 调试；仅适合自己安装 | 对外分发请生成签名 release APK（关闭 WebView 调试） |
| 局域网 HTTP | 手机 App 为兼容局域网允许明文 HTTP | 公网必须 HTTPS；局域网也建议可信 Wi-Fi |
| Honcho 内网信任 | Honcho DB 使用 trust、API 内部不鉴权 | 不映射 honcho 端口；server 被攻破时内网数据仍可能被读取 |
| 无 WAF/入侵检测 | 仅应用层限速与认证 | 公网建议加云 WAF、fail2ban、访问日志告警 |
| 依赖升级 | 前端渲染库仍会持续披露新漏洞 | 定期 `pnpm audit --prod` 并升级 |

## 快速自检

```bash
# 是否已设密码/是否强制认证
curl -s https://agent.example.com/api/auth/status

# 无 Cookie 访问业务接口应返回 401
curl -s -o /dev/null -w '%{http_code}\n' https://agent.example.com/api/sessions

# 安全响应头
curl -sI https://agent.example.com/ | grep -Ei 'content-security|strict-transport|x-frame|referrer'
```

如果 `passwordSet=false` 且 `requireAuth=true`，页面会提示先在服务端 `.env` 配置 `ACCESS_PASSWORD`。
