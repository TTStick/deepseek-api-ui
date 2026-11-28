<p align="center">
  <img src="docs/images/readme-hero-en.png" alt="WyDeepSeek · MyAgent — a self-hosted personal AI agent for the web, Android and iOS" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT%20%2B%20GPL--3.0-blue" alt="License">
  <img src="https://img.shields.io/badge/web-React%2018%20%2B%20rspack-1f6feb" alt="Web">
  <img src="https://img.shields.io/badge/server-Fastify%205-000000" alt="Server">
  <img src="https://img.shields.io/badge/Android-9%2B-3ddc84" alt="Android">
  <img src="https://img.shields.io/badge/iOS-16%2B-000000" alt="iOS">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ed" alt="Docker">
  <img src="https://img.shields.io/badge/DeepSeek-deepseek--flash-4d6bfe" alt="DeepSeek">
</p>

> [!IMPORTANT]
> **Unofficial project notice**
>
> This project uses **DeepSeek's goldfish logo** in its UI and documentation solely to identify the integrated model and service. WyDeepSeek (internally **MyAgent**) is an independent third-party self-hosted project and is **not an official DeepSeek product**. It is not affiliated with, endorsed by, sponsored by, or approved by DeepSeek. The DeepSeek name and logo belong to their respective owner. See [NOTICE.md](NOTICE.md).

<p align="center"><strong>Keep your history, memory, context, agent workspace and usage on your own server.</strong></p>

WyDeepSeek is a **single-user, self-hosted agent workspace**, not another chat wrapper. The web app, Android and iOS share one history, long-term memory, compression state, agent workspace and usage ledger: start a conversation on your phone, then continue, branch or export it in the browser — and vice versa.

## One server, three clients

| Client | Stack | What you get |
| --- | --- | --- |
| **Web** | React 18 + rspack | Full workspace: branch / edit / rewind, import/export, agent workspace, SSH remote workspace |
| **Android** | WebView + native SQLite | A phone client on the same React build; server mode, cross-device sync, usage panel |
| **iOS** | WKWebView + Swift native layer | 1:1 port of Android; iPad landscape; built-in Tailscale; self-signed distribution |
| **Server** | Fastify 5 + TypeScript | Memory / compression / agent / sync / auth / usage, encrypted at rest with AES-256-GCM |

> Session storage: IndexedDB on the web, native SQLite on phones, and the server as the encrypted meeting point.

> Phones never store the server's DeepSeek key: text chat, memory, compression and the agent all go
> `phone → your server → DeepSeek`. Only image/file uploads use a DeepSeek key configured in the app
> (via the Files API).

## Contents

- [Screenshots](#screenshots)
- [Core capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Ported features and provenance](#ported-features-and-provenance)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Data and sync](#data-and-sync)
- [API overview](#api-overview)
- [Project layout](#project-layout)
- [Security](#security)
- [Tests and builds](#tests-and-builds)
- [License and acknowledgements](#license-and-acknowledgements)

## Screenshots

> Captured from this repository's simulator and real-device acceptance runs; no visual retouching
> (only account balances are hidden).

### Web workspace

<p align="center">
  <img src="docs/images/web-chat.png" width="760" alt="Web agent workspace">
  <br><sub>Agent tool timeline, delivered files (Markdown / PNG) and Markdown / KaTeX rendering</sub>
</p>

| Usage and cost | Long-term memory and context |
| :---: | :---: |
| <img src="docs/images/web-usage.png" width="380" alt="Usage panel"> | <img src="docs/images/web-memory.png" width="380" alt="Memory and context settings"> |
| Balance, tokens, input / output / cache, speed, last 7 days | Recall status, memory library, compression threshold and per-session switches |

### iPhone

| Chat | Long-press menu | Settings |
| :---: | :---: | :---: |
| <img src="ios/screenshots/03-chat.png" width="230" alt="iPhone chat"> | <img src="ios/screenshots/05-longpress-menu.png" width="230" alt="iPhone long-press menu"> | <img src="ios/screenshots/08-settings.png" width="230" alt="iPhone settings"> |
| Streaming replies, code blocks, floating header pill | Copy / select text / regenerate / read aloud | Account, Tailscale, language, appearance, voice |

### iPad landscape

| Sidebar and empty state | Centered settings modal |
| :---: | :---: |
| <img src="ios/screenshots/23-ipad-landscape-sidebar.png" width="380" alt="iPad landscape sidebar"> | <img src="ios/screenshots/25-ipad-settings-modal.png" width="380" alt="iPad settings modal"> |
| Persistent chat rail, floating header pills, near-full-width composer | 600 × 700 card, backdrop, close X |

| Attachment panel | Dark mode |
| :---: | :---: |
| <img src="ios/screenshots/27-ipad-attachments.png" width="380" alt="iPad attachments"> | <img src="ios/screenshots/28-ipad-dark-settings.png" width="380" alt="iPad dark settings"> |
| Six-column recent photos, camera / library / files | Dark settings and dark chat follow the theme |

> The iPad layout is enabled at ≥840px on iPadOS only; iPhone and Android keep their original layout.
> Native screenshots above show the Chinese UI; all labels follow the app language (see the English
> parity table below). More iOS screenshots and state-by-state acceptance runs live in
> **[ios/README.md](ios/README.md)**.

### Custom selection and native capabilities

| Custom selection | In-app browser | Voice mode |
| :---: | :---: | :---: |
| <img src="ios/screenshots/06-selection.png" width="230" alt="iOS custom selection"> | <img src="ios/screenshots/12-browser.png" width="230" alt="iOS in-app browser"> | <img src="ios/screenshots/14-voice-mode.png" width="230" alt="iOS voice mode"> |
| Blue handles + copy / select-all toolbar | Isolated WKWebView, no bridge injected | Hold to talk, level animation, 16k WAV |

### Android ↔ iOS, screen by screen

Both mobile clients (Android and iOS) load the same `mobile/dist`; differences come from the platform only (status bar height,
SF / Roboto fonts, system pickers and the home indicator).

| Screen | Android | iOS |
| :---: | :---: | :---: |
| Chat | <img src="ios/screenshots/parity/android-chat.png" width="200" alt="Android chat"> | <img src="ios/screenshots/parity/ios-chat-en.png" width="200" alt="iOS chat"> |
| Drawer | <img src="ios/screenshots/parity/android-drawer.png" width="200" alt="Android drawer"> | <img src="ios/screenshots/parity/ios-drawer.png" width="200" alt="iOS drawer"> |
| Settings | <img src="ios/screenshots/parity/android-settings.png" width="200" alt="Android settings"> | <img src="ios/screenshots/parity/ios-settings.png" width="200" alt="iOS settings"> |

### Built-in Tailscale: put the phone directly on your tailnet

iOS embeds **tsnet** (gomobile XCFramework). No Tailscale app and no system VPN are required:
start the node in the app → authorize in the browser → local `127.0.0.1` proxy → reach MyAgent on
your NAS. Verified end-to-end against a real NAS: start tunnel → node ready → log in through the
tunnel → real model streaming reply.

| Starting | Node ready | Logged in through the tunnel | Real model reply |
| :---: | :---: | :---: | :---: |
| <img src="ios/screenshots/17-tailscale-starting.png" width="190" alt="Tailscale starting"> | <img src="ios/screenshots/18-tailscale-ready.png" width="190" alt="Tailscale ready"> | <img src="ios/screenshots/19-tailscale-connected.png" width="190" alt="Logged in through tunnel"> | <img src="ios/screenshots/20-tailscale-reply.png" width="190" alt="Real model reply"> |

## Core capabilities

| Long-term memory (Hermes) | Context compression (Hermes) | Agent workspace |
| :--- | :--- | :--- |
| Each turn rewrites the latest message into a query and recalls user profiles, conclusions and session summaries from Honcho, injected inside a `<memory-context>` fence. Recall details are expandable above the reply. | Near the threshold, middle turns are compressed into a structured summary: **protected head + summary middle + budgeted tail**. History stays intact; only the model projection changes. | Server-side tool loop: file read/write, Python / script execution, delivered-file cards; the web app also supports SSH remote workspaces and a file tree. |

### Chat and content

- Multiple sessions, automatic titles, rename, pin, groups, archive, duplicate.
- Streaming replies, deep thinking, web search, link reading and citations; stop, regenerate, continue.
- Edit user messages, switch message branches, rewind to an earlier message and ask again.
- Markdown, syntax highlighting, KaTeX and Mermaid.
- Image / file attachments, drag-and-drop and paste upload, voice input, read replies aloud.
- Chinese and English UI, light / dark themes, responsive desktop and mobile layouts.
- Markdown / PDF / HTML export; single-session Markdown / HTML import.

### Long-term memory

- **Self-retrieval**: rewrite the latest user message into a query, recall profiles, conclusions and
  session summaries from Honcho, and inject them inside a `<memory-context>` fence.
- **Visible recall**: “Recalled N memories” above the reply, expandable to inspect the injected context.
- **Memory library**: user profile, user cards, AI self-portrait and Honcho conclusions; delete entries individually.
- **Per-session switches**: self-retrieval, recall details and memory read/write can be overridden per session.
- **Async writes**: each turn is written to Honcho in the background; failures are logged and never block chat.

### Context compression

- Default threshold `50% × (context window − max output)`, with a 64K floor; about **327K tokens** on a
  1M window / 393K max output. Tail budget is `min(25K, ctx×2.5%)`.
- Iterative summaries: the previous summary plus new turns are compressed again; on failure a
  deterministic fallback summary is used and compression enters cooldown.
- A “Context compressed (N turns)” divider appears at the archive boundary and can be expanded.
- The header ring shows the share of the 1M window (yellow ≥70%, red ≥90%) and supports manual compression.

```mermaid
flowchart LR
  Head["Protected head<br/>first turn / system prompt"] --> Middle["Summary middle<br/>previous summary + archived turns"]
  Middle --> Tail["Budgeted tail<br/>recent messages (≥20 / ≥1 turn)"]
  Tail --> Model["Sent to the model<br/>summary line + unarchived messages"]
```

### Advanced retrieval (optional)

- **Conversation index**: SQLite FTS over the current conversation so the agent can search older or already-compressed turns.
- **Reference index**: Markdown chunk index over `references/`, returning file paths and line numbers,
  then reading them back with `read_file` `offset/limit`.
- The two switches are independent, live under Settings → Memory & Context, and require agent mode.
- Index files are named by a hash of `sessionId`; tools receive only the current `sessionId` and cannot query across conversations.

### Agent mode

- Per-session agent switch; the session gets its own workspace.
- Server tool loop: `list_files` / `read_file` / `write_file` / `delete_file` / `run_python` / `run_script`.
- Python runs in a container workspace with numpy / matplotlib / pandas / requests preinstalled; matplotlib renders headlessly.
- Delivered-file cards: text preview, image preview, download; the web app can browse the workspace tree.
- The web app supports SSH remote workspaces (password or private key; credentials stay in the current session).
- Tool calls appear in a collapsible timeline — expanded while running, collapsed when done.

### Server settings and encryption at rest

- Settings → **Server**: edit the server DeepSeek key, model allowlist, chat rate limit, agent iteration
  limit, CORS, Honcho URL / credentials, SSH private-host access, proxy trust and forced login.
- Saved to an encrypted `runtime-config.json`, which takes precedence over `.env` and applies immediately.
  Keys and credentials show only “configured / source” and are never echoed back.
- Sessions, compression summaries, references, agent workspace files and SQLite indexes are encrypted at
  rest with **AES-256-GCM**.
- Index queries decrypt into process memory; Python execution uses tmpfs and unprivileged UID 10001.

### Multi-device sync

- The server is the meeting point: web and phones all sync to `/app/data/sessions/`.
- Pull on startup, foreground and every 30 seconds; push about one second after a local save.
- Titles, messages, branches, compression state, groups, archive, pin and per-session switches all sync.
- Deletes propagate as server tombstones; offline deletes are replayed when the network returns.
- Original attachments do not sync across devices (messages keep file metadata); agent deliverables live
  in the server workspace and are visible everywhere.

### Usage and cost

- Settings → **Usage**: balance, total tokens, input / output / cache reads, request count and generation
  speed (tokens/s).
- Last 7 days token bar chart.
- Balance comes from DeepSeek's official `GET /user/balance`, cached for 30 seconds and refreshable.
- Average cost is estimated as “balance change ÷ token delta”; it appears after roughly 20K tokens.
- Web and phones read the same server-side statistics.

## Architecture

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    Web["Web<br/>React 18 + IndexedDB"]
    Android["Android<br/>WebView + SQLite"]
    IOS["iOS<br/>WKWebView + Swift"]
  end

  Proxy["nginx / Caddy<br/>HTTPS · CSP · rate limits"]
  Server["Fastify server<br/>/api"]
  DS["DeepSeek API<br/>deepseek-flash / v4-pro"]
  Honcho["Honcho<br/>memory / user modeling / reasoning"]
  Data[("data volume<br/>sessions · auth · usage")]
  Workspaces[("workspaces volume<br/>agent workspace")]

  Web --> Proxy
  Android --> Proxy
  IOS --> Proxy
  Proxy --> Server
  Server --> DS
  Server --> Honcho
  Server --> Data
  Server --> Workspaces
```

### How one request flows

```mermaid
sequenceDiagram
  autonumber
  participant C as Web / Android / iOS
  participant S as Fastify server
  participant H as Honcho
  participant D as DeepSeek

  C->>S: messages + per-session switches (memory / compression / agent)
  S->>H: query rewrite + self-retrieval
  H-->>S: recalled profiles / summaries / conclusions
  S->>S: compress middle turns when over threshold
  S->>D: summary + tail + memory fence + tools
  D-->>S: SSE (thinking / tool_use / usage)
  S-->>C: memory_recall / context_compressed / delta
  S->>H: async write of this turn (non-blocking)
```

### Multi-device sync

```mermaid
sequenceDiagram
  autonumber
  participant W as Web
  participant A as Android / iOS
  participant S as Server session store

  W->>S: PUT /api/sessions/:id
  A->>S: PUT /api/sessions/:id
  Note over S: last-write-wins on updatedAt
  S-->>W: GET /api/sessions + tombstones
  S-->>A: GET /api/sessions + tombstones
  W->>S: DELETE /api/sessions/:id
  S-->>A: tombstone → delete the local copy
```

## Ported features and provenance

On top of the DeepSeek chat-demo UI base, this project ports the memory and context capabilities of
**Hermes Agent** and takes conceptual inspiration from Claude Code's agent tool model. The baseline is
the `NousResearch/hermes-agent` main branch as of 2026-11. The principle is to **preserve upstream
behavior and semantics while rewriting in TypeScript for a single-user, stateless-proxy architecture**.

<details>
<summary><strong>Expand: capability-by-capability provenance and implementation notes</strong></summary>

| Capability | Upstream | Implementation | Approach and differences |
| --- | --- | --- | --- |
| Self-retrieval / memory recall | Hermes `agent/memory_provider.py`, `agent/memory_context.py`, `plugins/memory/query_rewrite.py`, `session_rules/turns.py`; [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `server/src/memory/{honcho,queryRewrite,trivial,fence}.ts` | Behavior-level Python → TypeScript port: trivial detection, query-rewrite regexes, `<memory-context>` fence, bullet dedupe and cadence backoff all match; multi-provider / cron removed for a single user |
| Context compression | Hermes `agent/context_compressor.py` ([pinned](https://github.com/NousResearch/hermes-agent/blob/b98c388a/agent/context_compressor.py)) | `server/src/compression/{window,prompt,compress,tokens}.ts` | Ported the three-part window, 50% threshold, 64K floor, iterative summaries, `[REDACTED]` credential red line, deterministic fallback and failure cooldown |
| Long-conversation management | Hermes compression archive / token ledger semantics | `src/services/chat/usage.ts`, `server/src/usage.ts`, compression divider in the message list | History stays fully visible while the model projection skips archived turns; usage accrues per turn and compressed-turn counts sync with the session |
| Conversation / reference index | Goose `crates/goose/src/session/chat_history_search.rs`, `services/ask-ai-bot/utils/ai/chunk-markdown.ts`, `services/ask-ai-bot/utils/ai/tools/codebase-search.ts` | `server/src/indexing/{store,chunk}.ts`, `server/src/agent/tools.ts`, `server/src/agent/workspace.ts` | Node's built-in SQLite FTS5, one index per session; added `search_conversation` / `search_references`; `read_file` supports offset/limit |
| Honcho memory backend | [Plastic Labs Honcho](https://github.com/plastic-labs/honcho)'s `hermes-plugin-honcho` | `server/src/memory/honcho.ts`, `server/src/honcho/api.ts`, the honcho profile in `compose.yaml` | Ported session/peer modeling, context + dialectic layers, batch message writes and conclusions; a lightweight client aligned with Honcho v3 REST, single-user, embeddings off by default |
| Rewind and re-ask | Hermes `/rewind` semantics | `src/services/chat/store.ts`, `mobile/src/services/chat/store.ts` | Truncate everything after the target message and ask again; identical behavior on web and phones |
| Agent tool loop | Claude Code's QueryEngine `tool_use / tool_result` loop and session-scoped cwd ([anthropics/claude-code](https://github.com/anthropics/claude-code), conceptual reference) | `server/src/agent/{loop,tools,workspace,ssh}.ts` | Not a source port: TypeScript rewrite of the tool protocol, workspace path validation, isolated Python execution and SSH / SFTP; up to 10 tool round-trips |
| Web UI base | [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT) | `src/` | Kept the chat UI, Markdown / KaTeX / Mermaid, branching and import/export; added the server proxy, memory, compression, agent, usage and auth |
| Android client | [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica) (GPL-3.0) | `mobile/` | Kept its UI and local SQLite storage; added server mode, cross-device sync, agent / memory / compression switches, context ring, usage panel, workspace and export |
| iOS client | 1:1 port of the Android app (original native layer) | `ios/` | WKWebView + Swift: Keychain, double-slot SQLite, URLSession streaming, recording, photos, export, in-app browser, tsnet Tailscale, iPad landscape |
| Usage / balance / cost | Original; balance from DeepSeek's official `/user/balance` | `server/src/usage.ts`, `src/components/settings/UsageSettings.tsx`, `mobile/src/components/usage/UsagePanel.tsx` | Aggregate usage snapshots from sessions; persist balance samples; estimate average cost from balance change |
| Security hardening | Original; hardened after an authorized ARTEX 2.2.0 self-assessment | `server/src/auth.ts`, `routes/auth.ts`, `agent/ssh.ts`, `rateLimit.ts`, `sessions.ts` | scrypt passwords, HMAC cookies / bearer tokens, login / chat rate limits, CSRF Origin checks, SSRF protection, logout revocation, generic errors; see [SECURITY.md](SECURITY.md) |

</details>

**Porting boundaries**

- **Hermes is a behavior-level port, not a line-by-line translation**: thresholds, prompt structure,
  dedupe / cooldown / fallback semantics are preserved; multi-user, cron and provider-plugin discovery are removed.
- **Claude Code is conceptual only**: tool names, loop structure and workspace isolation come from its
  public behavior; no source code was copied.
- **The Android UI comes from a GPL project**: `mobile/` is a derivative of deepseek-app-replica under
  GPL-3.0; the root MIT license primarily covers the web app and server.
- **Honcho is optional**: without the `honcho` profile, chat and compression still work; memory simply
  reports as disconnected.

## Quick start

### Option 1: Docker (recommended)

Prerequisites: Docker Desktop (with Compose) and network access to the DeepSeek API.

```sh
git clone <your-repo> MyAgent
cd MyAgent

# 1) Configure the server key and access password
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-your-deepseek-key
ACCESS_PASSWORD=a-strong-password-at-least-16-chars
REQUIRE_AUTH=true
EOF

# 2) Development mode: web hot reload + server
docker compose up -d --build

# 3) Self-hosted memory (optional but recommended)
docker compose --profile honcho up -d --build

# 4) Production preview (nginx + static build)
docker compose --profile prod up -d --build
```

| Entry | URL | Notes |
| --- | --- | --- |
| Dev frontend | http://localhost:8090 | rspack dev server with hot reload |
| Production preview | http://localhost:8080 | nginx serves `dist/` and proxies `/api` |
| Server | http://127.0.0.1:3000/api/health | Loopback only, for debugging |
| Honcho | Compose network only | `honcho-api` / `deriver` / `db` / `redis` |

```sh
docker compose ps
docker compose logs -f web server
docker compose --profile honcho logs -f honcho-api honcho-deriver
```

> `ACCESS_PASSWORD` only applies on the first start before a password is set in the UI; afterwards the
> scrypt hash in `data/auth.json` is authoritative.

### Option 2: Local development

Requires Node.js 22.12+ and pnpm. Start the web app and server separately:

```sh
# Terminal 1: web
pnpm install
pnpm dev            # http://localhost:8090

# Terminal 2: server
cd server
pnpm install
pnpm dev            # http://127.0.0.1:3000

# Optional: Honcho (Docker)
docker compose --profile honcho up -d --build
```

The web app reaches the server through `/api`. Without Docker, confirm the devServer proxy target in
`rspack.config.ts`, and start Honcho yourself or disable memory.

### Android

The Android client is a WebView app: its UI and local session storage come from deepseek-app-replica,
with server mode added. Full instructions: **[mobile/README-MYAGENT.md](mobile/README-MYAGENT.md)**.

```sh
# Build mobile/dist first, then the debug APK
cd mobile/android
./gradlew :app:assembleDebug -x buildWeb
```

Output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

### iOS

The iOS app is a 1:1 port of the Android app: the same React build runs in a WKWebView, while a Swift
native layer reimplements Keychain, SQLite, streaming HTTP, recording, photos, export, the in-app browser
and built-in Tailscale. Full instructions: **[ios/README.md](ios/README.md)**.

```sh
# 1) Web build
cd mobile
pnpm install --no-frozen-lockfile
pnpm build
cd ..

# 2) Built-in Tailscale XCFramework (first time)
cd ios
./scripts/build-tsproxy.sh

# 3) Generate the project and open it
xcodegen generate
open WyDeepSeek.xcodeproj
```

Select your Team and device in Xcode, then Run. Distribution is **self-signed / developer mode**
(GPL-3.0 conflicts with App Store terms, so no App Store compliance work was done). On a physical device,
trust the developer certificate under **Settings → General → VPN & Device Management** on first launch.

### First connection on a phone

Enter the following on first launch (Android / iOS):

- **Server URL**: `http://<LAN-IP>:8090` (development) or `https://your-domain` (public)
- **Access password**: the password configured on the web app (may be empty if unset)
- Public deployments must use HTTPS; LAN HTTP is only for trusted Wi-Fi.
- Text chat, memory, compression and the agent do not need a phone-side DeepSeek key. **Image / file
  uploads** still use the DeepSeek Files API and require a key configured in the app.

## Configuration

Common root `.env` variables (read by Compose):

| Variable | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | empty | Server fallback key; used by compression summaries, query rewrite, the Honcho deriver and usage / balance |
| `ACCESS_PASSWORD` | empty | Initial access password, at least 10 chars; 16+ recommended for public deployments |
| `REQUIRE_AUTH` | `false` | When `true`, all business APIs are rejected until a password is set; required for public deployments |
| `PUBLIC_DOMAIN` | empty | Domain for Caddy automatic HTTPS |
| `ACME_EMAIL` | empty | Let's Encrypt notification email |
| `PROD_BIND` | `0.0.0.0` | Production bind address; `127.0.0.1` recommended so only Caddy is exposed |
| `TRUST_PROXY` | `true` (Compose) | Enable only when the server is exposed solely through nginx / Caddy that overwrites `X-Forwarded-*` |
| `SSH_ALLOW_PRIVATE_HOSTS` | `false` | Whether the SSH tool may reach private / loopback addresses; off by default to prevent SSRF |
| `CHAT_RATE_LIMIT_PER_MINUTE` | `30` | Per-client chat / compression requests per minute |
| `ALLOWED_MODELS` | `deepseek-flash,deepseek-v4-pro` | Allowed model allowlist |
| `AGENT_MAX_ITERATIONS` | `24` | Agent tool-loop limit per turn; a final tool-less request is sent after the limit |
| `CORS_ORIGINS` | Phone WebViews + local preview | Additional allowed origins, comma-separated |
| `HONCHO_BASE_URL` / `HONCHO_API_KEY` | empty / `local` | Self-hosted Honcho URL and credentials |
| `DATA_ENCRYPTION_KEY` | empty | Optional 32-byte master key (64-char hex / base64); takes precedence over the key file |
| `DATA_ENCRYPTION_KEY_FILE` | `/app/secrets/encryption.key` | Key file path; generated on first start when no env key is provided |
| `EXEC_TMP_ROOT` | `/run/myagent-exec` | Temporary decrypted directory for Python execution; must be tmpfs |

**Runtime settings can be edited in the web UI under Settings → Server.** They are written to the
encrypted server config, take precedence over `.env`, and apply immediately. Ports, HTTPS domains,
encryption key files and build proxies remain Compose-level settings.

See [server/.env.example](server/.env.example) for the full list and [SECURITY.md](SECURITY.md) for the public checklist.

## Data and sync

| Data | Location | Cross-device? |
| --- | --- | --- |
| Web sessions, drafts, original attachments | Browser IndexedDB + localStorage | Sessions sync via the server; original attachments do not |
| Android / iOS sessions | Local SQLite + sidecar metadata | Sync via the server |
| Server sessions / summaries | `myagent_data` volume `/app/data/sessions/` (AES-256-GCM) | Shared by all clients |
| References / workspace | `myagent_workspaces` volume `/app/workspaces/` (encrypted) | Server-side; visible everywhere |
| Search indexes | `myagent_data` volume `/app/data/indexes/` (encrypted; decrypted in memory for queries) | Server-side |
| Encryption master key | `myagent_secrets` volume `/app/secrets/encryption.key` | Server only |
| Password hash / session signing key | `myagent_data` volume `/app/data/` (encrypted with the signing key) | Server only |
| Usage samples | `myagent_data` volume `/app/data/usage-state.json` (encrypted) | Shared by all clients |
| Honcho memory | `myagent_honcho_pgdata` / `myagent_honcho_redis` volumes | Server-side; **still plaintext, use volume-level encryption** |

Server sessions, compression summaries, references, agent workspace files and SQLite FTS indexes are all
encrypted at rest with **AES-256-GCM**. Keys and data live in separate volumes and the key is generated
on first start. **Data is unrecoverable if the key is lost** — back up the `myagent_secrets` volume.
Browser IndexedDB, phone SQLite and Honcho's Postgres / Redis are outside this application-level encryption.

Sync is **last-write-wins**: clients write `updatedAt` and the server only accepts newer versions. Deletes
write tombstones; clients delete local copies after pulling them. The server validates session structure
(message arrays, finite timestamps, nesting ≤200 levels, ≤20K messages) and strips `ssh` credentials.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/chat` | Web SSE chat (memory recall, compression, agent, usage) |
| `POST` | `/api/mobile/messages` | Phone chat (same pipeline) |
| `POST` | `/api/chat/complete` | Turn completion, async memory write |
| `POST` | `/api/compress` | Manual context compression |
| `GET/PUT/DELETE` | `/api/sessions`, `/api/sessions/:id` | Session list / read / sync / delete |
| `GET` | `/api/usage` | Tokens, speed, balance and cost |
| `GET/POST/DELETE` | `/api/agent/*` | Workspace tree, files, SSH test, references |
| `GET/DELETE` | `/api/memory/*` | Memory status, conclusions list / delete |
| `GET/PUT` | `/api/server-config` | Runtime server config (keys are never echoed) |
| `POST` | `/api/auth/login`, `/api/auth/logout`, `/api/auth/password` | Login / logout revocation / password change |
| `POST` | `/api/export/*` | Markdown / PDF / HTML export |

Except for `/api/health`, `/api/auth/status` and `/api/auth/login`, business APIs require a cookie or
`Authorization: Bearer`. Phone login uses `x-myagent-client: mobile` to obtain a bearer token.

## Project layout

```text
.
├── src/                     # Web frontend (React 18 + rspack)
│   ├── components/          # chat, sessions, agent, memory, settings
│   ├── services/            # API, SSE, IndexedDB, sync, export
│   └── i18n/                # Chinese and English strings
├── server/                  # Fastify + TypeScript server
│   └── src/
│       ├── agent/           # tool loop, workspace, SSH
│       ├── compression/     # Hermes compression port
│       ├── memory/          # Hermes / Honcho memory port
│       ├── routes/          # chat / sessions / auth / usage / export
│       ├── sessions.ts      # server session store, tombstones, validation
│       └── usage.ts         # tokens / balance / cost
├── mobile/                  # Android WebView client (GPL-3.0 derivative)
├── ios/                     # iOS client (WKWebView + Swift native layer)
│   ├── WyDeepSeek/          # App / Web / Native / Resources
│   ├── WyDeepSeekUITests/   # end-to-end UI tests
│   └── screenshots/         # iOS acceptance screenshots
├── docker/                  # nginx / Caddy configuration
├── docs/images/             # README screenshots, banners and logo
├── compose.yaml             # web / server / honcho / prod / public
├── SECURITY.md              # security assessment, hardening, public checklist
├── NOTICE.md                # trademark and unofficial-project notice
└── DOCKER.md                # Docker development and deployment details
```

## Security

- Single-user access password: scrypt hashing, HMAC-signed cookies / bearer tokens, login rate limiting,
  key rotation on password change and logout revocation.
- Public deployment: `REQUIRE_AUTH=true`, HTTPS (Caddy automatic certificates), expose only 80/443, never
  map 8090 / 3000.
- API protections: CORS allowlist, CSRF Origin checks, chat / compression / SSH rate limits, SSRF private-host
  blocking, generic errors and session structure validation.
- **Encryption at rest**: sessions, references, workspaces and search indexes are AES-256-GCM encrypted;
  keys live separately; legacy plaintext files are overwritten in place during migration.
- **Agent mode is server-side code execution**: the Python child process drops to UID 10001 and cannot read
  the encryption key; the server itself still runs as root, so split out a dedicated sandbox runner for
  high-security public deployments.
- **iOS**: Keychain stores API keys / endpoints; session directories are excluded from iCloud backup; the
  local HTTP server binds loopback only and requires a per-process random cookie; external pages open in an
  isolated WKWebView with no bridge injected.
- An authorized ARTEX 2.2.0 self-assessment of an isolated instance (2026-11) fixed process crashes, XFF
  rate-limit bypass, SSH SSRF, CSRF / Origin and session-validation issues. See [SECURITY.md](SECURITY.md).

**Before going public, do at least three things**: set a strong `ACCESS_PASSWORD`, set `REQUIRE_AUTH=true`,
and expose the service over HTTPS only. Then work through the [SECURITY.md](SECURITY.md) checklist.

## Tests and builds

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

# Mobile (full steps in mobile/README-MYAGENT.md)
cd mobile/android
./gradlew :app:assembleDebug -x buildWeb

# iOS (requires the mock backend; see ios/README.md for iPad and real-NAS tests)
node ios/scripts/mock-server.mjs &
xcodebuild test -project ios/WyDeepSeek.xcodeproj -scheme WyDeepSeek \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath ios/build
```

Server tests cover compression windows, memory fencing and workspace path validation. iOS end-to-end tests
cover streaming replies, native SQLite persistence, keyboard / drawer / settings / long-press selection,
attachments, voice, export, the in-app browser, built-in Tailscale, the iPad landscape layout and
state-by-state iPad UI.

## License and acknowledgements

- **Web / server**: MIT, see [LICENSE](LICENSE).
- **Android**: GPL-3.0-or-later (derived from [deepseek-app-replica](https://github.com/LiJiaHua1024/deepseek-app-replica)); see `mobile/package.json`.
- **iOS**: built on the same `mobile/` web build and design, therefore GPL-3.0-or-later; the Swift native layer is original.
- UI base: [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT).
- Memory and compression: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent); Honcho plugin: [plastic-labs/honcho](https://github.com/plastic-labs/honcho/tree/main/hermes-plugin-honcho).
- Agent tool concept reference: [anthropics/claude-code](https://github.com/anthropics/claude-code).
- Models and API: DeepSeek (`deepseek-flash` / `deepseek-v4-pro`).
- **Trademark notice**: the DeepSeek goldfish logo is used for identification only and does not imply
  official status; see [NOTICE.md](NOTICE.md).
- Third-party dependencies keep their own licenses; retain `LICENSE` and dependency notices when distributing.

---

<p align="center"><sub>WyDeepSeek · Keep your personal agent on your own server.</sub></p>
