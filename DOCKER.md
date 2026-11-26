# Docker 开发与部署

本项目是纯静态前端 + 轻量记忆/压缩后端：浏览器直连 DeepSeek API（API Key 留在浏览器），`server` 服务负责自我检索（Honcho）、上下文压缩与请求代理。

| 服务 | 用途 | 端口 | 启动方式 |
| --- | --- | --- | --- |
| `web` | 开发模式（rspack dev server + 热更新） | http://localhost:8090 | 默认启动 |
| `server` | 记忆/压缩后端（Fastify + TS），`/api` 反向代理入口 | 仅本机 127.0.0.1:3000 | 默认启动 |
| `web-prod` | 生产模式（nginx 托管 `dist/` + `/api` 反代） | http://localhost:8080 | `--profile prod` |
| `honcho-api/deriver/db/redis` | Honcho 自托管记忆后端 | 仅内网 | `--profile honcho` |

## 快速开始（WSL）

```sh
cd ~/projects/MyAgent

# 开发：web + server
docker compose up -d --build

# 记忆后端（自托管 Honcho，可选但推荐）
docker compose --profile honcho up -d --build

# 查看日志 / 状态
docker compose logs -f web server
docker compose ps
```

浏览器打开 http://localhost:8090，在设置里填入 API Key 即可聊天。

源码通过 bind mount 挂载进容器，修改 `src/`（前端）与 `server/src/`（后端）都会热重载；`node_modules` 保存在命名卷中，不受宿主机影响。

## 记忆与上下文压缩

- **自我检索**：每轮提问自动从 Honcho 召回长期记忆注入上下文（设置 → 记忆与上下文 → 自我检索开关）。回答上方可展开「已召回 N 段记忆」面板查看注入内容（显示召回详情开关）。
- **上下文压缩**：对话超过阈值（50% 有效上下文，64K 下限）时自动把中间轮次压缩为结构化摘要；历史完整保留展示，仅压缩发给模型的内容，压缩点有 🧩 分隔条，可展开查看摘要。
- **记忆条目**：设置页可浏览、删除 Honcho 推理出的结论（conclusions）。

### 会话页头部控件

会话标题右侧提供：**token 消耗统计**（输入/输出/缓存命中）、**上下文占用圆环**（按最近一轮真实 prompt token 计算，≥70% 变黄、≥90% 变红）、**压缩上下文**按钮（等价于输入框的 `/compress` 命令，立即压缩中段轮次）、**记忆**按钮（打开记忆可视化面板：用户画像、用户卡片、AI 自画像与结论）。

### 模型选择

设置 → 通用设置 → 模型：`deepseek-flash`（默认，快速）/ `deepseek-v4-pro`（更强），后续新消息使用所选模型。

## 会话同步（网页 ↔ 手机）

服务端新增会话库，网页端与手机端共享同一份对话：

- 数据目录：`myagent_data` 卷下的 `/app/data/sessions/`（每个会话一个 JSON + `.meta.json` 摘要），删除墓碑在 `/app/data/session-tombstones.json`。
- 接口：`GET /api/sessions`（列表 + 墓碑）、`GET/PUT /api/sessions/:id`、`DELETE /api/sessions/:id`；删除会话同时清理对应 agent 工作区。
- 客户端：启动、窗口回到前台、每 30 秒拉取；本地保存后约 1 秒推送。`updatedAt` 后写覆盖；标题/分组/归档/压缩状态变化也会同步。
- 删除会写墓碑并同步到另一端；离线删除记录在本地，恢复网络后补发。未连接服务器时完全本地可用，连上后自动补传。

## 消耗统计（余额 / Token / 速度）

设置 → **消耗**（网页端与手机端一致）：

- Token 总消耗、输入/输出/缓存读取、请求次数、最近 7 天柱状图。
- 生成速度：按回复的 `elapsedMs` 计算平均与最近 20 条输出速度（tokens/s）。
- 余额：服务端调用 DeepSeek 官方 `GET /user/balance`（使用 `DEEPSEEK_API_KEY`），带 30 秒缓存，可手动刷新。
- 平均成本：按余额变化与 token 增量估算每百万 token 成本；余额按分计费且可能有延迟，需累计约 2 万 tokens 的样本后才展示，仅供参考。
- 接口：`GET /api/usage?tzOffset=-480[&refresh=1]`；余额样本保存在数据卷 `/app/data/usage-state.json`。

## Agent 模式

输入框的「Agent 模式」开关为**会话级**：开启后本会话拥有独立工作区，模型可通过工具完成文件操作与隔离执行，结果以文件卡片交付：

- **文件操作**：`list_files` / `read_file` / `write_file` / `delete_file`（对应 claude-code 的 Read/Write/Edit 工具概念）
- **隔离执行**：`run_python`（工作区为 cwd 运行 Python，已预装 numpy/matplotlib/pandas/requests，超时 60s、输出截断、matplotlib 无头模式出图）；`run_script`（执行工作区 .py）
- **交付与展示**：写入/生成的图片自动成为交付卡片，可点击预览；头部「工作区」按钮打开文件树面板
- **SSH 主机**：头部「SSH 主机」按钮为会话配置远程主机（密码或私钥认证），配置后本会话的文件操作与执行改到远程 `remotePath`；凭据只存本会话
- **隔离与回收**：工作区在容器内独立目录（持久化卷 `myagent_workspaces`），路径越界被拒绝；关闭 agent 或删除会话即整体回收，会话资源不跨对话

工具循环在后端完成（最多 10 轮 tool_use/tool_result 往返），前端按单条回答流式渲染工具时间线与交付卡片。

## 网络代理（构建加速）

国内网络下载慢时，可在项目根 `.env` 设置：

```sh
# 本机 v2ray/clash 代理（Docker 构建期走代理拉取 apt/pip/npm 依赖）
DOCKER_BUILD_PROXY=http://host.docker.internal:10808
```

再执行 `docker compose build`（已缓存层不受影响）。运行时容器的外呼（DeepSeek/Honcho 在 compose 内网）不走该代理。

## 访问密码（单用户）

- 设置 → 数据管理 → **访问密码**：设置/修改密码（至少 10 位，公网建议 16 位以上），或退出当前设备登录。
- 密码只存 scrypt 哈希于数据卷 `myagent_data`（`/app/data/auth.json`）；登录态为 HMAC 签名 Cookie（30 天）或 Bearer token。
- 修改密码会轮换会话密钥，所有旧 Cookie / 手机 token 立即失效。
- 未设置密码时应用保持开放；设置后所有 `/api` 接口都要求登录（健康检查与登录接口除外）。
- 公共网络部署请同时设置 `REQUIRE_AUTH=true`，避免忘记设密码时直接暴露；完整清单见 [SECURITY.md](SECURITY.md)。
- 忘记密码：删除数据卷中的 `auth.json` 后重启服务即可重置：

```sh
docker compose exec server rm -f /app/data/auth.json
```

- 也可在 `.env` 设置 `ACCESS_PASSWORD=...`，仅首次启动（尚未通过界面设置）时自动生效。

## 公网部署（HTTPS）

```dotenv
# .env
ACCESS_PASSWORD=至少16位的强密码
REQUIRE_AUTH=true
PUBLIC_DOMAIN=agent.example.com
ACME_EMAIL=you@example.com
PROD_BIND=127.0.0.1
# 仅经仓库自带 nginx/Caddy 暴露时保持 true（两者都会覆写 X-Forwarded-*）
TRUST_PROXY=true
# SSH 工具默认禁止连内网；需要连局域网机器再临时改 true
SSH_ALLOW_PRIVATE_HOSTS=false
# 每个客户端每分钟聊天/压缩上限，以及允许的模型白名单
CHAT_RATE_LIMIT_PER_MINUTE=30
ALLOWED_MODELS=deepseek-flash,deepseek-v4-pro
```

```sh
docker compose --profile prod --profile public up -d --build
```

Caddy 自动申请/续期证书并 301 到 HTTPS；只对公网开放 80/443，不要映射 8090（开发服务器）或 3000（后端调试端口）。自定义反向代理时必须覆写 `X-Forwarded-For` 与 `X-Forwarded-Host`，否则登录限速和 CSRF 同源校验可被伪造头绕过。
手机端服务器地址填 `https://agent.example.com`。Agent 模式属于远程代码执行能力，公网高安全场景建议只自己使用或拆分独立 sandbox runner，详见 [SECURITY.md](SECURITY.md)。

## 手机 App（Android）

`mobile/` 是基于 deepseek-app-replica 改造的安卓客户端：保留其 UI 与本地会话存储，新增「服务器模式」——
手机把请求发到本项目的后端，由后端统一执行模型、长期记忆、上下文压缩与 Agent 工具。

1. 构建 APK（WSL 环境步骤见 [mobile/README-MYAGENT.md](mobile/README-MYAGENT.md)），产物 `mobile/WyDeepSeek-debug.apk`。
2. 安装后进入「设置 → 服务器」，填写 `http://<电脑局域网 IP>:8090` 与访问密码，点击连接；公网填 HTTPS 域名。
3. 连接成功后可在手机上开关 **Agent 模式** 与 **长期记忆**；手机端不需要填 DeepSeek Key（后端 `.env` 提供）。
4. 附件上传在服务器模式下仍需在 App 内额外填写 DeepSeek Key，纯文本与 Agent 不受影响。

### Honcho 的 LLM 配置

自托管 Honcho 的 deriver（后台推理用户画像）需要 LLM。默认指向 DeepSeek（OpenAI 兼容），需要在**项目根目录**建 `.env`（compose 自动读取，`.gitignore` 已忽略）：

```sh
# ~/projects/MyAgent/.env（与前端设置的 API Key 相同即可）
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_API_ORIGIN=https://api.deepseek.com
```

改完执行 `docker compose --profile honcho up -d` 重启 honcho 服务生效。不配置时聊天功能完全正常，只是 Honcho 无法推理出画像/摘要（记忆条目与召回内容为空）。变量名与默认值见 [server/.env.example](server/.env.example)。

## 常用命令

```sh
# 重建镜像（改了 Dockerfile 或依赖后）
docker compose up -d --build

# 进入容器执行 pnpm 命令
docker compose exec web pnpm type
docker compose exec web pnpm lint
docker compose exec server pnpm type
docker compose exec server pnpm test

# 新增依赖（文件会以当前用户身份写入，不会出现 root 属主）
docker compose exec web pnpm add <package>

# 依赖变更后刷新 node_modules 卷
docker compose down
docker volume rm myagent_node_modules
docker compose up -d --build

# 停止 / 清理
docker compose down
```

## 生产镜像

```sh
# 构建并启动 nginx 版本（server 服务随默认 profile 一并启动，nginx 反代 /api）
docker compose --profile prod up -d --build

# 打开 http://localhost:8080
curl -I http://localhost:8080
curl http://localhost:8080/api/health
```

生产镜像分两阶段：`node:24-bookworm-slim` 中执行 `pnpm build`，再由 `nginx:1.29-alpine` 托管 `dist/`。nginx 配置见 [docker/nginx.conf](docker/nginx.conf)，包含 gzip、静态资源长缓存、SPA 回落、`/healthz` 健康检查与 `/api` 到 server 的 SSE 反代（关闭缓冲）。

如需部署到服务器，可直接导出镜像：

```sh
docker build --target prod -t myagent:latest .
docker build -t myagent-server:latest server
docker save myagent:latest | gzip > myagent.tar.gz
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEV_PORT` | `8090` | 开发服务映射到宿主机的端口 |
| `PROD_PORT` | `8080` | 生产预览映射到宿主机的端口 |
| `SERVER_PORT` | `3000` | server 服务映射到本机（127.0.0.1）的端口 |
| `DEEPSEEK_API_KEY` | 空 | server 与 Honcho deriver 的兜底凭据（压缩摘要、查询改写、画像推理） |
| `DEEPSEEK_API_ORIGIN` | `https://api.deepseek.com` | DeepSeek API 地址 |
| `HONCHO_BASE_URL` | `http://honcho-api:8000` | Honcho 自托管地址 |
| `HONCHO_API_KEY` | `local` | Honcho 凭据（本地自托管任意值） |
| `HONCHO_LLM_BASE_URL` | `https://api.deepseek.com/v1` | Honcho deriver 的 OpenAI 兼容 LLM 地址 |

API 地址在**构建期**注入（`rspack.config.ts` 的 `createConfig({ apiOrigin })`），默认 `https://api.deepseek.com`。需要切换网关时修改该默认值或在配置文件中传入，然后重新构建镜像。

## 文件说明

```text
Dockerfile         前端多阶段构建：base → deps → dev / build → prod
compose.yaml       web + server（默认）、web-prod（prod profile）、honcho×4（honcho profile）
docker/nginx.conf  生产环境的 nginx 站点配置（含 /api SSE 反代）
server/            记忆/压缩后端：Fastify + TS，Honcho REST 客户端、自我检索、上下文压缩
server/honcho/     Honcho 数据库初始化脚本（自托管用）
.dockerignore      排除 node_modules、dist、.git 等
```

## 扩展后端能力

`server/` 已承担「请求代理 + 自我检索 + 上下文压缩」。后续若要加工具调用、RAG 等 Agent 能力，在 `server/src` 中新增路由并在 `routes/chat.ts` 的请求处理管线里插入即可；前端只认 `/api` 入口与 SSE 事件契约（`src/services/api/types.ts` 的 `MessageStreamEvent`），新增事件旧客户端会自动忽略。
