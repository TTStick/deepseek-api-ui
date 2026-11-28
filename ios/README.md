# WyDeepSeek iOS

Android 版 **WyDeepSeek**（`mobile/`）的 iOS 1:1 复刻：同一份 React 构建产物运行在 WKWebView 中，
原生层用 Swift 重写 Keychain、SQLite 会话存储、流式 HTTP、录音、相册、导出、内置浏览器与内置 Tailscale。

- 应用名：**WyDeepSeek**
- Bundle ID：`io.github.wydeepseek.app`
- 最低系统：iOS 16.0（与 Web 构建的 `safari >= 16` 对齐）
- 版本：0.10.4（与 Android `versionName` 一致）
- 分发：自签名 / 开发者模式；未针对 App Store 做合规改造（见文末）

## 截图

| 首屏 | 聊天 | 长按菜单 |
| --- | --- | --- |
| ![首屏](screenshots/01-onboarding.png) | ![聊天](screenshots/03-chat.png) | ![长按菜单](screenshots/05-longpress-menu.png) |

| 自绘选区 | 键盘 | 抽屉 |
| --- | --- | --- |
| ![选区](screenshots/06-selection.png) | ![键盘](screenshots/04-keyboard.png) | ![抽屉](screenshots/07-drawer.png) |

| 设置 | 账号 / Tailscale | 附件面板 |
| --- | --- | --- |
| ![设置](screenshots/08-settings.png) | ![Tailscale](screenshots/10-tailscale-status.png) | ![附件](screenshots/11-attachments.png) |

| 内置浏览器 | 历史导出 | 服务器模式 |
| --- | --- | --- |
| ![浏览器](screenshots/12-browser.png) | ![导出](screenshots/13-export.png) | ![服务器模式](screenshots/15-server-mode.png) |

**真实 NAS 的内置 Tailscale 端到端验收**（App → tsnet 隧道 → NAS → 真实模型 → 流式回复）：

| 隧道启动 | 隧道就绪 | 隧道内登录成功 | 真实模型回复 |
| --- | --- | --- | --- |
| ![启动](screenshots/17-tailscale-starting.png) | ![就绪](screenshots/18-tailscale-ready.png) | ![登录](screenshots/19-tailscale-connected.png) | ![回复](screenshots/20-tailscale-reply.png) |

| 图片发送 / 保存相册 | 深色模式 |
| --- | --- |
| ![图片保存](screenshots/21-image-saved.png) | ![深色](screenshots/22-dark.png) |

**iPad 横屏**（仅 iPad，原生 `isTablet` → `data-ios-tablet`）：

| 侧栏展开 / 无会话空态 | 收起侧栏（全宽输入框） | 居中设置模态 |
| --- | --- | --- |
| ![iPad 侧栏](screenshots/23-ipad-landscape-sidebar.png) | ![iPad 收起](screenshots/24-ipad-landscape-collapsed.png) | ![iPad 设置](screenshots/25-ipad-settings-modal.png) |

**iPad 详细状态验收**（原生 `simctl` 截图，覆盖设置子页/附件/深色/键盘/竖屏回落）：

| 欢迎页 / 侧栏空态 | 附件面板（6 列照片） | 深色设置 | 旋转回竖屏（手机布局） |
| --- | --- | --- | --- |
| ![iPad 欢迎](screenshots/26-ipad-welcome.png) | ![iPad 附件](screenshots/27-ipad-attachments.png) | ![iPad 深色](screenshots/28-ipad-dark-settings.png) | ![iPad 竖屏](screenshots/29-ipad-portrait.png) |

## 架构

```
Gradle/Android                          iOS
─────────────────────────────────────   ─────────────────────────────────────────────
WebView + https://appassets…            WKWebView + http://127.0.0.1:8100
  shouldInterceptRequest                 内嵌 HTTPServer (Network.framework)
  assets / chat-attachment / recording   Bundle/WebApp + ChatFiles + NativeRecorder
  /recent /thumbnail                     PhotoLibrary
@JavascriptInterface（同步）              WKUIDelegate prompt 同步桥 (bridge.js)
evaluateJavascript CustomEvent           evaluateJavaScript CustomEvent
Keystore AES/GCM                        Keychain
SharedPreferences profile               UserDefaults
SQLite (ChatStorage.java)               SQLite (ChatStorage.swift，同 schema/协议)
HttpURLConnection                       URLSession（逐块 base64）
AudioRecord                             AVAudioRecorder（模拟器用合成 WAV）
MediaStore                              PHAsset / PHPhotoLibrary
SAF ACTION_CREATE_DOCUMENT             临时文件 + UIDocumentPicker（完成后弹出）
SourceBrowserActivity                   独立 WKWebView 的 SourceBrowserViewController
tsnet AAR + 前台服务                     tsnet XCFramework（仅前台运行）
```

**为什么固定使用 8100 端口？**
MyAgent 服务端的默认 CORS 白名单是
`https://appassets.androidplatform.net,http://localhost:8100,http://127.0.0.1:8100`
（`server/src/env.ts` 的 `CORS_ORIGINS`）。WKWebView 的文档源固定为
`http://127.0.0.1:8100`，因此服务器模式无论是直连还是经 Tailscale 代理，都能通过 CORS，
不需要改服务端。若你自定义了 `CORS_ORIGINS`，请保留 `http://127.0.0.1:8100`
以及 Android 的 `https://appassets.androidplatform.net`。

**为什么用 `prompt()` 做桥？**
页面里的 40+ 个桥方法全部是同步调用（例如启动时 `readApiKey()`、每次存储 `chatStorage()`）。
WKWebView 没有同步的 message handler。这里在 `documentStart` 注入 `bridge.js`，把每个方法编码进
`window.prompt()`；`WKUIDelegate.runJavaScriptTextInputPanelWithPrompt` 在主线程同步执行并返回 JSON。
这样 Web 代码零改动，也不会像本地 HTTP 桥那样把 API Key 暴露给同机其他 App。

## 目录

```
ios/
├─ project.yml                       # xcodegen 工程定义
├─ WyDeepSeek/
│  ├─ App/                           # AppDelegate / SceneDelegate / AppServices
│  ├─ Web/                           # WebViewController / Bridge / HTTPServer
│  ├─ Native/                        # Keychain、SQLite、录音、相册、导出、流式、Tailscale、浏览器
│  ├─ Resources/                     # bridge.js、longpress.js、errorlog.js、Info.plist、图标
│  └─ WebApp/                        # 构建时从 mobile/dist 同步（git 忽略）
├─ WyDeepSeekUITests/                # 端到端 UI 测试
├─ Frameworks/Tsproxy.xcframework    # 由 scripts/build-tsproxy.sh 生成（git 忽略）
├─ scripts/                          # build-web.sh / build-tsproxy.sh / mock-server.mjs
└─ screenshots/                      # 验收截图
```

## 构建

### 依赖

- macOS + Xcode 26/27（本机验证：Xcode 27.2，iOS 27.2 模拟器）
- Node.js 22+ 与 pnpm 9+
- [xcodegen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）
- Go 1.27+ 与 gomobile（仅重新构建内置 Tailscale 时需要）

```bash
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init
```

### 一次性准备

```bash
# 1. Web 产物（Xcode 的 pre-build phase 也会自动执行，可跳过）
cd mobile
pnpm install --no-frozen-lockfile
pnpm build
cd ..

# 2. 内置 Tailscale（工程默认链接该 XCFramework；未生成时请先执行本脚本，
#    或从 project.yml 删除该 framework 依赖以走 canImport 回退）
cd ios
./scripts/build-tsproxy.sh

# 3. 生成工程
xcodegen generate
open WyDeepSeek.xcodeproj
```

Xcode 的 **Build Web Assets** pre-build phase 会执行 `pnpm build` 并把 `mobile/dist` 同步到
`ios/WyDeepSeek/WebApp`。若已手动构建并想跳过：

```bash
SKIP_WEB_BUILD=1 xcodebuild ...
```

### 模拟器

选择 iPhone 或 iPad 模拟器直接 Run。**不要用 `CODE_SIGNING_ALLOWED=NO` 构建后测试登录/Keychain**：
未签名的模拟器 App 会拿不到 Keychain 权限，API Key / ChatConfig 写入失败（`errSecMissingEntitlement`）。
Xcode 默认的 ad-hoc 签名即可。

### 真机

1. 在 Xcode 的 Signing & Capabilities 中选择你的 Team（或在 `project.yml` 设置 `DEVELOPMENT_TEAM`）。
2. 确保 `ios/Frameworks/Tsproxy.xcframework` 已生成；工程会 Embed & Sign。
3. 首次连接局域网服务器时，系统会询问“本地网络”权限（iOS 平台要求）。

已验证 `Release / iphoneos`（arm64，无签名）可以编译通过。

## 功能对照

已实现并可在模拟器验证：

- **UI**：服务器模式首屏、聊天页、抽屉、840dp 分栏断点、设置全部子页、附件面板、自绘文字选择、
  长按菜单、图片查看器、内置浏览器、Toast/对话框。
- **会话**：原生 SQLite 双槽（active/staging）、事务式导入/替换/合并、附件引用计数与垃圾回收、
  WAL + `synchronous=FULL`、附件按 UUID 流式读取。
- **密钥/配置**：Keychain 保存 API Key 与自定义 endpoint 配置；UserDefaults 保存账号资料。
- **请求**：自定义 OpenAI/Anthropic/Responses endpoint 走原生 URLSession 流式转发；
  服务器模式与官方 DeepSeek 直连走页面 `fetch`（与 Android 相同的分支）。
- **媒体**：最近 20 张照片（PHAsset）、224px 缩略图、HEIC→JPEG、相册保存、拍照/文件选择（系统 UI）。
- **语音**：按住说话、电平动画、16k/mono/16-bit WAV、`/recording.wav` 一次性下发。
- **导出**：历史 ZIP 分块写入 + Files 文档选择器（干净文件名）。
- **内置浏览器**：独立 WKWebView（不注入桥）、工具栏/进度/错误重试/外部浏览器、edge-swipe 历史返回。
- **内置 Tailscale**：tsnet userspace 节点 + 127.0.0.1 代理、浏览器登录链接、状态轮询、停止/重启。
  已在真实 NAS 上跑通完整链路：App 内启动隧道 → 节点 `wydeepseek-2`（`100.121.217.5`）就绪 →
  App 经 `127.0.0.1` 代理登录 NAS（`100.104.209.43:8000`）→ 真实模型流式回复。
- **系统适配**：安全区 insets、键盘收缩 + `data-keyboard`、状态栏深浅色、图片查看器全屏、
  禁用整页缩放/回弹/链接预览、长按合成 `contextmenu`、禁用原生文本选择菜单。
- **iPad 横屏**：≥840px 时左侧对话栏常驻、左上/右上悬浮胶囊 Header、近全宽输入框、居中设置模态、
  无会话空态；通过原生 `isTablet` + `data-ios-tablet` 仅对 iPad 生效，Android/iPhone 保持原布局。
  设置子页、附件面板、长按菜单/自绘选区、深色模式、键盘态与旋转回竖屏已在 iPad 上逐状态验证。
- **表单输入**：为保留自定义长按选区，WKWebView 默认关闭原生文本交互；输入框在 `pointerdown`
  阶段动态开启、失焦后关闭，服务器地址/密码与搜索框可正常键入，聊天消息仍走自绘选区。

自动化 UI 测试覆盖（`ios/WyDeepSeekUITests`，共 15 项：13 项 iPhone + 2 项 iPad-only）：

1. `testStreamingReplyAndNativeStorage`：流式回复 + Markdown 代码块 + 原生 SQLite 落库
2. `testKeyboardDrawerSettingsAndSelection`：键盘位置、长按菜单、自绘选区、抽屉、设置
3. `testSessionPersistsAcrossRelaunch`：杀进程重启后会话仍在
4. `testAttachmentPanel`：附件面板与最近照片
5. `testOpenInAppBrowser`：Markdown 外链的内置浏览器
6. `testVoiceRecording`：语音模式 + `/recording.wav`
7. `testHistoryExportPicker`：历史导出文档选择器
8. `testServerModeAndTailscale`：服务器模式（mock `/api/chat` SSE）+ Tailscale 开关
9. `testEnglishServerChatParity`：英文界面与 Android 的逐屏对照
10. `testPhotoMessageViewerAndSave`：发送图片 → 图片查看器 → 保存到系统相册
11. `testTailscaleLoginThroughTunnelToNAS`：**真实 NAS 端到端**
    （启动隧道 → 授权/复用节点 → 隧道内登录 → 真实模型回复）
12. `testIPadLandscapeLayout`（iPad 模拟器专属）：侧栏空态、胶囊 Header、收起侧栏后输入框变宽、
    居中设置模态与关闭 X
13. `testIPadDetailedUI`（iPad 模拟器专属）：欢迎/聊天/设置根页与账号/数据/消耗子页/附件面板/
    长按菜单/自绘选区/深色设置与深色聊天/键盘/旋转回竖屏手机布局的逐状态验收
14. `testServerLoginTyping`：服务器登录页真实键入服务器地址与访问密码
    （覆盖 `isTextInteractionEnabled` 动态切换，防止 iOS 输入框“有键盘无文字”回归）
15. `testSearchTyping`：抽屉搜索框自动聚焦后键入，验证程序化焦点下的输入

## 测试

```bash
# 1. 启动 mock 后端（同时支持 OpenAI 与 Anthropic SSE）
node ios/scripts/mock-server.mjs &

# 2. 给模拟器预授权（避免系统弹窗干扰）
xcrun simctl privacy booted grant photos io.github.wydeepseek.app
xcrun simctl privacy booted grant microphone io.github.wydeepseek.app

# 3. 只跑 mock 测试（不需要 NAS / tailnet）
xcodebuild test -project ios/WyDeepSeek.xcodeproj -scheme WyDeepSeek \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath ios/build \
  -skip-testing:WyDeepSeekUITests/BridgeUITests/testTailscaleLoginThroughTunnelToNAS

# 4. iPhone 完整回归（15 项；2 项 iPad-only 用例自动 skip；含真实 NAS 隧道）
xcodebuild test -project ios/WyDeepSeek.xcodeproj -scheme WyDeepSeek \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath ios/build

# 5. iPad 横屏布局 + 详细状态（只跑 2 项 iPad 专属用例，需要 mock 后端）
xcrun simctl boot "iPad Pro 11-inch (M5)" || true
xcodebuild test -project ios/WyDeepSeek.xcodeproj -scheme WyDeepSeek \
  -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5),OS=27.2' \
  -derivedDataPath ios/build \
  -only-testing:WyDeepSeekUITests/BridgeUITests/testIPadLandscapeLayout \
  -only-testing:WyDeepSeekUITests/BridgeUITests/testIPadDetailedUI
```

真实 NAS 测试使用 `NAS_TEST_URL`（默认 `http://100.104.209.43:8000`）和
`NAS_TEST_PASSWORD`；未设置密码时该用例会自动 skip。请在 Xcode Scheme 的 Test 环境变量或
命令行中提供密码，不要把真实密码写入源码。该测试会在 NAS 上创建一条
“Tailscale 隧道验证”会话（`tailscale-ready`/`tailscale-connected`/`tailscale-reply` 截图即来自这次真实运行）。

测试通过 `SIMCTL_CHILD_DSW_SEED_*` / `launchEnvironment` 注入调试配置（仅 DEBUG 编译）：

| 变量 | 作用 |
| --- | --- |
| `DSW_SEED_CHAT_ENDPOINT` | 写入 Keychain 的自定义 endpoint，直达聊天页 |
| `DSW_SEED_CHAT_KEY` / `DSW_SEED_CHAT_MODEL` | 对应的 key / model |
| `DSW_SEED_SERVER_URL` + `DSW_SEED_SERVER_TOKEN` | 预置服务器模式（localStorage） |
| `DSW_SEED_SERVER_INPUT` + `DSW_SEED_SERVER_PASSWORD` | 预填首屏服务器地址/密码（走 `input` 事件，不改生产逻辑） |
| `DSW_SEED_TUNNEL_TARGET` | 启动内置 Tailscale 并打印状态/登录链接 |
| `DSW_SEED_LOCALE` / `DSW_SEED_THEME` | 预置语言（zh-CN/en-US）/主题 |
| `DSW_RESET_CONFIG` | 清理 Keychain 与 localStorage，回到首屏 |

## Android / iOS UI 对照

两端加载的是同一份 `mobile/dist`。对照图在 [`screenshots/parity/`](screenshots/parity/)：

| 屏幕 | Android | iOS |
| --- | --- | --- |
| 首屏 | ![android](screenshots/parity/android-onboarding.png) | ![ios](screenshots/parity/ios-onboarding-en.png) |
| 聊天 | ![android](screenshots/parity/android-chat.png) | ![ios](screenshots/parity/ios-chat-en.png) |
| 抽屉 | ![android](screenshots/parity/android-drawer.png) | ![ios](screenshots/parity/ios-drawer.png) |
| 设置 | ![android](screenshots/parity/android-settings.png) | ![ios](screenshots/parity/ios-settings.png) |
| 附件 | ![android](screenshots/parity/android-attachments.png) | ![ios](screenshots/parity/ios-attachments.png) |
| 长按菜单 | ![android](screenshots/parity/android-longpress.png) | ![ios](screenshots/parity/ios-longpress.png) |

逐屏对比结论：标题/字段/按钮/间距/图标/气泡/代码块/附件网格/长按菜单一致。差异仅来自平台：
iOS 状态栏更高导致内容整体下移约 30–40pt、字体为 SF 而非 Roboto、系统键盘/选择器/权限弹窗不同、
底部为 Home Indicator 而非 Android 手势条。

## 与 Android 的行为差异（平台限制）

1. **Tailscale 不能后台常驻**：iOS 没有 Android 的 `specialUse` 前台服务。App 进入后台后隧道随进程挂起；
   设置页里的提示文案（“开启后会常驻一个前台服务、退到后台也能保持连接”）是从 Android 复用的，
   在 iOS 上不成立。前台聊天不受影响。
2. **键盘上方多一条系统表单辅助栏**（^ v ✓）：这是 iOS 27 的 WebKit/键盘系统 UI。已清空
   `inputAssistantItem` 的按钮组，但该栏仍会出现；Android 没有这一条。
3. **系统选择器不同**：照片、文件、导出、权限弹窗都是 iOS 原生 UI，外观与 Android 系统 UI 不同；
   应用内页面保持 1:1。
4. **首次局域网连接**会多一个 iOS“本地网络”授权弹窗。
5. **无 APK 自更新**：iOS 不允许自更新；这个 fork 的 Android UI 本来也没有更新入口，仅保留版本信息。
6. **模拟器录音**使用合成 WAV（模拟器 CoreAudio 输入在无音频设备时会阻塞/abort）；
   真机走 `AVAudioRecorder` 真实录音。
7. **返回手势**：iOS 没有系统返回键/预测性返回；页面内返回按钮可用。为避免与抽屉手势冲突，
   已关闭 WKWebView 的 interactive back swipe。
8. **iPad 布局边界**：iPad 11" 竖屏（834px）保持手机式抽屉 + 全屏设置；iPad 横屏（1210px）与
   13" 竖屏（1024px）使用平板布局。平板视觉通过 `isTablet`/`data-ios-tablet` 仅 iOS 生效，
   Android 平板/手机与 iPhone 保持原布局。设置页保留本 fork 的“消耗/版本 0.10.4”，
   不添加官方参考图里的“检查更新 2.71.2”。

## 安全说明

- 同步桥只注入主 WKWebView；外链页在独立 WKWebView 中打开，**不注入 `DeepSeekAndroid`**。
- 本地 HTTP 服务尝试只绑定回环地址；动态数据路由（附件/录音/照片）要求每个进程随机生成的 Cookie。
- API Key / ChatConfig 存 Keychain（`AfterFirstUnlockThisDeviceOnly`）；会话目录排除 iCloud 备份，
  对齐 Android 的 `allowBackup=false`。
- `NSAllowsArbitraryLoads` 仅为自建局域网 HTTP 服务器保留；`serverLogin` 仍会拒绝公网 HTTP 地址。
- 同步桥在读取超大会话时会短暂阻塞 Web 线程（与 Android 的同步 `@JavascriptInterface` 一致）。

## 许可证

本项目是 `mobile/`（GPL-3.0-or-later，派生自 `deepseek-app-replica` / DeepSeek `chat-demo`）的
iOS 移植，复用其 Web 构建与设计。分发二进制时需同时提供对应源码并保留原始版权/NOTICE。
由于 GPL-3.0 与 App Store 条款存在冲突，当前仅面向自签名/开发者模式分发。
