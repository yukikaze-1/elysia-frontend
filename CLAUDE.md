# CLAUDE.md

This file contains durable repository guidance for coding agents. It must not contain machine-specific session state, current test totals, or a chronological project diary.

## Repository purpose

Cyrene is an Electron desktop AI-assistant client for Windows and Ubuntu. The implementation lives in `apps/desktop/` and uses Electron, Vue 3, TypeScript, electron-vite, pnpm, Vitest, and Playwright.

The Renderer is untrusted. Main owns credentials, backend connections, filesystem access, tool execution, audit, logging, and raw protocol parsing. Preload exposes a narrow schema-checked API. Renderer owns presentation and UI state only.

## Read before changing code

1. Read [doc 00](docs/00-Cyrene-前端文档索引与阅读顺序.md) for document roles and reading routes.
2. Read [doc 16](docs/16-Cyrene-前端实施任务清单与进度跟踪.md) for the only current project status.
3. Read [doc 17](docs/17-Cyrene-前端开发环境与依赖安装记录.md) for the current Windows/Linux environment baseline.
4. Read the relevant maintained design document before changing behavior:
   - 01 architecture
   - 02 backend protocol and front-end domain contract
   - 03 UI and interaction
   - 04 desktop tools and permissions
   - 05 Live2D
   - 06 state and storage
   - 07 security
   - 08 tests and Demo acceptance
   - 09 packaging and release
   - 10 technical task breakdown
   - 11 settings center
   - 12 phase gates
5. Use [review index](docs/review/README.md) and [spec/plan index](docs/superpowers/README.md) only when historical decisions or evidence are needed.

## Sources of truth

There is no single global priority for every kind of question:

| Question | Authority |
|---|---|
| Current phase, blockers, latest verification, next action | doc 16 |
| Product intent and confirmed scope | upstream requirement docs plus the latest explicit decision record |
| Runtime behavior | executable code, runtime schemas, and tests |
| Backend wire behavior | current backend contract plus Main-process adapter/schema code |
| Phase entry and exit gates | doc 12 |
| Technical task definition | doc 10 |
| Historical proof | dated review/acceptance records |

Dated status notes in design documents are historical snapshots. Do not update the same test totals or batch narrative in README, this file, doc 10, and doc 12.

## Architecture invariants

### Process boundary

- Main owns secrets and privileged operations.
- Preload exposes named, narrow, runtime-validated methods through `contextBridge`.
- Renderer never receives plaintext credentials, absolute local paths, raw `ipcRenderer`, Node modules, or generic filesystem/shell methods.
- Generic IPC such as `invoke(channel)`, `readFile(path)`, or `exec(command)` is forbidden.
- Navigation, IPC sender origin, CSP, custom protocol, path containment, and Electron Fuses remain fail-closed.

### Backend adapter

- Treat the backend as an external system; do not force it to adopt front-end domain names.
- Raw wire schemas and REST mappers stay in Main.
- Renderer consumes stable front-end domain events only.
- Unknown or malformed external input fails explicitly; do not hide drift with `any`, permissive schemas, or silent field drops.
- Record confirmed mappings in doc 02 and cover them with contract tests.

### Messages and streaming

- One backend generation produces one assistant message containing ordered segments.
- `generation.completed` is the parent terminal event; segment completion ends one segment only.
- `assistantSegments` is the visible assistant-content source of truth.
- Token/model/emotion data must preserve backend semantics and source labels; never estimate tokens from characters.
- Replay, optimistic messages, and reconnect paths must retain stable identities and deduplicate safely.

### Tools and permissions

- Backend tools are display-only in the client. Desktop/local-worker tools execute only in Main.
- Recompute risk locally. Blacklists and invalid parameters override grants.
- Renderer cannot construct or modify trusted tool metadata.
- Side-effecting calls are idempotent by call ID; terminal states never re-enter execution.
- Authorization, denial, timeout, cancellation, conflict, and audit paths require explicit tests.

### Voice, attachments, and Live2D

- Recorded/realtime voice and dictation are separate flows; only dictation final text enters the draft.
- Secrets and sensitive transcript/inner-voice content never enter logs or diagnostic exports.
- Drag/drop creates pending attachments and never auto-sends.
- Local absolute paths do not cross into Renderer stores or backend payloads.
- Live2D is presentation-only and must degrade without blocking chat.

## Environment portability

Do not write session assertions into repository docs.

- Detect GitHub authentication with `gh auth status`; never assume credentials are present or absent.
- Detect available MCP/browser/visual tools from the current session; never claim a named server is connected.
- Detect backend reachability and record the exact backend SHA for real integration.
- Use the repository-pinned Node and pnpm versions.
- Fixed remote-debugging ports are rejected by the application security policy. Use the project test harness or Playwright Electron flow when automation needs a debugging transport.

## Commands

Run from the repository root:

```text
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm package
pnpm verify:artifact
pnpm docs:check
pnpm docs:index
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop verify:sensitive
```

`test:e2e` and `make` are deliberate non-zero placeholders until their phase-8 work is implemented. Do not report them as passing or implemented.

## Documentation maintenance

- Keep maintained documentation in Chinese.
- Update doc 16 once for project status; other surfaces link to it.
- Put durable roadmap decisions in doc 12 and a dated decision record.
- Update behavior documents when code behavior changes.
- Preserve historical review/spec/plan files; supersede them with new records instead of rewriting their historical claims.
- Run `pnpm docs:index` after adding or removing review/spec/plan files.
- Run `pnpm docs:check` before committing documentation changes.
- Filename policy is defined in doc 00. Do not rename existing core documents casually because external and historical links may depend on them.
