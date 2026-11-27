# WyDeepSeek 手机 App（Android）

基于 [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)（GPL-3.0）改造：
UI 与本地会话存储保持不变，新增「服务器模式」——把模型请求发送到自建 MyAgent 后端，
由后端统一处理 **模型、长期记忆、上下文压缩、服务端 Agent 工具**。手机端无需填写 DeepSeek Key。

## 使用方式

1. 安装 `WyDeepSeek-debug.apk`（Android 9+）。
2. 首次打开直接填写 **服务器地址** 与 **访问密码**（手机端是网页版的客户端，默认走服务器；也可在首屏切换为 DeepSeek Key 直连）。
3. 填写：
   - **服务器地址**：`http://<电脑局域网 IP>:8090`（例如 `http://192.168.1.10:8090`）
   - Tailscale / CGNAT 网段（`100.64.0.0/10`，如 `http://100.104.209.43:8000`）同样允许 HTTP，无需证书
   - 公网部署必须使用 `https://你的域名`；不要用公网 HTTP，否则密码、token 与聊天内容会明文传输
   - 手机端登录只发送 `x-myagent-client: mobile` 请求头获取 Bearer token，网页端只使用 HttpOnly Cookie
   - **访问密码**：Web 端「设置 → 数据管理 → 访问密码」里设置的密码（服务器未设密码可留空）
4. 点击「连接」。连接成功后可在「设置 → 账号管理 → 服务器」里看到：
   - 当前服务器地址、重新连接与断开
   - **Agent 模式**开关：允许服务器代写文件、运行 Python 等（文件保存在服务器工作区，可在 Web 端查看）
   - **长期记忆**开关：从记忆库召回偏好与历史，并把本对话写入记忆
5. 回到聊天页即可对话；所有请求经服务器转发，手机只保存本地会话。

> 手机端作为网页客户端，不再包含独立 App 的「检查更新 / 服务协议 / 帮助与支持」，账号页也不再要求填写 DeepSeek API Key，而是配置服务端地址。

## 内置 Tailscale（无需系统 VPN）

从 0.10.0 起 App 内置了一个 userspace 的 Tailscale 节点（`tsnet`）：

- **只有本 App 发往服务器的请求走隧道**：不建立 VpnService、不接管设备流量、没有 VPN 授权弹窗，也能与其他 VPN/代理共存。
- 实现：`mobile/tsproxy`（Go + gomobile）编译成 `tsproxy.aar`，在 `127.0.0.1` 起一个本地回环 TCP 代理，每条连接经 WireGuard 隧道转发到服务器；网页层只要把请求地址切到该代理即可，服务端无感。
- 节点身份与密钥状态持久化在 App 私有目录，重启后自动恢复，无需重复授权。

使用（浏览器登录，推荐 —— 与官方客户端一致，不需要管理 Auth Key）：

1. App「设置 → 账号管理 → 内置 Tailscale」打开开关。
2. 服务器地址保持 tailnet 地址（如 `http://100.104.209.43:8000`），点「启动隧道」。
3. 点「浏览器登录 Tailscale」，在打开的页面完成授权（也可以在别的设备的浏览器打开同一链接）。
4. 授权后 App 自动变为就绪（显示本节点 `100.x.x.x`），之后正常「连接」服务器即可。

节点密钥（node key）保存在 App 私有目录，**下次启动无需再登录**；只有在管理台
撤销设备 / 密钥过期时才需要重新授权一次（可在管理台对该设备关闭 key expiry）。

无人值守场景可选填 Auth Key（`tskey-auth-...`，App 内「Auth Key（可选）」），
此时不需要浏览器交互，仅首次注册用到。

重新构建 AAR（修改了 `mobile/tsproxy` 之后）：

```sh
cd mobile/tsproxy
ANDROID_HOME=$HOME/Library/Android/sdk \
ANDROID_NDK_HOME=$HOME/Library/Android/sdk/ndk/28.2.13676358 \
./build-aar.sh
```

依赖：Go 1.27+、`gomobile`（`go install golang.org/x/mobile/cmd/gomobile@latest && gomobile init`）、Android NDK。

## 跨端会话同步

手机端与网页端共用服务端会话库（`/app/data/sessions`），不是两套独立历史：

- 启动、回到前台、每 30 秒自动拉取网页端/其他设备的会话；本地保存后约 1 秒推送。
- 会话列表、标题、消息、分支、压缩状态、分组/归档、Agent/记忆/压缩开关都会同步。
- 任意一端删除会话，另一端会通过服务端墓碑同步删除；离线删除会在恢复网络后补发。
- 未连接服务器时仍可本地使用，重新连接后自动补传。
- 附件原件不跨设备同步（消息中保留文件信息）；Agent 交付文件在服务端工作区，两端都可查看。

## 与网页端同步的会话功能

- **输入框开关**：服务器模式下与网页端一致显示「深度思考 / 智能搜索 / Agent」三个开关。
  Agent 按会话生效；新对话页切换后会在首条消息创建会话时应用。关闭 Agent 会回收服务端工作区。
- **侧边栏分区**：置顶（Android 抽屉）→ 今天/昨天/7 天内/30 天内/按月 → 自定义分组 →「已归档」折叠区。
  会话菜单新增「移动到分组」（可新建分组/移出分组）、「复制对话」与「归档/取消归档」。
- **回溯重聊**：历史用户消息可「回溯到此处」，确认后删除其后的消息并重新提问。
- **上下文统计**：顶栏圆环显示当前上下文占 128K 窗口的比例（≥70% 变黄、≥90% 变红），点击打开
  「上下文与用量」面板：累计输入/输出、缓存读取、已压缩轮数。
- **消耗统计**：设置 → 消耗，展示账户余额、Token 总消耗（输入/输出/缓存）、请求次数、生成速度
  （tokens/s）、最近 7 天用量，以及按余额变化估算的平均成本；手机端和网页端读取同一份服务端统计。
- **手动压缩**：面板内「立即压缩」调用服务器强制压缩；压缩后历史消息仍完整保留，
  消息列表在归档边界显示「上下文已压缩（N 轮）」分隔条，可展开查看摘要。
- **会话级开关**：Agent 模式、长期记忆读取/写入、上下文压缩均可按对话覆盖服务器默认值，随会话持久化。
- **记忆可视化**：「记忆库」展示 Honcho 归纳的用户画像、用户卡片、AI 自画像与结论，可删除单条结论；
  回复中若本轮召回记忆，会显示「🧠 已召回 N 段记忆」可展开面板。
- **工作区文件**：Agent 会话可浏览服务器工作区文件树，预览文本/图片并保存文件。
- **导出**：Markdown 本地生成；PDF/HTML 由服务器转换。Android 上使用系统文件选择器保存。

> 注意：服务器模式使用 HTTP 明文（局域网），已开启 `usesCleartextTraffic`。
> 如需公网访问，请在服务器前加 HTTPS 反代并改用 https 地址。

## 服务器端准备

- `server/.env` 或项目根 `.env` 配置 `DEEPSEEK_API_KEY`（手机不自带 Key）。
- Web 端设置一个访问密码（也可在 `.env` 设 `ACCESS_PASSWORD` 首次生效）。
- 手机与电脑在同一局域网，且 8090 端口可访问（Windows 防火墙放行）。

## 构建 APK

环境（WSL Ubuntu 已验证）：

```sh
# JDK 17 + Android SDK（platforms;android-37.0 + build-tools;37.0.0）
sudo apt-get install -y openjdk-17-jdk-headless
# SDK 安装到 /opt/android-sdk（见根目录 DOCKER.md 或本机环境）

# 1) 构建前端产物（可用 Docker，避免在 WSL 装 Node）
docker run --rm -v "$PWD/mobile:/app" -w /app node:24-bookworm-slim \
  sh -c "npm i -g pnpm@12.6.0 && pnpm install --frozen-lockfile && pnpm build"

# 2) 打包 APK（-x buildWeb 跳过容器内 pnpm 调用，直接使用上一步的 dist）
cd mobile/android
export ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
echo "sdk.dir=/opt/android-sdk" > local.properties
./gradlew :app:assembleDebug -x buildWeb
```

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`

## 测试与排错

```sh
# 服务器接口连通性（返回 ok 即正常）
curl http://<服务器地址>:8090/api/mobile/ping

# 登录并拿 token
curl -X POST http://<服务器地址>:8090/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"你的密码"}'
```

- **连接失败**：确认地址带 `http://`、端口 8090、防火墙放行；服务器未设密码时密码留空。
- **登录已失效**：token 有效期 30 天，重新在「设置 → 账号管理 → 服务器」点连接即可；服务器修改密码后旧 token 会失效。
- **图片/附件上传**：服务器模式下附件仍直连 DeepSeek Files API，需要在设置里额外填入 DeepSeek Key；
  纯文本聊天与 Agent 不受影响。
- **小米/红米（HyperOS/MIUI）安装**：`adb install` 会报 `INSTALL_FAILED_USER_RESTRICTED`。
  解决办法：`adb push` 到 `/sdcard/Download/`，在手机上用文件管理器点击 APK 安装，
  首次会弹「是否允许 Shell 安装应用」，勾选「记住我的选择」并允许即可（后续 `adb install -r` 直接可用）。
- **网络限制**：APK 已允许 WebView 混合内容（HTTPS 本地页 → HTTP 局域网服务器），
  并在 CSP 中放开 `connect-src http: https:`；旧版本会报 `Failed to fetch`。

## 已验证环境

- 手机：小米 25128PNA1C（Android 17 / HyperOS），Wi-Fi 与服务器同网段。
- 已实际验证：连接服务器、模型流式回复、Agent 模式感知工作区工具。
- 客户端功能同步版本（分组/归档、上下文圆环、手动压缩、记忆库、工作区、导出）已在桌面浏览器
  390×844 视口和真机完成测试：分组移动/归档、压缩结果落库与分隔条、记忆/工作区面板、
  Markdown/PDF 导出均通过。
- 跨端会话同步已验证：网页端与手机端会话互相出现、消息内容一致、任一端删除另一端同步消失。
  安装命令：`adb install -r WyDeepSeek-debug.apk`。

## 与 Web 端的差异

| 能力 | Web 端 | 手机（服务器模式） |
| --- | --- | --- |
| 模型对话 | ✓ | ✓ |
| 长期记忆读写 | ✓ | ✓ |
| 上下文压缩 | ✓ | ✓ 自动 + 手动；分隔条与摘要 |
| 上下文 token 统计/占用圆环 | ✓ | ✓ |
| 消耗统计（余额/速度/成本） | ✓ | ✓ |
| 会话分组/归档/置顶 | ✓ | ✓（置顶在 Android 抽屉） |
| 会话复制 / 回溯重聊 | ✓ | ✓ |
| 会话级 Agent/记忆/压缩开关 | ✓ | ✓ |
| 记忆可视化（画像/卡片/结论） | ✓ | ✓ |
| 工作区文件树/预览 | ✓ | ✓ 只读浏览 + 保存 |
| 单会话导入（Markdown/HTML） | ✓ | ✓ |
| Agent 工具卡片（折叠/两级展开） | ✓ | ✓ 与网页端一致 |
| 交付文件（缩略图/预览/下载） | ✓ 预览/下载 | ✓ 预览；图片保存到相册，其他文件保存/浏览器打开 |
| 导出 Markdown/PDF/HTML | ✓ | ✓ 系统文件选择器保存 |
| SSH 远程工作区 | ✓ | ✗ 手机端不提供 |
| 会话数据 | 服务端会话库 + 浏览器缓存 | 服务端会话库 + 手机本地缓存（自动双向同步） |
| 附件上传 | ✓ | 需在 App 内额外配置 DeepSeek Key |

## 工具调用卡片

服务器模式下消息内会渲染与网页端一致的 Agent 活动卡片：

- 运行中自动展开，标题显示「正在执行 运行 Python…」；完成后收起为「调用工具 N 步」。
- 一级展开：步骤列表（写入文件 / 运行 Python 等，带状态与参数摘要）。
- 二级展开：单步参数与输出。
- 交付文件独立卡片：图片显示缩略图，点击预览；图片可「保存到相册」，其他文件用系统浏览器打开。
- 图片/文件直链由后端签发（token 放在查询参数中，仅对 `/api/agent/raw` 与 `/api/agent/file` 的 GET 放行）。
