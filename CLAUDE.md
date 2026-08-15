# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Cyrene — an Electron desktop AI-assistant chat app (Windows + Ubuntu) with Live2D character, streaming AI replies, voice input, and a desktop tool/authorization system. **This repo now contains code and design docs**: the implementation lives in `apps/desktop/` (Electron + Vue 3 + TypeScript + electron-vite, pnpm workspace), and phases 0–2 plus the 真实联调整改批次 A/B/C、阶段 0/1 整改批次 A/B/C/D and 首次真实联调整改、二次真实联调整改(Renderer 水合 + replay 身份 + 取消码)、三次真实联调整改(WS permessage-deflate 修复 + B-01 封口) are landed and fully verified (527 unit tests (47 files) / 23 integration tests (6 files)); **B-01 已真实联调通过（2026-08-14，Windows 真机十项复跑全绿）**; 阶段 3 四组（G1 布局响应式 / G2 历史聊天体验 / G3 附件多媒体 / G4 历史查看器+表情+无障碍）已落地并全量验证（904 unit tests (82 files) / 39 integration tests (10 files) + typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）），阶段 3 真实联调前整改（2026-08-15，日期自然日 / webm kind hint / REST 跨仓门禁 / 贴图真实契约 / 删死代码 + B-02 验收口径）已落地，B-02/B-03 进入条件达成，阶段 3 真实联调复验整改（2026-08-15，P0-01 相对签名 URL / P0-02 ContentPart null / P0-03 StickerPart 恢复 / P1-01 搜索排序升序）已落地并全量验证，阶段 3 真实联调第二轮前端整改（2026-08-15，FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）已修复并补真实 Electron 布局/点击集成测试（**944 unit tests (83 files) / 42 integration tests (11 files)** + typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）），阶段 3 新功能标「已开发、未联调」（Mock 驱动，真实 Windows Electron 回归通过后升「已真实联调」），阶段 2 主链保持「已真实联调」。`docs/` (all in Chinese, v0.2 as of 2026-08-04) is the engineering contract.

The docs are the engineering contract. Before writing code, read them; before changing behavior, update them (see "Document maintenance").

## Document set (all under `docs/`)

| Doc | Content |
|---|---|
| [00](docs/00-Cyrene-前端文档索引与阅读顺序.md) | Index, per-role reading routes, doc priority order |
| 01 | Electron overall architecture (processes, modules, boundaries, flows) |
| 02 | **Front-end ↔ backend communication protocol & data structures** (the domain contract) |
| 03 | UI & interaction design |
| 04 | Desktop tools & permission interaction |
| 05 | Live2D integration |
| 06 | State management & local storage |
| 07 | **Electron security design** |
| 08 | Test & Demo acceptance plan |
| 09 | Build, packaging & release |
| 10 | Implementation route & task breakdown (phases 0–8) |
| 11 | Settings center detailed design |
| 12 | **Kickoff checklist & phased plan** (authoritative entry conditions / gates) |
| 13 | Cross-document review & harmonized conventions (R-01…R-24) |
| 14, 15 | Backend-side adaptation task list / prompt pack |
| 16 | Per-phase execution checklist & progress tracker (living tracker; 10/12 remain authoritative) |
| 17 | Local dev environment baseline, install flow, Playwright/vision-MCP usage & pitfall log |

Upstream requirement docs (not numbered): `Cyrene-Desktop-Demo-产品需求文档-v0.2.md` (product scope) and `Cyrene-Agent-工具执行系统补充需求.md` (tool execution system).

Read [00](docs/00-Cyrene-前端文档索引与阅读顺序.md) first — it maps which docs each role should read. [13](docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md) records the harmonized conventions (统一口径) that all docs now share; these are the single-source-of-truth rules below.

## Tech baseline (tooling exists — versions locked in repo)

Electron + Vue 3 + TypeScript + Vite, Electron Forge, pnpm, Vitest, Playwright. Versions locked in the repo, not hardcoded in docs. Toolchain choices are confirmed and versions pinned (`package.json` / `pnpm-lock.yaml`); Electron Forge `make` and Playwright `test:e2e` are still placeholders for later phases (阶段 8 / 阶段 3).

### Vision MCP (available in this environment)

The `mimo-vision` MCP server is connected and exposes **`analyze_image`** (visual inspection of one local screenshot) and **`compare_images`** (before/after or implementation-vs-reference comparison), powered by MiMo-V2.5. Use them to visually verify UI: read a Playwright MCP screenshot (saved under `.playwright-mcp/`), check layout/colors/overflow, or diff two renders. Details & usage pitfalls: docs 17.

## Architecture overview

### Trust boundary (docs 01, 07)
Three strict layers; **the Renderer is untrusted**:

- **Main** owns everything sensitive: backend connection, credentials, raw protocol parsing, `BackendAdapter`, paths, file/screenshot tools, permission decisions, audit, logging. Never owns Vue UI state.
- **Preload** exposes only a narrow, named, schema-checked `DesktopApi` via `contextBridge` — no raw `ipcRenderer`, no arbitrary channels, no Node modules.
- **Renderer** (Vue) is pure UI: never connects to a credentialed backend, never touches filesystem/credentials/shell, never executes tools.

Forbidden everywhere: `readFile(path)`, `exec(command)`, `invoke(channel)`-style generic IPC. Enforced Electron baseline: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, custom restricted protocol instead of arbitrary `file://`, CSP without `unsafe-eval`, remote debugging always off.

### BackendAdapter (docs 01, 02)
The existing backend is an **external system** — do not redesign it. All protocol differences (URLs, field names, WS vs SSE, IDs) are confined to `BackendAdapter` in Main. UI consumes only stable front-end domain models. Backend field changes must never leak into Vue components; protocol mismatches error explicitly, never silently drop fields. Doc 02's alignment table (section 19) is where real backend mappings get recorded — it is currently **unfilled**, so the protocol contract is not yet finalized.

### Message / streaming model (docs 01, 02, 06)
- **One backend AI reply = one assistant `Message`** with an ordered `AssistantSegment[]`. Never split a reply into multiple messages because sentences stream.
- `responseId` groups the parent reply; `segmentIndex` gives global display order across Inner Voice / Public Reply and media segments; `deltaSequence` only accumulates within a segment. `generation.segment.completed` completes one segment only; **`generation.completed` is the only event that ends the parent reply**.
- `inner_voice` and `public_reply` are two display channels of the *same* message, interleavable, each independently foldable. P0 Inner Voice is text/markdown only.
- `assistantSegments` is the **single source of truth** for assistant visible text — never also write the same text to `Message.content` (content is for user/system/tool messages; Adapter normalizes before entering the Store).
- Token, actual model, and emotion are written at parent-reply completion. Distinguish per-generation `usage` vs server-aggregate `conversationUsage`; never count characters as tokens; dedupe by `generationId` for client-side sums and label the source (`provider_reported` / `server_aggregate` / `client_sum`).
- Batched IPC delivery is allowed, but each event keeps its own `eventId/sequence` and Renderer processes them in order — never concatenate segments into undeduplicatable pseudo-events.

### Tools & permissions (docs 04, 07, 10)
- One static Tool Registry covering `backend` / `desktop` / `local_worker` runtimes. Demo P0 Desktop tools are exactly four, namespaced: `desktop.file.select`, `desktop.file.read`, `desktop.file.write`, `desktop.screen.capture`. `desktop.command.run` is **optional** — register only after explicit scope confirmation.
- Backend Runtime tools are display-only; Desktop/Local Worker tools execute through Main with permission + audit. `approvalAuthority` must be `client` for desktop/local_worker; backend approvals never create or reuse local grants.
- Risk is **recomputed locally** — the backend's declared risk is informational only. Decision precedence: prohibited/illegal params → path/domain blacklists → local risk forced-confirmation → valid scoped grants → sandbox defaults → user prompt. Blacklists always override sandbox and historical grants.
- Side-effect tools are idempotent by `callId`; a rejected call stays rejected after reconnect. Tool lifecycle is single-direction: `requested → awaiting_permission → running → completed/failed/rejected/cancelled/timeout` (terminal states never re-enter execution).

### Voice & model services (docs 02, 11, 13)
- Model services are exactly **three** types: LLM, STT, TTS. Input-method dictation (按住说话转文字) is *not* a fourth service — it selects a compatible STT Profile via `dictationSttProfileId`.
- Two strictly separate voice paths: **direct voice input** (recorded/realtime; STT partial/final are captions only and **never write to the text draft**) vs **dictation** (only its final text inserts into the current draft; no voice message created, no auto-send).
- `ModelExecutionLocation` (`backend`/`desktop`/`local_worker`) is distinct from `ToolRuntime` — model execution does not enter the tool state machine.
- Credentials: Main/system keystore owns secrets; Renderer sees only `credentialStatus`, never plaintext. Custom profile keys are one-shot form input, cleared immediately after submit. No auto-fallback from local to remote STT without user consent.

### Attachments (docs 01, 02, 06)
Drop/paste/picker share one validation+upload state machine (differing only by `source`). **Drag & drop never auto-uploads or auto-sends** — it creates a `PendingAttachment`. Renderer collects browser `File` objects; Preload uses `webUtils.getPathForFile()`; Main converts to opaque resource handles. Absolute local paths never reach the backend or Renderer stores. No "path-to-file" or "read-by-path" API exposed to the page.

### Live2D (docs 05, 07)
Pure presentation layer — never decides business results. The character pane is a **right-column layout extension** that never overlays chat (default ~1200px window; narrow-window auto-collapse rules are still open decisions). Loads only validated local models with `manifest.json` + `integrity.json` (SHA-256); rejects absolute paths, `..`, symlink escapes, and any backend-supplied path/URL/script. State mapping (idle/listening/thinking/speaking/waiting_permission/…) comes from local mapping tables; unknown emotion codes never become expression/motion names. Must degrade to a static avatar without blocking chat, and pause high-frequency rendering when hidden.

### State & storage (docs 06)
Pinia stores with explicit ownership (`appStore`, `connectionStore`, `conversationStore`, `messageStore`, `toolStore`, `live2dStore`, `settingsStore`, `modelServiceStore`, `voiceStore`, `searchStore`, `resourceStore`, `stickerStore`). Backend is the source of truth for conversations/messages; local cache is a recent snapshot only. Messages are normalized (byId/allIds); one entity stored once, lists reference IDs. Main is the persistence boundary for settings, credentials (system keystore), audit, and security policy. `inner_voice`/`public_reply` and transcription audio are treated as sensitive — never logged, never in diagnostic exports.

## Development phases (docs 10, 12)

Nine phases, **0 through 8** — docs 10 and 12 share the same numbering (doc 12's entry conditions & gates are authoritative; doc 10 is the technical task breakdown):

```
0 protocol & project baseline → 1 secure Electron shell → 2 core chat vertical slice
→ {3 full chat/history/media, 4 model services & voice, 5 Live2D} → 6 tools/permissions/Desktop P0
→ 7 security/stability/perf convergence → 8 packaging & Demo acceptance
```

Phases 3/4/5 interleave after phase 2. Phase 6's real Desktop execution requires phase 1's security boundary.

Definition of Done (both docs): typecheck+format pass; runtime schemas for all external input; normal/failure/cancel/reject/timeout paths handled; unit tests for pure logic; integration tests across Main/Preload/Renderer or Adapter; E2E or manual record for user-visible flows; no plaintext secrets/unredacted logs/unauthorized assets; docs + alignment table updated; known limits recorded. **Work driven by Mock Backend only must be marked "已开发、未联调" (developed, not integrated) — never "已完成" until a real backend passes.**

## Doc conflict priority (doc 00 §5)

1. User's latest confirmed product decisions; 2. main PRD + confirmed tool semantics; 3. non-negotiable security/permission constraints; 4. backend contract confirmed by real integration; 5. other detailed designs; 6. implementation-route suggestions. Never lower security constraints to match a UI sketch; never force the existing backend to rename fields to match doc recommendations.

## Document maintenance (doc 00 §7, doc 13)

- Each doc tracks its own version/status; update the docs that changed behavior touches (e.g., permissions → 04/07/08; UI-visible features → PRD/03/08; Live2D resources → 05/07/09; release targets → 08/09/10; protocol changes → 02 alignment table + Adapter, never the UI directly).
- Doc 02's section-19 alignment table is the only place backend field mappings live — no protocol guesses scattered in components.
- Re-run cross-review (doc 13) when real protocol, Demo scope, voice/model semantics, Electron/Live2D/SDK, security policy, or phase gates change.
- **Keep doc edits in Chinese** to match the set.

## Commands

Run from the repo root (pnpm workspace shims; equivalently `pnpm -F @cyrene/desktop <script>`): `dev`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `build`, `package`, `make`, `verify:artifact`. `test:e2e` (Playwright) and `make` (Electron Forge) are still placeholders for later phases. `check:contract` (no root shim — run as `pnpm -F @cyrene/desktop check:contract`) is the local cross-repo wire-contract check: it reads `/home/yomu/elysia-agent/frontend_contract` when that repo is mounted (CI/other machines skip it).

## Current status / open decisions

- Phases 0–2 landed and fully verified: **527 unit tests (47 files) / 23 integration tests (6 files)** + typecheck/lint/build + check:contract(13/13) + package + verify:artifact --smoke green. 真实联调整改批次 A/B/C 已落地（连接凭据安全与装配策略、真实连接编排与守卫、IPC/replay 运行时 Schema + 夹具跨仓库门禁）。阶段 0/1 整改批次 A（跨平台文件与退出地基）已落地：FE-S1-P0-01 Windows 安全文件首建/ENOENT 保留（safe-open 平台层可注入，`SafeOpenPlatform` posix/windows）、FE-S1-P1-02 非普通文件全拒（FIFO/socket/目录/device，POSIX `O_NONBLOCK` 防阻塞）、FE-S1-P2-02 `EMPTY_FILE` 工厂化（多 key 损坏重建不污染）、FE-S1-P1-03 CredentialStore `close()`/drain + 有序退出（凭据→adapter→diagnostics + 超时标记经同步审计落盘 + 统一 fatal 路径）。阶段 0/1 整改批次 B（Renderer 信任边界）已落地：FE-S1-P0-02 dev Renderer URL 回环白名单（localhost/127.0.0.0/8/[::1] + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist，非法 URL 启动报错退出，受信 URL 收敛为 Main 单一策略函数）+ 开发 CSP（`frame-ancestors 'none'` 经 Vite 中间件注入 + meta 收紧 `frame-src/form-action 'none'` + `connect-src` 去裸 ws:/wss:）+ FE-S1-P2-01 IPC 来源纵深（`senderFrame===mainFrame` + 当前 URL 受信校验）。**P0-02 关闭**（首次真实联调前最后 P0）。首次真实联调整改已落地：FE-INT-P1-01 后端合法 state/typing 帧建模为「已知但有意忽略的兼容帧」（不再 RAW_FRAME_INVALID，check:contract 13/13）+ FE-INT-RISK-01 单写者约束文档化（单写者，不纳入 B-01 门禁）。阶段 0/1 整改批次 C（审计与持续门禁）已落地：FE-S1-P1-01 审计接线（凭据生命周期 `credential:set/clear/status-change` + 连接生命周期 `connection:connect/disconnect/error` 接入 append-only audit；fail-open 语义 C1——审计失败不改变操作结果；真实应用装配集成测试：经 IPC set/clear 后 audit/ JSONL 出现预期行）+ FE-S1-P1-04 CI 持续门禁（新增 `artifact` job：clean + package + `verify:artifact --smoke` + SHA 证据；新增 `windows` job：构建级 typecheck/lint/unit/build，C3 不启动 Electron；POSIX 专属单测加平台守卫；CI 两个新 job 需 push 触发 GHA 验证，本机沙箱无 GHA）。
- **三态状态源（见 README「真实模式联调」小节，单一来源）**：**已开发**（代码落地、Mock 驱动）/ **已验证**（typecheck/lint/test/build/package/verify:artifact 全绿、未真实联调）/ **已真实联调**（真实后端 B-01 验收通过）；阶段 0 标「**带已知豁免提前开发**」（非「已验证」）。所有 Mock 驱动工作标记「已开发、未联调」，真实后端通过前不得标「已完成」。首次真实联调（2026-08-13，确认 P1/RISK）、二次真实联调（2026-08-13，确认 P0/P1/RISK 问题并修复，见 `docs/review/2026-08-13-Windows-Electron-二次真实联调前端整改清单.md`）与三次真实联调（2026-08-14，确认空闲压缩断连 P0 并修复，见 `docs/review/2026-08-14-Windows-Electron-第三次真实联调前端阻断.md`）均已执行；**B-01 已真实联调通过（2026-08-14，十项复跑全绿）**。
- Doc 02 §19 alignment table is filled (backend contract confirmed via the handoff package `frontend-handoff-v2`).
- **阶段通过门禁的外部依赖清单**：H-01（主验收平台）、H-07（Demo 演示脚本/P0/P1 范围与成功标准）、G-01/G-02（Live2D SDK 许可与合法模型）、H-04（签名证书）。（B-01 真实后端环境已到位，2026-08-14 联调通过后已关闭。）Batch C turns B-01 into a gated integration: on arrival, ≥3 real raw frames (covering `server_info` / session / `user_message.ack` / generation) must pass `parseRawFrame` + mapper + `parseBackendEvent` assertions before 联调 is considered passed. **首次联调 = Linux 本机文本聊天最小闭环**（13 项用例：启动 / 设置 Token / 连接 / 列会话 / 激活新建 / 发送 / ACK / 双通道流式 / completed / 取消 / 断线重连 / 错误展示 / 日志定位）。**Windows 冒烟已通过**（B-01 十项复跑在真 Windows Electron 43.3.0 上全绿，2026-08-14）；批次 C 的构建级 `windows` job（不启动 Electron，C3）继续保留。
- **CI 版本同源声明**：CI 各 job 用 `actions/setup-node` 的 `node-version-file: .nvmrc`（22.23.0）+ pnpm-workspace.yaml `engineStrict: true`，与 engines `>=22.23.0 <23` 一致（单一版本来源：`.nvmrc`）。
- 首次真实联调（2026-08-13）确认单写者口径（FE-INT-RISK-01 决策）：单活动桌面客户端/单写者，多客户端同会话不支持；后端合法 `state`/`typing` 帧已建模为「已知但有意忽略的兼容帧」（不再 `RAW_FRAME_INVALID`，check:contract 13/13）。527 单测（47 files）+ 23 集成 + typecheck/lint/build 全绿。**B-01 已真实联调通过（2026-08-14，十项复跑全绿）**，阶段 2 主链由「已开发、未联调」转「已真实联调」；阶段 3 转为主线。
- **阶段 3 四组已落地并全量验证（2026-08-14）**：G1 布局响应式（四区布局、会话栏 260 可折叠 / Live2D 右栏默认显示 340 可调（[300,420]）、断点 1200/736/520/320、最小窗口 1100×700、布局记忆 Renderer localStorage `cyrene.layout.v1`）；G2 历史聊天体验（CyMessageList 自研虚拟列表 + 锚点捕获/恢复/补偿 + 回到底部、draftStore 草稿 50 会话×100KB 超限提示、离线缓存最近 20 会话、草稿/滚动锚点归 Main 持久化、代码块仅复制按钮+基础样式不引高亮库）；G3 附件多媒体（附件内嵌 Message + ContentPart 映射、通用媒体代理 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（attachment 签名+Range/206、sticker 静态白名单）、原生预览+图标卡、拖拽不自动上传发送）；G4 历史查看器+表情+无障碍（CyHistoryViewer 全窗覆盖式查看器、只内置 `st_` 表情包、搜索项文本展示（P0-1 缩略图缺口待后端确认）、现代 QQ/微信风格、IME/焦点/键盘无障碍）。**904 单测（82 files）+ 39 集成（10 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿**；阶段 3 真实联调前整改（2026-08-15）落地并全量验证，B-02/B-03 进入条件达成；**阶段 3 真实联调复验整改（2026-08-15）落地并全量验证**（P0-01 相对签名 URL 基于 endpoint 解析 / P0-02 ContentPart null 归一化 + REST/WS replay wire 边界放行 duration_ms null / P0-03 StickerPart 恢复 / P1-01 搜索排序统一升序，新增真实相对签名 URL / ContentPart null / StickerPart replay / 两页排序 fixture）；**阶段 3 真实联调第二轮前端整改（2026-08-15，FE-S3-RUN2-P1-01 历史查看器布局/加载更多不可达）落地并全量验证（944 单测（83 files）+ 42 集成（11 files）+ typecheck/lint/build + check:contract（WS 13/13 + REST 段 8/8）全绿）**（纯 CSS 容器约束 / loadMore 锚点补偿 / mock 大 seed（CYRENE_MOCK_HISTORY_LARGE）分页语义对齐 real / 真实 Electron 布局+点击集成测试三用例）；阶段 3 新功能标「已开发、未联调」（Mock 驱动，真实 Windows Electron 回归通过后升「已真实联调」），阶段 2 主链保持「已真实联调」（B-01 封口）；下一块阶段 4/5（模型服务与语音 / Live2D）可推进。
