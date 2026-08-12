# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Cyrene — an Electron desktop AI-assistant chat app (Windows + Ubuntu) with Live2D character, streaming AI replies, voice input, and a desktop tool/authorization system. **This repo now contains code and design docs**: the implementation lives in `apps/desktop/` (Electron + Vue 3 + TypeScript + electron-vite, pnpm workspace), and phases 0–2 plus the 真实联调整改批次 A/B/C are landed and fully verified (433+ unit / 22+ integration tests). `docs/` (all in Chinese, v0.2 as of 2026-08-04) is the engineering contract.

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

Run from the repo root (pnpm workspace shims; equivalently `pnpm -F @cyrene/desktop <script>`): `dev`, `typecheck`, `lint`, `test`, `test:integration`, `test:e2e`, `build`, `package`, `make`, `verify:artifact`, `check:contract`. `test:e2e` (Playwright) and `make` (Electron Forge) are still placeholders for later phases. `check:contract` is the local cross-repo wire-contract check: it reads `/home/yomu/elysia-agent/frontend_contract` when that repo is mounted (CI/other machines skip it).

## Current status / open decisions

- Phases 0–2 landed and fully verified: **433+ unit tests / 22+ integration tests** + typecheck/lint/build green. 真实联调整改批次 A/B/C 已落地（连接凭据安全与装配策略、真实连接编排与守卫、IPC/replay 运行时 Schema + 夹具跨仓库门禁）。
- **All Mock-driven work is marked "已开发、未联调" (developed, not integrated) — never "已完成" until a real backend passes.** Real integration has not started yet.
- Doc 02 §19 alignment table is filled (backend contract confirmed via the handoff package `frontend-handoff-v2`).
- Still pending external inputs (doc 12 P0 list): real backend test env + auth (B-01), primary acceptance platform (H-01), two legally-usable Live2D models + SDK license classification (G-01/G-02), signing certificate (H-04). Batch C turns B-01 into a gated integration: on arrival, ≥3 real raw frames (covering `server_info` / session / `user_message.ack` / generation) must pass `parseRawFrame` + mapper + `parseBackendEvent` assertions before 联调 is considered passed.
