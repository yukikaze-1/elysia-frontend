# 阶段5 批次A（Live2D 地基）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个装配并通过完整性校验的 Live2D 模型，经 Main 注册表 + cyrene:// 协议供给到 renderer，由 Cubism Web SDK 5-r.5 渲染出首帧，且切换/失败路径干净（聊天不受影响）。

**Architecture:** 五层解耦（panel → controller → adapter/CubismGL → Fenix ？→ SDK）。renderer 持有 Framework 源码+shader+Core（asm.js）经 `@framework` alias/全局 script 运行；Main 拥有模型注册表（manifest+integrity 两级可用性）与 cyrene:// live2d 供给分支（containment+白名单+fail-closed hash+dev CORS）；装配工具（node strip-types CLI）把原始模型目录转成 `userData/models/<id>/` 合规安装包。Renderer 只消费已校验的 cyrene:// URL，不碰文件系统。

**Tech Stack:** Electron+Vue3+TS+Vite（electron-vite）+Pinia+zod+Vitest+Playwright `_electron`（xvfb-run）+ Cubism Web SDK 5-r.5（vendored asm.js Core + Framework src + 13 shaders）。

**Spec:** [docs/superpowers/specs/2026-08-17-phase5-live2d-batcha-foundation-design.md](../specs/2026-08-17-phase5-live2d-batcha-foundation-design.md)（binding authority；本计划从 spec 论证，执行者两篇同读）

## Global Constraints

- **决策表 D5A-01~13（spec §0）是硬约束**：Core 为 asm.js、**CSP 不加 `'wasm-unsafe-eval'`**；dev `connect-src` 加 `cyrene:`（buildDevCsp **且** index.html meta）；vendor 范围含 `Framework/Shaders/WebGL/`（13 文件）+ Adapter 首次 draw 前 `renderer.loadShaders('/live2d/shaders/')`；manifestSchema 必填 `{id, displayName, modelFile, licenseRef, integrityManifest}`、可选 `{preview?, expressions?, motions?, version?}`；available 门禁只锚定 integrity 覆盖的模型文件（preview 豁免）；verifyIntegrity fail-closed（首命中 await + pending 共享）；A5 注入 license note 先于 manifest/integrity 生成且 integrity 排除 manifest/integrity 自身；settings `live2d` 段 `.default(DEFAULT_LIVE2D)` 不 bump version。
- **不得**：放宽 `script-src`；新建 dev renderer 原点以外的 origin；新增单向 IPC 通道（`live2d:list-models` 为 invoke，走 `registerHandler`）；引入 npm 外部依赖（Framework 源码 vendored，Core/shader 走 public/）；改 Framework 本体源码；用 symlink 装模型。
- 门禁：`typecheck` / `lint` / `test`（单测）/ `test:integration`（xvfb-run）/ `build` 全绿；`check:contract` 与本批无关（不涉及 wire 契约）。
- 文档保持中文；三态纪律（本批为「已开发、未联调」，真实 Windows Electron 复验归批次 C）。
- nvm Node 22.23.0（仓库 engines pin；所有 pnpm 命令前缀 `export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22.23.0 >/dev/null 2>&1 && ...`）。

## 文件结构

| 文件 | 责任 | 变更 |
|---|---|---|
| `apps/desktop/src/renderer/src/live2d/framework/` | Cubism SDK Framework TS 源码（vendored，勿改；**不参与 strict typecheck/lint**） | 新建（拷贝 third_party） |
| `apps/desktop/src/renderer/src/live2d/core/live2dcubismcore.d.ts` | Core 官方类型（vendored，全局 namespace） | 新建（拷贝） |
| `apps/desktop/src/renderer/src/live2d/framework.d.ts` | `declare module '@framework/*'` ambient（Framework 不拉入 tsc 程序，仅类型桩） | 新建 |
| `apps/desktop/src/renderer/public/live2d/` + `shaders/` | Core min.js + 13 shader 文件（Vite publicDir 原样复制） | 新建（拷贝） |
| `apps/desktop/src/renderer/src/live2d/gl/types.ts` / `webgl.ts` / `fake.ts` | CubismGL 极薄 GL 面/真实实现/测试 fake | 新建 |
| `apps/desktop/src/renderer/src/live2d/adapter.ts` | CubismFramework 生命周期 + 模型创建/更新/销毁 | 新建 |
| `apps/desktop/src/renderer/src/live2d/controller.ts` | Live2DController（状态机 + 6 方法） | 新建 |
| `apps/desktop/src/renderer/src/stores/live2d.store.ts` | Pinia store（models/status/modelId/error + init/switchModel/dispose） | 新建 |
| `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue` | 既有 G1 面板改造：stage→canvas + 模型下拉 + 状态态 | 修改 |
| `apps/desktop/src/renderer/index.html` | Core script 标签（module 前）+ meta `connect-src` 加 `cyrene:` | 修改 |
| `apps/desktop/src/renderer/src/env.d.ts` | `Live2DCubismCore` 全局声明 | 修改 |
| `apps/desktop/tsconfig.web.json` | renderer tsconfig——`exclude` 增 `src/renderer/src/live2d/framework`（vendored 源码不进 strict 程序；**不加** `@framework` paths，走 ambient + alias） | 修改 |
| `apps/desktop/electron.vite.config.ts` | renderer alias 增 `@framework` | 修改 |
| `apps/desktop/src/main/config/dev-csp.ts` | `connect-src` 加 `cyrene:`（dev） | 修改 |
| `apps/desktop/src/main/live2d/manifest.ts` | 纯 node 完整性/清单逻辑（sha256/size/递归扫描），Main 与 CLI 共用 | 新建 |
| `apps/desktop/src/main/live2d/model-registry.ts` | 扫 `dirs.models`、两级可用性、resolveModelFile、verifyIntegrity（fail-closed pending） | 新建 |
| `apps/desktop/src/main/protocol/live2d-path.ts` | `LIVE2D_PATH_PREFIX` + `parseLive2dPath` | 新建 |
| `apps/desktop/src/main/protocol/handler.ts` | live2d 分支（media 后、renderer-root 前）+ `resolveLive2d` 注入 + dev ACAO | 修改 |
| `apps/desktop/src/main/ipc/live2d-handlers.ts` | `live2d:list-models` invoke 处理器 | 新建 |
| `apps/desktop/src/main/ipc/channels.ts` | `live2dListModels` 通道 + schema | 修改 |
| `apps/desktop/src/main/ipc/handlers.ts` | 登记 live2d 处理器 | 修改 |
| `apps/desktop/src/main/index.ts` | registry 装配 + `resolveLive2d` 接线 | 修改 |
| `apps/desktop/src/shared/contracts/live2d.ts` | `Live2DSettings`、`Live2DModelSummary`（含 `reason?` 脱敏原因） | 新建 |
| `apps/desktop/src/shared/contracts/index.ts` | 增 `export * from './live2d'`（barrel） | 修改 |
| `apps/desktop/src/shared/contracts/ipc.ts` | `IpcChannels` 增 `live2dListModels: 'live2d:list-models'` | 修改 |
| `apps/desktop/src/shared/contracts/voice.ts` | `SettingsState`/`SettingsPatch` 增 `live2d` 段 | 修改 |
| `apps/desktop/src/shared/schemas/ipc-response.ts` | `SettingsStateSchema` 增 `live2d.default(DEFAULT_LIVE2D)`、`DEFAULT_SETTINGS` 增 live2d、`SettingsPatchSchema` 增 `live2d` 嵌套 partial、`Live2DModelSummarySchema`/`Live2DListResponseSchema` | 修改 |
| `apps/desktop/src/main/settings/settings-service.ts` | `save()` 增第三 merge 行 `live2d` | 修改 |
| `apps/desktop/src/main/settings/settings-store`（renderer side `settings.store.ts`） | 增 `setLive2d` patch | 修改 |
| `apps/desktop/src/preload/desktop-api.ts` + `index.d.ts` | `listLive2dModels()` + 类型 | 修改 |
| `apps/desktop/scripts/live2d-install.mjs` | A5 装配 CLI（strip-types 入口，import `manifest.ts`） | 新建 |
| `apps/desktop/package.json` | `live2d:install` script | 修改 |
| `apps/desktop/tests/unit/live2d-*.spec.ts`（registry/path/adapter/store/install） | 单测 | 新建 |
| `apps/desktop/tests/integration/electron-live2d.spec.ts` | Electron 集成（首帧/切换/失败/设备丢失/折叠/持久化） | 新建 |

---

### Task 1（A1）: SDK vendoring + 构建集成 + dev CSP

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/framework/`（拷贝 `third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Framework/src` 全量）
- Create: `apps/desktop/src/renderer/src/live2d/core/live2dcubismcore.d.ts`（拷贝 `Core/live2dcubismcore.d.ts`，官方全局 `declare namespace Live2DCubismCore`）
- Create: `apps/desktop/src/renderer/src/live2d/framework.d.ts`（ambient：`declare module '@framework/*'`——通配 `any` 导出基线，adapter 可对实际用到的模块给最小可型面）
- Create: `apps/desktop/src/renderer/public/live2d/live2dcubismcore.min.js`、`apps/desktop/src/renderer/public/live2d/shaders/`（拷贝 `Framework/Shaders/WebGL` 13 文件）
- Create: `apps/desktop/src/renderer/src/live2d/THIRD_PARTY_NOTICES.md`
- Modify: `apps/desktop/electron.vite.config.ts`（renderer resolve.alias 增 `@framework`）
- Modify: `apps/desktop/src/renderer/index.html`（Core script 标签在 module 入口前 + meta `connect-src` 加 `cyrene:`）
- Modify: `apps/desktop/src/renderer/src/env.d.ts`（删任何 Core 最小面声明——Core 类型由 vendored d.ts 提供）
- Modify: `apps/desktop/eslint.config.mjs`（`ignores` 增 `src/renderer/src/live2d/framework/**`——vendored 三方可源不参与 lint；`*.d.ts` 已 ignore 无需加）
- Modify: `apps/desktop/src/main/config/dev-csp.ts`（`connect-src` 增 `cyrene:`）
- Test: `apps/desktop/tests/unit/dev-csp.spec.ts`、`tests/unit/protocol-csp.spec.ts`

**Interfaces:**
- Consumes: SDK 原始文件（third_party）；既有 `buildDevCsp`/`buildRendererCsp`
- Produces: `@framework/*` alias（renderer 内 Framework 模块可 import）；全局 `Live2DCubismCore`；`/live2d/shaders/*` 可 fetch；dev `connect-src` 含 `cyrene:`（header+meta）

- [ ] **Step 1: 拷贝 Framework/Shaders/Core 进 renderer**：
  - `cp -r third_party/.../Framework/src apps/desktop/src/renderer/src/live2d/framework`（保留 LICENSE）
  - `cp third_party/.../Core/live2dcubismcore.min.js apps/desktop/src/renderer/public/live2d/`
  - `cp third_party/.../Core/live2dcubismcore.d.ts apps/desktop/src/renderer/src/live2d/core/`（官方全局类型，C2）
  - `cp third_party/.../Framework/Shaders/WebGL/* apps/desktop/src/renderer/public/live2d/shaders/`（13 文件）
  - 写 `THIRD_PARTY_NOTICES.md`（Core: Live2D Proprietary / Framework: Open Software License / 模型: Free Material License，含各自官方链接）
- [ ] **Step 2: alias + ambient 类型 + index.html（C1/C2 纪律）**：
  - `electron.vite.config.ts` renderer resolve.alias 增 `'@framework': resolve('src/renderer/src/live2d/framework')`（**打包交付真实源码**；不在 tsconfig 加 `paths` 映射）
  - `tsconfig.web.json` **`exclude` 增 `"src/renderer/src/live2d/framework"`**（Important B——`include: ["src/renderer/src/**/*"]` 会把拷入的 59 个 Framework .ts 拉进 strict vue-tsc 程序，仅 ambient 不排除则 Task 1 Step 6 typecheck 必挂；exclude 后 ambient `@framework/*` 与 alias 均不受影响，`live2d/core/live2dcubismcore.d.ts` 不在排除目录仍经 include 提供全局）
  - `live2d/framework.d.ts` 写 ambient 桩：`declare module '@framework/*' { /* 通配 any 基线；Task 5 adapter 可对实际用到的 3~4 个模块给最小可型面 */ }`（满足「禁改 Framework 本体」且让 adapter 能 import）
  - Core 类型：vendored `core/live2dcubismcore.d.ts` 经 `tsconfig.web.json` `include: ["src/renderer/src/**/*"]` 自动纳入，提供全局 `Live2DCubismCore` namespace（`Logging/Memory/Utils/Model/Moc/Version` 全量，C2）；`env.d.ts` **不加**任何 Core 声明（防重复声明）
  - `eslint.config.mjs` `ignores` 增 `src/renderer/src/live2d/framework/**`（vendored 三方源码不参与 lint；`*.d.ts` 已被既有 ignore 覆盖）
  - `index.html`: `<script src="/live2d/live2dcubismcore.min.js" defer></script>` 置于 `<script type="module" src="/src/main.ts">` **之前**；meta CSP `connect-src` 由 `'self' ws://localhost:* ws://127.0.0.1:*` 改 `'self' ws://localhost:* ws://127.0.0.1:* cyrene:`
- [ ] **Step 3: dev CSP 函数加 `cyrene:`**（`config/dev-csp.ts`）：`connect-src 'self' cyrene:<wsSources>`（`wsSources` 插在后面）。
- [ ] **Step 4: 更新 CSP 单测**：
  - `dev-csp.spec.ts`：断言结果含 `connect-src 'self'` 且含 `cyrene:`；断言 **不含** `'wasm-unsafe-eval'`、`'unsafe-eval'`。
  - `protocol-csp.spec.ts`：断言 `buildRendererCsp()` **不含** `cyrene:`/`wasm-unsafe-eval`（prod 不动）。
- [ ] **Step 5: 冒烟 import**：临时在 `main.ts` 后加 `import { CubismFramework } from '@framework/live2dcubismframework'`，`typecheck` 通过后移除（或留一个 `console.debug` 自检，随 Task 5 换正式 Adapter）。
- [ ] **Step 6: 运行** `pnpm -F @cyrene/desktop typecheck` + `pnpm -F @cyrene/desktop test`（dev-csp/protocol-csp 绿）+ `pnpm -F @cyrene/desktop build` 绿。
- [ ] **Step 7: Commit** `feat(阶段5批次A): SDK vendoring（Framework src + Core asm.js + 13 shaders）+ @framework alias + dev connect-src cyrene:`

---

### Task 2（A3）: Main 模型注册表 + 完整性 + IPC

**Files:**
- Create: `apps/desktop/src/main/live2d/manifest.ts`
- Create: `apps/desktop/src/main/live2d/model-registry.ts`
- Create: `apps/desktop/src/main/ipc/live2d-handlers.ts`
- Create: `apps/desktop/tests/unit/live2d-registry.spec.ts`
- Modify: `apps/desktop/src/shared/contracts/live2d.ts`（新建文件：`Live2DModelSummary` 含 `reason?: string`）
- Modify: `apps/desktop/src/shared/contracts/index.ts`（`export * from './live2d'`——preload/registry/schema 均走 barrel 消费）
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（`live2dListModels` 通道)
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（`Live2DModelSummarySchema`/`Live2DListResponseSchema`——响应 schema 统一在此）
- Modify: `apps/desktop/src/main/ipc/channels.ts`（`live2dListModelsSchema`）
- Modify: `apps/desktop/src/main/ipc/handlers.ts`、`apps/desktop/src/main/index.ts`（登记 + 装配 registry）
- Modify: `apps/desktop/src/preload/desktop-api.ts`、`src/preload/index.d.ts`

**Interfaces:**
- Consumes: `dirs.models`（`UserDataDirs`）；`registerHandler(channel, executor, arity)`（ipc/registry.ts）；`IpcChannels`
- Produces:
  - `src/main/live2d/manifest.ts`：`export interface IntegrityEntry { path: string; size: number; sha256: string }`；`export async function hashFile(abs: string): Promise<{ size: number; sha256: string }>`；`export async function computeIntegrity(modelDir: string): Promise<IntegrityEntry[]>`（递归扫描，跳过空目录/隐藏项，**排除 manifest.json 与 integrity.json 自身**）；`export async function verifyIntegrityAgainst(modelDir: string, entries: IntegrityEntry[]): Promise<boolean>`
  - `src/main/live2d/model-registry.ts`：`export type Live2DSummary = Live2DModelSummary`（**别名收口共享契约**，不另定义；`Live2DModelSummary` 含 `reason?: string`，仅 `available=false` 时给脱敏原因如 `missing_file`/`size_mismatch`/`hash_mismatch`）；`export class Live2DModelRegistry { constructor(deps: { modelsDir: string }); async listInstalledModels(): Promise<Live2DSummary[]>; async resolveModelFile(modelId: string, relPath: string): Promise<string | null>; verifyIntegrity(modelId: string): Promise<boolean> }`
  - 共享契约 `Live2DModelSummary`（preload 返回类型）：同 `model-registry.Live2DSummary` 字段（含 `reason?`），`@shared/contracts/live2d.ts` 定义、registry 复用；响应 schema `Live2DModelSummarySchema`/`Live2DListResponseSchema` 建于 `shared/schemas/ipc-response.ts`（preload 与 Main handler 共用）

- [ ] **Step 1: 写 `manifest.ts`（纯 node，无 zod 无 alias）**：`hashFile` 用 `node:crypto` `createHash('sha256')` 流式；`computeIntegrity` 递归 `fs.promises.readdir({withFileTypes})`，跳过 `.` 开头的隐藏项与空目录，路径统一 `/` 分隔相对路径；显式排除文件名 `manifest.json`/`integrity.json`。
- [ ] **Step 2: 写 `manifestSchema` + `Live2DModelRegistry`**（模型：registry 用 zod 校验 manifest —— zod 在 Main 是正常依赖）：
  - `const manifestSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/), displayName: z.string(), modelFile: z.string(), preview: z.string().optional(), expressions: z.array(z.string()).optional(), motions: z.array(z.string()).optional(), version: z.string().optional(), licenseRef: z.string(), integrityManifest: z.string() })`
  - `listInstalledModels()`：扫 `modelsDir/*`；`manifestSchema.safeParse(manifest)` 失败 → **跳过**；成功 → 读 `integrity.json`（`integritySchema`：`{ files: IntegrityEntry[] }`），`files` 每条检查文件存在 + size 匹配；全过 → available=true，否则 available=false；`version` 取 manifest.version ?? '0'；`preview` 取 manifest.preview ?? null；`integrityState` 初始 'unverified'。
  - `resolveModelFile(modelId, relPath)`：dir = `join(modelsDir, modelId)`；`realpath(dir)` 与候选 `realpath(join(dir, relPath))` 的 prefix containment（复用 protocol 侧 containment 思路，Linux/win 大小写归一）；**`lstat` 候选仅普通文件**（FIFO/设备/symlink 拒，safe-open 同款纪律——防 `net.fetch` 挂起）；relPath ∈ integrity entries（key 匹配）且 size 一致 → 返回绝对路径；否则 null。
  - `verifyIntegrity(modelId)`：**pending 共享** —— `private pending = new Map<string, Promise<boolean>>()`；`const p = (async () => { const ok = await verifyIntegrityAgainst(dir, entries); if (ok) verified.add(modelId) else failed.add(modelId); return ok })(); this.pending.set(modelId, p); p.finally(() => this.pending.delete(modelId))`；返回复用同 promise。
- [ ] **Step 3: IPC 通道 + schema + preload**：
  - `shared/contracts/ipc.ts` IpcChannels 增 `live2dListModels: 'live2d:list-models'`
  - `shared/schemas/ipc-response.ts` 增 `Live2DModelSummarySchema`/`Live2DListResponseSchema`（与既有响应 schema 同区）
  - `main/ipc/channels.ts` 增 `export const live2dListModelsSchema = z.undefined()`（无参）
  - `main/ipc/live2d-handlers.ts`：`registerHandler(IpcChannels.live2dListModels, createIpcHandler(live2dListModelsSchema, Live2DListResponseSchema, () => registry.listInstalledModels(), { sanitize, channel, logger }), 0)`（sanitize 只留 id+available+reason 白名单，响应脱敏）
  - `main/ipc/handlers.ts` registerHandlers 入参增 `live2d: { registry }` 并登记
  - `main/index.ts`：装配 `new Live2DModelRegistry({ modelsDir: dirs.models })`，传入 registerHandlers
  - `preload/desktop-api.ts`：`async function listLive2dModels(): Promise<Live2DModelSummary[]>`（**arity-0 用 `invoke` 风格**：`unwrap(await invoke<Live2DModelSummary[]>(IpcChannels.live2dListModels), z.array(Live2DModelSummarySchema))`，与既有 `listStickers` 等一致）；导出对象增 `listLive2dModels`；`index.d.ts` DesktopApi 类型同步
- [ ] **Step 4: 写单测 `live2d-registry.spec.ts`**（内存临时目录 + 自建 fixture）：
  - 两级可用性：① manifest 缺 `licenseRef`/`id` 非法 → 不列出；② 合法但 integrity 覆盖文件缺失/size 不符 → 列出且 available=false；③ preview 缺失 → 仍 available=true；
  - `listInstalledModels` 返回字段正确（version/preview/licenseRef/integrityState）；
  - `resolveModelFile` containment：`../`、绝对路径、`%2F` 走私段、symlink 逃逸、跨模型目录 → null；白名单内路径 + size 匹配 → 绝对路径；
  - `verifyIntegrity`：hash 匹配 true / 篡改 false + 熔断（再次 resolveModelFile → null 或 available=false）；并发两次 verify 共享同一 pending（spy 调用一次）；
  - manifest 生成用 `computeIntegrity`（先于 registry 构造写盘），验证 manifest.json/integrity.json 不在 entries 里。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test`（live2d-registry.spec）+ `typecheck` + `lint` 绿。
- [ ] **Step 6: Commit** `feat(阶段5批次A): Main 模型注册表（manifest+integrity 两级可用性 + fail-closed verify）+ live2d:list-models IPC`

---

### Task 3（A4）: cyrene:// live2d 供给分支

**Files:**
- Create: `apps/desktop/src/main/protocol/live2d-path.ts`
- Create: `apps/desktop/tests/unit/live2d-path.spec.ts`、`apps/desktop/tests/unit/protocol-live2d.spec.ts`
- Modify: `apps/desktop/src/main/protocol/handler.ts`（分支 + `resolveLive2d` 注入 + dev ACAO）
- Modify: `apps/desktop/src/main/index.ts`（接线 `resolveLive2d`：registry 组合 + mime + no-store + fail-closed + CORS）

**Interfaces:**
- Consumes: `Live2DModelRegistry`（Task 2）；`isTrustedDevUrl`（trusted-renderer-origin.ts:38）；`mimeOf`（protocol/mime.ts）；`isDocumentRequest`（media-service.ts）
- Produces:
  - `protocol/live2d-path.ts`：`export const LIVE2D_PATH_PREFIX = '/__cyrene-live2d/'`；`export function parseLive2dPath(pathname: string): { modelId: string; relPath: string } | null`（按 `/` 分段——第 1 段为 modelId，校验 `^[A-Za-z0-9._-]+$` 且非 `.`/`..`；其余段逐个 `decodeURIComponent` 逐段校验：拒绝空段、`.`、`..`、解码后含 `/`、`\`、NUL 的段；返回 `relPath` 以 `/` join；非法 → null）
  - handler `CyreneProtocolOptions.resolveLive2d?: (modelId: string, relPath: string, request: Request) => Promise<Response>`（缺省 404）

- [ ] **Step 1: `parseLive2dPath` + 单测矩阵**（live2d-path.spec.ts）：合法（`/__cyrene-live2d/haru/model3.json`、Unicode 段）；非法（空段、`..`、`./`、modelId 超字符集、modelId=='.'/'..'、`%2F` 解码后含 `/`、`%5C`、`%00`、未知前缀）；`__cyrene-` 前缀与 media 互斥（`/__cyrene-media/...` 不被 live2d parse）。
- [ ] **Step 2: handler 分支**（`handler.ts`，在 media 分支后、`if (!realRoot)` 前插入）：
```ts
if (url.pathname.startsWith(LIVE2D_PATH_PREFIX)) {
  const parsed = parseLive2dPath(url.pathname)
  if (!parsed) return new Response('Forbidden', { status: 403 })
  if (!resolveLive2d) return new Response('Not Found', { status: 404 })
  if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
  try {
    return await resolveLive2d(parsed.modelId, parsed.relPath, request)
  } catch {
    return new Response('Bad Gateway', { status: 502 })
  }
}
```
- [ ] **Step 3: main/index.ts 装配 `resolveLive2d`**（组合闭包）：
  - 逻辑：`registry.verifyIntegrity(modelId)` 失败或 `!available` → 404（fail-closed：首命中 await）；`const abs = await registry.resolveModelFile(modelId, relPath)` → null → 403；有 abs → `net.fetch`/`readFile` 流（用 `net.fetch(pathToFileURL(abs))` 同 renderer-root 手法）+ `content-type: mimeOf(abs)` + `cache-control: no-store`；
  - **dev CORS**：`const origin = request.headers.get('origin')`；`origin && isTrustedDevUrl(new URL(origin), getTrustedDevOrigins())` → 成功与错误响应均回补 `Access-Control-Allow-Origin: origin` + `Vary: Origin`（4xx/5xx 也回补）。
- [ ] **Step 4: 协议单测 `protocol-live2d.spec.ts`**（小型 Fake registry 注入）：document 请求 403；未知/!available modelId 404（且 verifyIntegrity 被调用、fail-closed 时序——用 deferred promise 断言首个请求等完 hash 才响应）；白名单外 403；白名单内 200 + mime + no-store；dev Origin（`http://localhost:5173`）ACAO+`Vary`、非受信 Origin 无 ACAO、错误响应也带 ACAO。
- [ ] **Step 5: 运行** `test`（live2d-path/protocol-live2d）+ `typecheck` + `lint` 绿。
- [ ] **Step 6: Commit** `feat(阶段5批次A): cyrene:// __cyrene-live2d 供给分支（containment+白名单+fail-closed hash+dev CORS）`

---

### Task 4（A5）: 装配工具 CLI

**Files:**
- Create: `apps/desktop/scripts/live2d-install.mjs`
- Create: `apps/desktop/tests/unit/live2d-install.spec.ts`
- Modify: `apps/desktop/package.json`（`live2d:install` script）

**Interfaces:**
- Consumes: `manifest.ts`（Task 2）`hashFile`/`computeIntegrity`（CLI 以 **strip-types 方式 import TS**，见下）；`expectedUserDataBase()`（`main/app/lifecycle.ts:12` 的 `join(app.getPath('appData'), 'Cyrene')` 语义，CLI 自行镜像解析）
- Produces: `pnpm -F @cyrene/desktop live2d:install --model-dir <dir> --id <slug> --display-name <name> [--license-note <file>] [--force]` —— 输出装配报告（文件数/字节/hash 数）到 `userData/models/<id>/`

- [ ] **Step 1: CLI 骨架（strip-types 先例）**：入口 `scripts/live2d-install.mjs`，顶部 `import { hashFile, computeIntegrity } from '../src/main/live2d/manifest.ts'`（node `--experimental-strip-types` 支持 .mjs import .ts，与 `check-backend-contract.mjs` 同模式）；package.json：`"live2d:install": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/live2d-install.mjs"`。
- [ ] **Step 2: userData 镜像解析**：纯函数 `resolveModelsDir(env): string`——Linux `XDG_CONFIG_HOME ?? $HOME/.config` `/Cyrene/models`；Windows `%APPDATA%`；macOS `$HOME/Library/Application Support/Cyrene/models`。单测断言各平台 env 矩阵产出**路径字面量**（与 `expectedUserDataBase` 的平台公式一致，不 import 它——其依赖 `app.getPath` 无法在 vitest import）；Electron 真实真值对比放 Task 7 用例 9。
- [ ] **Step 3: 流程（按 spec §3.5 顺序）**：(1) 校验 src 存在 model3.json/moc3/≥1 纹理（stat 非目录）；(2) id 校验 `^[A-Za-z0-9._-]+$` 且非 `.`/`..`；目标 `models/<id>` 已存在且无 `--force` → 退出码 1；(3) `fs.cp(src, dst, { recursive: true, filter: 仅普通文件非 symlink })`（非 symlink 拷贝）；(4) 注入 `LICENSE.txt`（`--license-note` 内容或缺省「免费版·个人开发验证」注记 + 来源占位）；(5) 生成 `manifest.json`（必填：`id`/`displayName`/`modelFile`/`licenseRef: "LICENSE.txt"`/`integrityManifest: "integrity.json"` + 可选：`preview` 有 icon.png 则拷为 preview.png，`version/motions/expressions` 读 model3.json 可选）；(6) `computeIntegrity(dst)` → `integrity.json`（`{ files: [...] }`，排除 manifest/integrity 自身，含 LICENSE.txt/preview.png）；(7) 报告。
- [ ] **Step 4: 单测 `live2d-install.spec.ts`**（tmp 源 fixture + env 指向 tmp userData）：装配完整（文件布局/manifest 字段含 `integrityManifest:'integrity.json'`/integrity 排除 manifest 自身且含 LICENSE/preview）；缺纹理/非目录/非法 id → 非零退出；`--force` 覆盖、无 `--force` 拒绝；`resolveModelsDir` 跨平台 env 矩阵（`XDG_CONFIG_HOME`/`APPDATA`/`HOME` 覆写，各平台产出 `.../Cyrene/models`）。**CLI 与 Electron 真实 `app.getPath('appData')` 的恒等对比放在 Task 7 集成**（vitest 单测无法 import electron，见 I2）。
- [ ] **Step 5: 本机装配两个模型**：`pnpm ... live2d:install --model-dir third_party/.../Samples/Resources/Haru --id haru --display-name Haru` + `--model-dir tmp/live2d/修女莉尔免费版/修女莉尔免费版 --id lil --display-name 修女莉尔`（用 `CYRENE_TEST_USERDATA`/env 指向本机 userData；确认两模型 manifest/integrity 生成且 registry 单测可列）。
- [ ] **Step 6: 运行** `test`（live2d-install.spec）+ `typecheck` + `lint` 绿。
- [ ] **Step 7: Commit** `feat(阶段5批次A): 装配工具 live2d:install——manifest+integrity+license note 拷贝装机`

---

### Task 5（A2）: CubismGL 极薄 GL 面 + Live2DAdapter

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/gl/types.ts`、`gl/webgl.ts`、`gl/fake.ts`
- Create: `apps/desktop/src/renderer/src/live2d/adapter.ts`
- Create: `apps/desktop/tests/unit/live2d-adapter.spec.ts`

**Interfaces:**
- Consumes: `@framework/*`（Task 1）—— 具体用 `@framework/live2dcubismframework`、`@framework/rendering/cubismrenderer_webgl`、`@framework/model/cubismmodel`（实现者参照 vendored Framework 的真实导出）；全局 `Live2DCubismCore`
- Produces:
  - `gl/types.ts`：`export interface Live2DGLEngine { createContext(canvas, attrs): WebGLRenderingContext | null; isContextLost(gl): boolean; getMaxTextureSize(gl): number; onContextLost(canvas, cb): () => void }`（真实 WebGL1 实现于 `webgl.ts`；fake 于 `fake.ts`）
  - `adapter.ts`：`export class Live2DAdapter { constructor(deps: { engine: Live2DGLEngine; fetchImpl?: typeof fetch }); initialize(canvas): boolean; createModel({ modelId, model3Path }: { modelId: string; model3Path: string }): Promise<Live2DModelHandle>; update(): void; destroy(): void }`；`export interface Live2DModelHandle { update(dt): void; draw(): void; destroy(): void }`；错误类型 `Live2DGpuLostError`、`Live2DTextureError`

- [ ] **Step 1: GL 面实现**：`webgl.ts` = `canvas.getContext('webgl', { alpha: true, antialias: false, depth: false })`；`getMaxTextureSize` = `gl.getParameter(gl.MAX_TEXTURE_SIZE)`；`onContextLost` 注册/返回注销。`fake.ts` 暴露可注错实现（`getMaxTextureSize` 可配、`createContext` 可返回 null、`isContextLost` 可切 true）。
- [ ] **Step 2: Adapter 生命周期**：
  - `initialize(canvas)`：`engine.createContext` 失败 → false；`CubismFramework.startUp(option)` → `CubismFramework.initialize()`（**官方序列**，见 spec I-1）；返回 true。
  - `createModel`：`fetch('cyrene://renderer/__cyrene-live2d/' + modelId + '/' + model3Path)` → 解析 model3.json → 构建 URL 加载 moc3/纹理/physics（FileReferences 以 model3.json 目录为 base）——**modelId 为 ASCII slug 不编码**（D5A-04）；**relPath 各段 `encodeURIComponent` 编码**（中文文件名如修女莉尔，与 `parseLive2dPath` 的 percent-decode 对齐）→ `CubismModel` + 渲染器 `renderer.loadShaders('/live2d/shaders/')`（首次 draw 前）→ 纹理尺寸超 `getMaxTextureSize` 或创建失败 → 抛 `Live2DTextureError`；返回 handle。
  - `update()`：`CubismModel.update()` + 物理 + `renderer.drawModel('/live2d/shaders/')`；contextlost 事件 → 抛 `Live2DGpuLostError`。
  - `destroy()`：`renderer.release()`（`CubismRenderer_WebGL.release()`，renderer_webgl.ts:692）、`model.release()`（`CubismModel.release()`，cubismmodel.ts:1856）、移除 contextlost 监听、`CubismFramework.dispose()`（组件销毁时序由 Controller 编排，本处释放单模型）。
  - **签名注（M4）**：plan 用 `createModel({ modelId, model3Path })` 对象签名实现 spec §3.2 的 `createModel(modelUrlBase, modelId)`——功能等价（modelUrlBase 即 `cyrene://renderer/__cyrene-live2d/{modelId}/`），以对象签名收口避免位置参数歧义。
  - fetch 注入：`deps.fetchImpl ?? fetch`（单测注入记录器）。
- [ ] **Step 3: 单测 `live2d-adapter.spec.ts`**（fake engine + fake fetch 记录 + fake GL 上下文对象）：
  - initialize：engine 返回 null → false；成功 → startUp/initialize 调序（spy 内 `CubismFramework.startUp` 先于 `initialize`，无 `getInstance().reinitialize`）；
  - createModel：fetch 按 `cyrene://renderer/__cyrene-live2d/{id}/{path}` 逐文件（model3 → moc3 → texture）；纹理超 `maxTextureSize` → 抛 `Live2DTextureError`；GPU-lost → 抛 `Live2DGpuLostError`；
  - update/destroy：销毁后无残留 listener（`onContextLost` 返回的注销函数被调）+ handle.destroy 幂等；
  - **注**：Framework 内部渲染调用不在此单测覆盖（其为即 WebGL 集成域，见 Task 7/真机）。
- [ ] **Step 4: 运行** `test`（live2d-adapter.spec）+ `typecheck` + `lint` 绿。
- [ ] **Step 5: Commit** `feat(阶段5批次A): Live2DAdapter——CubismFramework 序列 + 模型加载/更新/销毁 + CubismGL 极薄 GL 面`

---

### Task 6（A6）: Controller + live2dStore + settings 契约 + CyLive2DPanel 最小面

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/controller.ts`
- Create: `apps/desktop/src/renderer/src/stores/live2d.store.ts`
- Modify（settings 契约面）: `apps/desktop/src/shared/contracts/live2d.ts`（新建）、`src/shared/contracts/voice.ts`、`src/shared/schemas/ipc-response.ts`、`src/main/settings/settings-service.ts`、`src/renderer/src/stores/settings.store.ts`
- Modify: `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue`
- Test: `apps/desktop/tests/unit/live2d.spec.ts`（controller+store）、`tests/unit/settings-service.spec.ts`、`tests/unit/settings.store.spec.ts`

**Interfaces:**
- Consumes: Task 2 `live2d:list-models`（preload `listLive2dModels()`）；Task 3 cyrene:// URL；Task 5 `Live2DAdapter`；settingsStore（P4-B）
- Produces:
  - `shared/contracts/live2d.ts`：`export interface Live2DSettings { enabled: boolean; modelId: string | null }`；`export interface Live2DModelSummary { id: string; displayName: string; preview: string | null; version: string; available: boolean; reason?: string; licenseRef: string; integrityState: 'unverified'|'verified'|'failed' }`
  - `controller.ts`：`export class Live2DController { constructor(deps: { adapter: Live2DAdapter; list: () => Promise<Live2DModelSummary[]> }); readonly status: 'unloaded'|'loading'|'ready'|'failed'|'fallback'; async init(canvas): Promise<void>; async switchModel(id): Promise<void>; async unload(): Promise<void>; setVisibility(v): void; setPerformanceMode(m): void; async reset(): Promise<void>; on(event, cb): void }`（setState/setExpression/playMotion/setMouthLevel/setLookTarget 为 no-op 占位）
  - `live2d.store.ts`：`init()/switchModel(next)/dispose()` + `models/status/modelId/error/live2dSettings`

- [ ] **Step 1: settings 契约扩展（顺序敏感，先做）**：
  - `shared/contracts/live2d.ts`：上两类；
  - `shared/contracts/voice.ts`：`SettingsState` 增 `live2d: Live2DSettings`；`SettingsPatch` 增 `live2d?: Partial<Live2DSettings>`；
  - `shared/schemas/ipc-response.ts`：`export const DEFAULT_LIVE2D: Live2DSettings = { enabled: true, modelId: null }`；`SettingsStateSchema` 的 live2d 字段用 `z.object({ enabled: z.boolean(), modelId: z.string().nullable() }).default(DEFAULT_LIVE2D)`；`DEFAULT_SETTINGS` 增 `live2d: DEFAULT_LIVE2D`；**`SettingsPatchSchema` 增嵌套 `live2d: <live2d 子 schema>.partial().optional()`**（镜像既有 `VoiceSettingsSchema.partial()` 模式，Important A——`settingsSaveSchema = SettingsPatchSchema`（channels.ts:141），zod v4 默认剥未知键，缺此则 `{ live2d }` patch 在 Main handler 被剥掉，下方三处接线 + Task 7 持久化全成死代码）；
  - `main/settings/settings-service.ts` `save()` 增第三 merge 行 `live2d: { ...this.state.live2d, ...patch.live2d }`（`next` 构造内）；
  - `renderer/settings.store.ts`：增 `live2d` ref（缺省 `DEFAULT_LIVE2D`）+ `setLive2d(patch: Partial<Live2DSettings>)`（复制 `setVoice` 模式）+ **三处接线（I1，缺则静默丢 live2d 持久化）**：① `hydrate()` 读 `state.live2d`；② `scheduleSave()` pending 合并增第三键 `live2d: patch.live2d ? { ...pending.live2d, ...patch.live2d } : pending.live2d`（防 500ms 窗口内 voice 与 live2d 混改丢子树）；③ `persist()` 早退条件改 `if (!pending.voice && !pending.dictation && !pending.live2d) return` 且 post-save 回写增 `live2d.value = { ...state.live2d }`。
- [ ] **Step 2: 契约单测**：`settings-service.spec.ts` 增「无 live2d 段旧 file 正常加载（默认 enabled:true/modelId:null，不动 version）」+「部分 patch `{enabled:false}` 保留 modelId」；`ipc-response-schema.spec.ts` 增 DEFAULT/Schema 形状断言。
- [ ] **Step 3: Controller**：状态机 `unloaded→loading→ready|failed→fallback`（`device_lost` 事件 → failed）；`init` 用 adapter.initialize + 默认模型（list 里第一个 available 或 settings.modelId）；`switchModel` 停当前 → adapter.createModel → 成功原子替换（失败保留原 id 置 error）；`unload/reset` 释放；event emitter 极简（on/emit）。**`createModel` 的 `model3Path` 恒传 `'model3.json'`**（A5 强制该文件存在且 manifest.modelFile 指向之，Controller 不读 summary.modelFile——Minor G）。
- [ ] **Step 4: live2dStore**：`models`/`status`/`modelId`/`error` 镜像 controller；`init()`（list→`setLive2d` 读 enabled/modelId→load）；`switchModel(id)`（controller.switchModel + `setLive2d({ modelId })` 持久化）；`dispose()`。
- [ ] **Step 5: CyLive2DPanel.vue 改造**：保留已挂载的 G1 结构（resizer/折叠/状态栏/`grid-area: live`）；stage 内放 `<canvas>` + 模型 `<select>`（options 来自 store.models，disabled 选中项按 available）+ 状态文案（ready/failed/fallback/「Live2D 已关闭」）；`enabled=false` → 不创建渲染循环显示关闭态；resize → 重设 canvas 尺寸；`onBeforeUnmount` → `store.dispose()`。挂载点不动（App.vue:73）。
- [ ] **Step 6: 单测 `live2d.spec.ts`**（fake adapter/list + fake GL）：store.init 默认模型选择；switchModel 失败保留原 modelId + error；device_lost→fallback 状态；dispose 无残留（adapter.destroy spy）；`enabled=false` 不 load。
- [ ] **Step 7: 运行** `test`（live2d.spec/settings-*）+ `typecheck` + `lint` + `build` 绿。
- [ ] **Step 8: Commit** `feat(阶段5批次A): Live2DController + live2dStore + settings live2d 契约（default 兼容）+ CyLive2DPanel 最小面`

---

### Task 7（A7）: Electron 集成测试（全链路验收）

**Files:**
- Create: `apps/desktop/tests/integration/electron-live2d.spec.ts`
- Modify: `apps/desktop/tests/integration/helpers/app.ts`（如需装配注入 env）

**Interfaces:**
- Consumes: Task 1-6 全部落地；`CYRENE_TEST_USERDATA`/既有 harness env 覆写；A5 装配产物（Haru 于第三方已入库；修女莉尔 skip-when-absent）
- Produces: 批次 A 验收证据（首帧/切换/失败回退/设备丢失/折叠/持久化/协议安全）

- [ ] **Step 1: 装配 fixture 到测试 userData**：在 `beforeAll` 用 `node --experimental-strip-types scripts/live2d-install.mjs`（或直接调 manifest.ts 生成）把 Haru 装进 harness userData（`appDataKey` env 覆写，参照既有 `launchApp`）；修女莉尔存在则装、否则 skip。
- [ ] **Step 2: 用例**（沿用纪律：真实点击 bounding box、无 force、`expect.poll`、`count()===0` 判缺席、xvfb-run）：
  1. 启动 → 右栏显示 → `live2d:list-models` 含 haru(then lil if present) 且 available；
  2. **首帧**：拉取默认模型 → store status=ready + `canvas.getImageData` 采样存在非透明像素 + 无 console error；
  3. **切换**：选择另一模型 → ready（或 D5A-11 静态头像回退且不 crash）；
  4. **损坏注入**：装配目录里篡改一个模型文件（改 size 或内容）→ 重载 → failed 保留原模型 + 聊天输入可用；
  5. **协议安全**：`page.evaluate(fetch('cyrene://renderer/__cyrene-live2d/haru/../../../etc/passwd'))` → 4xx；document 请求 → 403；
  6. **设备丢失**：释放 canvas 渲染上下文（或注入 engine.isContextLost=true 路径）→ 静态头像 + 聊天可用；
  7. **折叠**：折叠右栏（live2dShown=false）→ 渲染循环停止（断言 canvas draw 计数不增 / rAF 无新帧）；
  8. **持久化**：切换 modelId 后重启 app → 恢复所选模型；
  9. **CLI/Electron appData 恒等（I2）**：`_electron` 内读 `app.getPath('appData')` → 与 CLI `resolveModelsDir` 在相同 env 下的输出对比（防装配路径漂移）；
  10. **asm.js 运行时探针（M5/A1 spike①）**：`page.evaluate` 断言 `typeof window.Live2DCubismCore === 'object'` 且 `Live2DCubismCore.Version.csmGetVersion()` 为 number；加载栈无 `WebAssembly.compile/instantiate`（可经 DevTools `performance` 或 console 过滤确认）；shader fetch 路径（spike②）由用例 2 首帧隐式覆盖。
  - **注（M5/spike③）**：dev 页（http://localhost:5173）跨源 fetch `cyrene://` 在 `test:integration`（prod out，同源）不可复现——归本机手动冒烟验证（dev `connect-src`+ACAO 已有 Task1/3 单测兜底），记录于批次 C 真实联调。
- [ ] **Step 3: 运行** `pnpm -F @cyrene/desktop test:integration`（electron-live2d.spec + 既有 15/73 回归）全绿；`build`。
- [ ] **Step 4: Commit** `test(阶段5批次A): Electron 集成——首帧/切换/失败回退/设备丢失/折叠/持久化`

---

## 任务顺序依赖

```
Task1(A1 vendoring+构建+CSP) ──► Task5(A2 adapter，@framework import)
                                   └─► Task6(A6 controller/store/panel，依赖 IPC+URL+adapter)
Task2(A3 registry+IPC) ──► Task3(A4 协议分支，依赖 registry)
Task4(A5 装配 CLI，独立，import manifest.ts)   ↔ Task2(manifest.ts 共用)
Task7(A7 集成) ◄── Task1-6 全部 + Task4 装配产物
```

执行序 1→2→3→4→5→6→7（SDD 串行；2/4 共用 manifest.ts 但无文件写冲突——Task4 只 import 只读）。

## Self-review notes（写作时已核）

- spec 全覆盖：D5A-01~13 逐条对到 Task1-7（D5A-02b shader→Task1/5；D5A-03 CSP→Task1；D5A-07→Task2；D5A-08→Task3；D5A-09→Task4；D5A-10→Task6；D5A-11/12/13→Task5/7；D5A-04/05/06→Task4/6/7）。
- 无 placeholder：每 task 步骤含真实文件/签名/断言；SDK 内部实际导出由实现者以 vendored Framework 为准（plan 已给关键 API 名与调用序）。
- 类型一致：`Live2DModelSummary`/`IntegrityEntry`/`Live2DSettings`/`resolveModelFile(modelId,relPath)`/`parseLive2dPath` 跨 task 命名统一。
- 落点一致：`IpcChannels.live2dListModels`、`settings-store.setLive2d`、`electron.vite.config.ts` alias、`main/index.ts` 接线均在对应文件正确位置；Framework 类型走 ambient（`framework.d.ts`，**不加** tsconfig paths），Core 类型走 vendored `live2dcubismcore.d.ts`，eslint ignore `live2d/framework/**`。