<p align="center">
  <img src="docs/images/deepseek-logo.svg" width="76" alt="DeepSeek logo used for identification">
</p>

<h1 align="center">WyDeepSeek · MyAgent</h1>

<p align="center"><strong>可自托管的个人 AI Agent：网页端 + Android，共享同一套会话、记忆、上下文与工具。</strong></p>

<p align="center">
  <a href="README.en.md">English</a> · 简体中文
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT%20%2B%20GPL--3.0-blue" alt="License">
  <img src="https://img.shields.io/badge/web-React%2018%20%2B%20rspack-1f6feb" alt="Web">
  <img src="https://img.shields.io/badge/server-Fastify%205-000000" alt="Server">
  <img src="https://img.shields.io/badge/Android-9%2B-3ddc84" alt="Android">
  <img src="https://img.shields.io/badge/DeepSeek-deepseek--flash-4d6bfe" alt="DeepSeek">
</p>

> [!IMPORTANT]
> **非官方项目声明**
>
> 本项目界面与文档使用了 **DeepSeek 的金鱼 LOGO**，仅用于标识所接入的模型与服务。WyDeepSeek（内部代号 MyAgent）是独立的第三方自托管项目，**不是 DeepSeek 的官方产品**，与 DeepSeek 不存在隶属、合作、赞助或背书关系。DeepSeek 的名称与 Logo 归其权利人所有。详见 [NOTICE.md](NOTICE.md)。

---

WyDeepSeek（内部代号 MyAgent）不是一个“套壳聊天页”，而是一套**单用户、可自托管**的 Agent 工作台：

- **网页端**负责完整交互、分支、编辑、导入导出与 Agent 工作区；
- **Android 端是网页版的一个客户端**，请求默认走 `手机 → 自建服务端 → DeepSeek`，手机不保存服务端的 DeepSeek Key；
- **服务端**统一处理会话同步、长期记忆、上下文压缩、Agent 工具循环、用量统计和鉴权；
- **两端共享同一份会话历史**，任意一端继续对话，另一端能看到同样的消息、分组、归档和压缩状态。

## 目录

- [界面速览](#界面速览)
- [功能地图](#功能地图)
- [架构](#架构)
- [移植功能出处](#移植功能出处)
- [快速开始](#快速开始)
- [配置](#配置)
- [数据与同步](#数据与同步)
- [API 一览](#api-一览)
- [项目结构](#项目结构)
- [安全](#安全)
- [测试与构建](#测试与构建)
- [许可证与致谢](#许可证与致谢)

## 界面速览

| 桌面端：Agent 工具时间线与交付文件 | 移动端：WebView 响应式布局（同一会话） |
| :---: | :---: |
| <img src="docs/images/web-chat.png" width="720" alt="桌面端聊天与 Agent 交付文件"> | <img src="docs/images/web-mobile.png" width="230" alt="移动端聊天布局"> |

| 消耗：余额、Token、速度、7 天用量 | 记忆与上下文：服务状态、召回、压缩、结论 |
| :---: | :---: |
| <img src="docs/images/web-usage.png" width="420" alt="消耗统计面板"> | <img src="docs/images/web-memory.png" width="420" alt="记忆与上下文设置"> |

> 截图为深色主题；余额数值已做隐藏处理。

## 功能地图

### 对话与内容

- 多会话、自动标题、重命名、置顶、分组、归档、复制对话。
- 流式回复、深度思考、智能搜索、链接阅读与来源引用；停止生成、重新生成、继续生成。
- 编辑用户消息、切换消息分支、回溯到某条消息重新提问。
- Markdown、代码高亮、KaTeX 公式、Mermaid 图表。
- 图片/文件附件、拖拽与粘贴上传、语音输入、回复朗读。
- 中英文界面、浅色/深色主题、桌面与移动端响应式布局。
- Markdown / PDF / HTML 导出，单会话 Markdown / HTML 导入。

### 长期记忆（Hermes 能力移植）

- **自我检索**：每轮用最新用户消息做查询改写，从 Honcho 召回用户画像、历史结论与会话摘要，以 `<memory-context>` 围栏注入请求。
- **召回可视化**：回复上方显示“已召回 N 段记忆”，可展开查看注入内容。
- **记忆库**：用户画像、用户卡片、AI 自画像、Honcho 推理结论；支持逐条删除。
- **会话级开关**：自我检索、召回详情、长期记忆读取/写入均可按会话覆盖。
- **异步写入**：每轮结束后台把对话写入 Honcho，不阻塞回复；失败只记录，不影响聊天。

### 上下文压缩（Hermes 能力移植）

- 接近阈值时自动把“中间轮次”压缩成结构化摘要，**护头 + 摘要中段 + 预算尾部**三段式窗口。
- 默认阈值：`50% ×（上下文窗口 − 最大输出）`，64K 下限；尾部预算 `min(25K, ctx×2.5%)`。
- 迭代摘要：上一版摘要 + 新轮次继续压缩；摘要失败时使用确定性回退摘要并进入冷却。
- **历史不丢**：消息列表完整保留，压缩只影响发给模型的投影；在归档边界显示“上下文已压缩（N 轮）”分隔条，可展开查看摘要。
- 头部圆环显示当前上下文占 128K 窗口比例（≥70% 黄、≥90% 红），支持手动“立即压缩”。

```mermaid
flowchart LR
  Head["护头<br/>首轮 / 系统提示"] --> Middle["摘要中段<br/>上一版摘要 + 归档轮次"]
  Middle --> Tail["预算尾部<br/>最近消息（≥20 条 / ≥1 轮）"]
  Tail --> Model["发给模型<br/>摘要行 + 未归档消息"]
```

> `护头` 与 `尾部` 原样保留，只有中段被结构化摘要替换；下一次压缩会把上一版摘要一起迭代。

### Agent 模式（服务端执行）

- 会话级 Agent 开关；开启后该会话拥有独立工作区。
- 服务端工具循环：`list_files` / `read_file` / `write_file` / `delete_file` / `run_python` / `run_script`。
- Python 在容器工作区中执行，预装 numpy / matplotlib / pandas / requests，matplotlib 无头出图。
- 交付文件卡片：文本预览、图片预览、下载；Web 端可浏览工作区文件树。
- Web 端支持 SSH 远程工作区（密码或私钥认证，凭据只存当前会话，不同步到服务端/手机）。
- 工具调用以可折叠时间线展示，运行中展开、完成后收起。

### 多端会话同步

- 服务端是两端会话的汇合点：网页端和手机端都同步到 `/app/data/sessions/`。
- 启动、回到前台、每 30 秒拉取；本地保存后约 1 秒推送。
- 标题、消息、分支、压缩状态、分组、归档、置顶、会话级开关都会同步。
- 删除通过服务端墓碑同步；离线删除在恢复网络后补发。
- 附件原件不跨设备同步（消息保留文件信息）；Agent 交付文件在服务端工作区，两端都能查看。

### 用量与成本

- 设置 → **消耗**：账户余额、Token 总消耗、输入/输出/缓存读取、请求次数、生成速度（tokens/s）。
- 最近 7 天 Token 柱状图。
- 余额来自 DeepSeek 官方 `GET /user/balance`，30 秒缓存，可手动刷新。
- 平均成本按“余额变化 ÷ Token 增量”估算；余额按分计费且有延迟，累计约 2 万 tokens 后才展示。
- 网页端与手机端读取同一份服务端统计。

## 架构

```mermaid
flowchart LR
  subgraph Clients["客户端"]
    Web["Web<br/>React 18 + IndexedDB"]
    Android["Android<br/>WebView + SQLite"]
  end

  Proxy["nginx / Caddy<br/>HTTPS · CSP · 限速"]
  Server["Fastify 服务端<br/>/api"]
  DS["DeepSeek API<br/>deepseek-flash / v4-pro"]
  Honcho["Honcho<br/>记忆 / 用户建模 / 推理"]
  Data[("data 卷<br/>会话 · 认证 · 用量")]
  Workspaces[("workspaces 卷<br/>Agent 工作区")]

  Web --> Proxy
  Android --> Proxy
  Proxy --> Server
  Server --> DS
  Server --> Honcho
  Server --> Data
  Server --> Workspaces
```

### 一次请求如何流动

```mermaid
sequenceDiagram
  autonumber
  participant C as Web / Android
  participant S as Fastify 服务端
  participant H as Honcho
  participant D as DeepSeek

  C->>S: messages + 会话级开关（记忆 / 压缩 / Agent）
  S->>H: 查询改写 + 自我检索
  H-->>S: 召回的用户画像 / 摘要 / 结论
  S->>S: 超过阈值则压缩中段轮次
  S->>D: 摘要 + 尾部消息 + 记忆围栏 + 工具
  D-->>S: SSE（thinking / tool_use / usage）
  S-->>C: memory_recall / context_compressed / delta
  S->>H: 异步写入本轮对话（不阻塞）
```

### 多端同步

```mermaid
sequenceDiagram
  autonumber
  participant W as Web
  participant A as Android
  participant S as 服务端会话库

  W->>S: PUT /api/sessions/:id
  A->>S: PUT /api/sessions/:id
  Note over S: updatedAt 后写覆盖（LWW）
  S-->>W: GET /api/sessions + tombstones
  S-->>A: GET /api/sessions + tombstones
  W->>S: DELETE /api/sessions/:id
  S-->>A: tombstone → 删除本地副本
```

## 移植功能出处

本项目在 DeepSeek chat-demo 的 UI 基座上，重点移植了 **Hermes Agent** 的记忆与上下文能力，并参考了 Claude Code 的 Agent 工具模型。移植基线为 2026-11 的 `NousResearch/hermes-agent` 主分支；上游仍在演进，具体行为以本项目代码注释中的文件路径为准。原则是**保留上游行为语义，用 TypeScript 重写并适配单用户、无状态代理架构**。

| 能力 | 上游出处 | 本项目实现 | 移植方式与差异 |
| --- | --- | --- | --- |
| 自我检索 / 记忆召回 | Hermes `agent/memory_provider.py`、`agent/memory_context.py`、`plugins/memory/query_rewrite.py`、`session_rules/turns.py`；[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `server/src/memory/{honcho,queryRewrite,trivial,fence}.ts` | Python → TypeScript 行为级移植：trivial 判定、查询改写正则、`<memory-context>` 围栏、bullet 去重、cadence 退避均对齐；去掉多 provider/cron，单用户简化 |
| 上下文压缩 | Hermes `agent/context_compressor.py`（[固定版本链接](https://github.com/NousResearch/hermes-agent/blob/b98c388a/agent/context_compressor.py)） | `server/src/compression/{window,prompt,compress,tokens}.ts` | 移植三段式窗口、50% 阈值、64K 下限、迭代摘要、`[REDACTED]` 凭据红线、静态回退摘要与失败冷却；压缩状态由前端会话元数据 + 服务端内存共同承载 |
| 长对话管理 | Hermes 压缩归档 / token 账本语义 | `src/services/chat/usage.ts`、`server/src/usage.ts`、消息列表压缩分隔条 | 历史完整保留展示，模型投影跳过归档段；逐轮累计 usage，压缩轮数随会话同步 |
| Honcho 记忆后端 | [Plastic Labs Honcho](https://github.com/plastic-labs/honcho) 的 `hermes-plugin-honcho` | `server/src/memory/honcho.ts`、`server/src/honcho/api.ts`、`compose.yaml` 的 honcho profile | 移植 session/peer 建模、context 层 + dialectic 层、批量消息写入、conclusions；改为对齐 Honcho v3 REST 路由的轻量客户端，单用户、embedding 默认关闭 |
| 回溯重聊 | Hermes `/rewind` 语义 | `src/services/chat/store.ts`、`mobile/src/services/chat/store.ts` | 截断目标消息之后的全部内容并重新提问；Web 与手机行为一致 |
| Agent 工具循环 | Claude Code 的 QueryEngine `tool_use / tool_result` 循环与 session-scoped cwd（[anthropics/claude-code](https://github.com/anthropics/claude-code)，概念参考） | `server/src/agent/{loop,tools,workspace,ssh}.ts` | 非源码移植：用 TypeScript 重写工具协议、工作区路径校验、Python 隔离执行、SSH/SFTP；最多 10 轮工具往返 |
| Web UI 基座 | [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT） | `src/` | 保留原聊天 UI、Markdown/KaTeX/Mermaid、会话分支与导入导出；新增服务端代理、记忆、压缩、Agent、用量与鉴权 |
| Android 客户端 | [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)（GPL-3.0） | `mobile/` | 保留其 UI 与本地 SQLite 会话存储；新增“服务器模式”、跨端同步、Agent/记忆/压缩开关、上下文圆环、消耗统计、工作区与导出 |
| 用量 / 余额 / 成本 | 本项目原创；余额调用 DeepSeek 官方 `/user/balance` | `server/src/usage.ts`、`src/components/settings/UsageSettings.tsx`、`mobile/src/components/usage/UsagePanel.tsx` | 扫描会话 usage 快照聚合；余额样本持久化；按余额变化估算平均成本 |
| 安全加固 | 本项目原创；经 ARTEX 2.2.0 授权自测后加固 | `server/src/auth.ts`、`routes/auth.ts`、`agent/ssh.ts`、`rateLimit.ts`、`sessions.ts` | scrypt 密码、HMAC Cookie/Bearer、登录/聊天限速、CSRF Origin 校验、SSRF 防护、登出撤销、错误泛化；详见 [SECURITY.md](SECURITY.md) |

### 移植边界

- **Hermes 是行为级移植，不是逐行翻译**：上游是 Python 多 provider Agent，本项目是 TypeScript 单用户服务端；保留了阈值、提示词结构、去重/冷却/回退等关键语义，去掉了多用户、cron、provider 插件发现等本项目不需要的部分。
- **Claude Code 仅作概念参考**：工具名、循环结构、工作区隔离来自其公开行为描述，没有复制其源码。
- **Android UI 来自 GPL 项目**：`mobile/` 是 deepseek-app-replica 的衍生作品，遵循 GPL-3.0；根目录 MIT 许可主要覆盖 Web/服务端。
- **Honcho 是可选依赖**：不启动 `honcho` profile 时，聊天/压缩仍可用，只是记忆服务显示未连接。

## 快速开始

### 方式一：Docker（推荐）

前置：Docker Desktop（含 Compose）、可访问 DeepSeek API 的网络。

```sh
git clone <your-repo> MyAgent
cd MyAgent

# 1) 配置服务端密钥与访问密码
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-你的DeepSeekKey
ACCESS_PASSWORD=至少16位的强密码
REQUIRE_AUTH=true
EOF

# 2) 开发模式：Web 热更新 + 服务端
docker compose up -d --build

# 3) 自托管记忆（可选但推荐）
docker compose --profile honcho up -d --build

# 4) 生产预览（nginx + 静态产物）
docker compose --profile prod up -d --build
```

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 开发前端 | http://localhost:8090 | rspack dev server，热更新 |
| 生产预览 | http://localhost:8080 | nginx 托管 `dist/` + `/api` 反代 |
| 服务端 | http://127.0.0.1:3000/api/health | 仅本机绑定，供调试 |
| Honcho | 仅 Compose 内网 | `honcho-api` / `deriver` / `db` / `redis` |

常用命令：

```sh
docker compose ps
docker compose logs -f web server
docker compose --profile honcho logs -f honcho-api honcho-deriver
```

> `.env` 里的 `ACCESS_PASSWORD` 仅首次启动且尚未在界面设置密码时生效；之后以 `data/auth.json` 中的 scrypt 哈希为准。

### 方式二：本地开发

需要 Node.js 22.12+、pnpm。Web 与 server 分开启动：

```sh
# 终端 1：Web
pnpm install
pnpm dev            # http://localhost:8090

# 终端 2：服务端
cd server
pnpm install
pnpm dev            # http://127.0.0.1:3000

# 可选：Honcho（Docker）
docker compose --profile honcho up -d --build
```

Web 端通过 `/api` 代理访问服务端；如果不用 Docker，需要在 `rspack.config.ts` 里确认 devServer 代理目标，并自行启动 Honcho 或关闭记忆功能。

### Android

Android 端是 WebView 客户端，UI 与本地会话存储来自 deepseek-app-replica，新增服务器模式。构建与安装说明见 **[mobile/README-MYAGENT.md](mobile/README-MYAGENT.md)**。

```sh
# 先构建 mobile/dist，再打包 Debug APK（完整命令见上述文档）
cd mobile/android
./gradlew :app:assembleDebug -x buildWeb
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`。

手机端首次打开填写：

- **服务器地址**：`http://<电脑局域网IP>:8090`（开发）或 `https://你的域名`（公网）
- **访问密码**：Web 端设置的访问密码（未设置可留空）
- 公网必须 HTTPS；局域网 HTTP 仅用于可信 Wi-Fi。
- 纯文本聊天、记忆、压缩与 Agent 不需要手机自带 Key；**图片/附件上传**仍走 DeepSeek Files API，需要在 App 内额外配置自己的 DeepSeek Key。

## 配置

根目录 `.env`（Compose 读取）常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 空 | 服务端兜底 Key；压缩摘要、查询改写、Honcho deriver、用量/余额共用 |
| `ACCESS_PASSWORD` | 空 | 首次启动的访问密码，至少 10 位，公网建议 16 位以上 |
| `REQUIRE_AUTH` | `false` | `true` 时未设置密码会拒绝所有业务接口，公网必开 |
| `PUBLIC_DOMAIN` | 空 | Caddy 自动 HTTPS 的域名 |
| `ACME_EMAIL` | 空 | Let's Encrypt 通知邮箱 |
| `PROD_BIND` | `0.0.0.0` | 生产端口绑定地址；公网建议 `127.0.0.1`，只让 Caddy 暴露 |
| `TRUST_PROXY` | `true`（Compose） | 仅当服务端只经会覆写 `X-Forwarded-*` 的 nginx/Caddy 暴露时开启 |
| `SSH_ALLOW_PRIVATE_HOSTS` | `false` | SSH 工具是否允许连内网/回环地址；默认禁止以防 SSRF |
| `CHAT_RATE_LIMIT_PER_MINUTE` | `30` | 单客户端每分钟聊天/压缩请求上限 |
| `ALLOWED_MODELS` | `deepseek-flash,deepseek-v4-pro` | 允许请求的模型白名单 |
| `CORS_ORIGINS` | 手机 WebView + 本地预览 | 额外允许的跨域来源，逗号分隔 |
| `HONCHO_BASE_URL` / `HONCHO_API_KEY` | 空 / `local` | 自托管 Honcho 地址与凭据 |

完整的服务端变量说明见 [server/.env.example](server/.env.example)；公网清单见 [SECURITY.md](SECURITY.md)。

## 数据与同步

| 数据 | 存放位置 | 是否跨端 |
| --- | --- | --- |
| Web 会话、草稿、附件原件 | 浏览器 IndexedDB + localStorage | 通过服务端同步会话；附件原件不同步 |
| Android 会话 | 本地 SQLite + 侧车元数据 | 通过服务端同步 |
| 服务端会话 | `myagent_data` 卷 `/app/data/sessions/` | 两端共享 |
| 访问密码哈希 / 会话密钥 | `myagent_data` 卷 `/app/data/` | 服务端 |
| 用量样本 | `myagent_data` 卷 `/app/data/usage-state.json` | 两端读取同一份 |
| Agent 工作区 | `myagent_workspaces` 卷 `/app/workspaces/` | 服务端；两端可查看 |
| Honcho 记忆 | `myagent_honcho_pgdata` / `myagent_honcho_redis` 卷 | 服务端 |

同步采用 **last-write-wins**：客户端写入 `updatedAt`，服务端只接受更新的版本；删除写墓碑，客户端拉取后删除本地副本并清理工作区。服务端会对会话做结构校验（消息数组、有限时间戳、嵌套 ≤200 层、≤2 万条消息），并剥离 `ssh` 凭据。

## API 一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/chat` | Web SSE 聊天（记忆召回、压缩、Agent、usage） |
| `POST` | `/api/mobile/messages` | 手机端聊天（同一管线） |
| `POST` | `/api/chat/complete` | 轮次收尾，异步写入记忆 |
| `POST` | `/api/compress` | 手动压缩上下文 |
| `GET/PUT/DELETE` | `/api/sessions`、`/api/sessions/:id` | 会话列表 / 读取 / 同步 / 删除 |
| `GET` | `/api/usage` | Token、速度、余额、成本统计 |
| `GET/POST/DELETE` | `/api/agent/*` | 工作区文件树、文件、SSH 测试、参考资料 |
| `GET/DELETE` | `/api/memory/*` | 记忆状态、结论列表/删除 |
| `POST` | `/api/auth/login`、`/api/auth/logout`、`/api/auth/password` | 登录 / 登出撤销 / 改密 |
| `POST` | `/api/export/*` | Markdown / PDF / HTML 导出 |

除 `/api/health`、`/api/auth/status`、`/api/auth/login` 外，业务接口都需要 Cookie 或 `Authorization: Bearer`；手机端登录使用 `x-myagent-client: mobile` 获取 Bearer token。

## 项目结构

```text
.
├── src/                     # Web 前端（React 18 + rspack）
│   ├── components/          # 聊天、会话、Agent、记忆、设置
│   ├── services/            # API、SSE、IndexedDB、同步、导出
│   └── i18n/                # 中英文文案
├── server/                  # Fastify + TypeScript 服务端
│   └── src/
│       ├── agent/           # 工具循环、工作区、SSH
│       ├── compression/     # Hermes 压缩移植
│       ├── memory/          # Hermes / Honcho 记忆移植
│       ├── routes/          # chat / sessions / auth / usage / export
│       ├── sessions.ts      # 服务端会话库、墓碑、校验
│       └── usage.ts         # Token / 余额 / 成本
├── mobile/                  # Android WebView 客户端（GPL-3.0 衍生）
├── docker/                  # nginx / Caddy 配置
├── docs/images/             # README 截图与 Logo
├── compose.yaml             # web / server / honcho / prod / public
├── SECURITY.md              # 安全评估、加固、公网清单
├── NOTICE.md                # 商标与非官方项目声明
└── DOCKER.md                # Docker 开发与部署细节
```

## 安全

- 单用户访问密码：scrypt 哈希、HMAC 签名 Cookie / Bearer token、登录失败限速、改密轮换密钥、登出撤销。
- 公网部署：`REQUIRE_AUTH=true`、HTTPS（Caddy 自动证书）、只暴露 80/443、不要映射 8090/3000。
- 接口防护：CORS 白名单、CSRF Origin 校验、聊天/压缩/SSH 限速、SSRF 内网地址阻断、错误信息泛化、会话结构校验。
- Agent 模式本质是**服务端代码执行**：当前在容器内以 root 运行，只建议自己使用；公网高安全场景应拆分独立 sandbox runner。
- 2026-11 已用 ARTEX 2.2.0 对隔离实例做授权自测，修复了进程崩溃、XFF 限速绕过、SSH SSRF、CSRF/Origin、会话校验等问题，详见 [SECURITY.md](SECURITY.md)。

**公网前最少做三件事**：设置强 `ACCESS_PASSWORD`、`REQUIRE_AUTH=true`、只通过 HTTPS 暴露；然后按 [SECURITY.md](SECURITY.md) 的清单逐项检查。

## 测试与构建

```sh
# Web
pnpm type
pnpm lint
pnpm build

# Server
cd server
pnpm type
pnpm test
pnpm lint

# Mobile（完整步骤见 mobile/README-MYAGENT.md）
cd mobile/android
./gradlew :app:assembleDebug -x buildWeb
```

服务端测试覆盖压缩窗口、记忆围栏、工作区路径校验等核心移植逻辑。

## 许可证与致谢

- **Web / 服务端**：MIT，见 [LICENSE](LICENSE)。
- **Android**：GPL-3.0-or-later（衍生自 [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)），见 `mobile/package.json`。
- UI 基座：[DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）。
- 记忆与压缩：[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)；Honcho 插件：[plastic-labs/honcho](https://github.com/plastic-labs/honcho/tree/main/hermes-plugin-honcho)。
- Agent 工具概念参考：[anthropics/claude-code](https://github.com/anthropics/claude-code)。
- 模型与 API：DeepSeek（`deepseek-flash` / `deepseek-v4-pro`）。
- **商标声明**：本项目使用 DeepSeek 的金鱼 LOGO 仅作标识，不代表 DeepSeek 官方；完整声明见 [NOTICE.md](NOTICE.md)。
- 第三方依赖遵循各自许可证；分发时请保留 `LICENSE` 与依赖声明。

---

<p align="center"><sub>WyDeepSeek · 让个人 Agent 跑在自己的服务器上</sub></p>
