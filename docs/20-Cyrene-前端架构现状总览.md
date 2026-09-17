# Cyrene 前端架构现状总览（as-built）

**文档状态：** 维护中
**最后核验：** 2026-09-17
**适用阶段：** 全阶段
**权威范围：** 代码的结构现状——进程与信任边界、模块地图、启动与退出次序、关键数据流、契约面与门禁归属；不含进度、阻塞项与验证结论
> **与 [doc 01](01-Cyrene-Electron-前端总体架构设计-v0.2.md) 的分工（两份不可互相替代）：**
> - doc 01 = **设计口径**（状态「参考」，阶段 1～7 架构基线）：写「应当是什么样」，其中若干段落已被代码取代并就地标注（例：§6.2 的 `DesktopApi` 方法集，注记原文即「照它实现会走错」）。
> - 本文 = **现状口径（as-built）**：只写「代码现在是什么样」。每条结论在落笔时对码核对，并给出落点文件，便于读者自行复核。
> - **本文不转述 review / 审计记录里的结论句**：那些句子可能在写下之后就被修掉。实例：2026-09-16 审计报告把签名 URL 策略记为「只做 scheme 白名单」，而该报告的基线 commit `8918fdd` 上 `attachments/media-service.ts:69-86` 已有完整的地址类别策略。本文只认代码。
> - **冲突处理**：运行行为以代码、运行时 Schema 与测试为准（[doc 00](00-Cyrene-前端文档索引与阅读顺序.md) §7）。本文与代码不符时以代码为准，并就地修正本文。
> - **本文不是状态源**：阶段、阻塞项、最近验证、下一步一律读 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)。已知缺口与未修项也不在本文复制，只指向 doc 16 §5 与 `docs/review/` 的最新记录。

---

## 0. 一页速览

| 项 | 事实（计数口径与复核命令见 §7） |
|---|---|
| 是什么 | Electron 桌面 AI 助手客户端：聊天 + Live2D 角色 + 桌面工具与权限 + 语音 + 附件，接外部 Python 后端 |
| 进程边界 | 3 个：Main（特权）/ Preload（窄桥）/ Renderer（不可信）。另有文档中的可选 Local Worker，`src/main` 无对应模块（未实现） |
| 运行时生产依赖 | 只有 3 个：`diff`、`ws`、`zod`（`vue` / `pinia` / `marked` / `dompurify` 刻意放 devDependencies，由 Vite 打进 renderer chunk） |
| 工具链 | Node 22.23.0（[.nvmrc](../.nvmrc)）· pnpm 11.20.0 · Electron 43.3.0 · electron-vite 5 · Vitest 4 · Playwright `_electron`（不是 `@playwright/test`） |
| IPC 面 | 命令通道 **89** · Main→Renderer 推送通道 **8** · 单向通道 **1**（`voice:audio-chunk`，1 MiB/块）；单条 IPC 上限 **4 MiB** |
| 后端面 | WS v2 帧 + REST 双面适配；raw schema 与 mapper 全在 `src/main/transport/protocol-v2/` |
| 存储面 | `safeStorage` 凭据（不可读回）+ userData 子目录（fd 锚点 / `lstat`+`realpath` 守卫）+ 原子写 |
| 代码规模 | `src/main` 167 文件 · `src/preload` 3 · `src/renderer` 227（`.vue` 60）· `src/shared` 34 · `tests` 345 |
| 门禁 | 见 §5.2（契约面）、§5.3（本地命令与 CI）、§5.4（依赖方向矩阵与 architecture gate 清单） |

---

## 1. 系统边界与进程模型

```text
┌─ Renderer（不可信）────────────────────────────────────────────┐
│  Vue 3 + Pinia：表现与 UI 状态（store = facade，域逻辑在纯 TS 模块）│
│  components(61) · stores(22) · live2d(75) · utils(23)            │
│  域逻辑：message(6) · conversation(3) · voice(3) · composer(1)    │
│          character-editor(2)                                     │
└──────────────▲────────────────────────────────┬────────────────┘
               │ window.cyrene：具名窄 API        │ 推送：chat:event / tool:event / …
┌──────────────┴────────────────────────────────▼────────────────┐
│  Preload：contextBridge，无 ipcRenderer 直通、无 Node 模块        │
│  唯一 API 面 desktop-api.ts；每方法运行时 schema 校验              │
└──────────────▲────────────────────────────────┬────────────────┘
               │ invoke(具名通道)                 │ 单向 send：voice:audio-chunk
┌──────────────┴────────────────────────────────▼────────────────┐
│  Main：凭据、后端连接、文件系统、工具执行、审计、日志、raw 协议解析  │
│  ipc · transport · tools · attachments · characters · chat       │
│  persistence · credentials · diagnostics · protocol · live2d     │
└──────────────┬────────────────────────────────▲────────────────┘
               │ WS v2（帧）+ REST（HTTP）        │
        ┌──────▼────────────────────────────────┴──────┐
        │  外部后端（Python，独立系统，不随前端改名）      │
        └──────────────────────────────────────────────┘
```

**不变式与「谁在守它」**（不变式本身是长期约束，落点是当前实现）：

| 不变式 | 落点 |
|---|---|
| Main 独占秘密与特权操作 | `credentials/credential-store.ts`（safeStorage + origin 双绑）、`tools/tool-executors.ts` |
| Renderer 拿不到明文凭据、绝对路径、`ipcRenderer`、Node 模块、通用文件/Shell 方法 | `preload/desktop-api.ts`（唯一 API 面）、`shared/contracts/ipc.ts`、`verify-sensitive` 扫描 |
| 禁止通用 IPC（`invoke(channel)` / `readFile(path)` / `exec(command)`） | `ipc/registry.ts`（具名通道 + 双端 zod）、`ipc/executor.ts` |
| 导航 / IPC 来源 / CSP / 自定义协议 / 路径包含 / Fuses 一律 fail-closed | `windows/navigation.ts`、`ipc/registry.ts` 的 sender 三重校验、`protocol/csp.ts`、`protocol/path.ts`、`scripts/verify-artifact.cjs` |
| 窗口、原生对话框、通知只有唯一入口 | `windows/window-presentation.ts`、`native-ui/dialog-service.ts`；`window-presentation-guard.spec.ts` 对新增调用点直接红 |
| 后端工具只做展示；Desktop/本地工具只在 Main 执行；风险本地重算 | `tools/tool-policy.ts`、`tools/tool-service.ts` |
| Application Service 只拿得到自己声明的后端能力（不持有聚合 `BackendAdapter`） | `transport/backend-ports.ts` 的 7 个领域端口；`backend-capability-ports.spec.ts` 对"消费方 → 端口"与聚合面持有者直接红 |
| Live2D 是纯表现，加载失败不阻塞聊天 | `renderer/src/live2d/`、`main/live2d/serve-gate.ts` |
| 本地绝对路径不进入 Renderer store 或后端载荷 | `preload/desktop-api.ts` 的 `toIpcDescriptor`（`File` → 不可猜 `fileRef`）、`attachments/file-ref.ts` |

**与后端的权力划分：** 后端是外部系统。原始 wire schema 与 REST mapper 全部留在 Main；Renderer 只消费稳定域事件。**本机不存在权威后端仓库副本**，契约事实只能由真实后端或 `check:contract` 门禁产出。

---

## 2. 模块地图

### 2.1 Main（`apps/desktop/src/main/`）

根文件 3 个：`index.ts`（**组合根**：只编排生命周期阶段，见下）、`shutdown.ts`（有序退出与 fatal 收尾）、`env.d.ts`。

`index.ts` 只做阶段编排——`prepareElectronRuntime` → `createInfrastructure` → `createTransport` →
`createApplicationServices` → `wireApplicationServices` → `registerApplicationIpc` →
`installShutdownSequence` → `installTestProbe` → `startApplication`；**具体构造、handler 注册、
跨服务接线都在 `bootstrap/` 各阶段模块里**（2026-09-17 架构整改 Prompt 2）。`main()` 不再直接
import 具体服务：`main-dependency-graph.spec.ts` 钉住它的导入面只允许 `bootstrap/**`、`config`、`windows`。

| 目录 | 文件 | 职责 | 代表文件 |
|---|---:|---|---|
| （根）`bootstrap/` | 10 | **组合根各生命周期阶段**：pre-ready（ready 前 Electron 初始化）/ infrastructure（诊断、userData、凭据、连接配置）/ transport（Real/Mock 适配器 + mock 夹具 env 桥）/ services（业务服务构造）/ wire（跨服务接线）/ register-ipc（通道装配）/ shutdown-sequence（before-quit 编排）/ start-application（协议供给与建窗）/ runtime-guards（崩溃与进程兜底装配）/ test-probe（harness 探针） | `pre-ready.ts`、`infrastructure.ts`、`services.ts`、`wire.ts`、`start-application.ts` |
| `app/` | 5 | 生命周期、单实例、应用身份、进程级错误兜底（含 `child-process-gone` 的 GPU 分支）、测试 appData 门 | `lifecycle.ts`、`process-error-guards.ts`、`test-app-data.ts` |
| `windows/` | 7 | 窗口创建与呈现的**唯一入口**、导航门、麦克风权限、Renderer 控制台转发 | `window-presentation.ts`、`main-window.ts`、`navigation.ts`、`mic-permission.ts` |
| `native-ui/` | 1 | 原生对话框唯一入口（silent 模式下返回确定性取消） | `dialog-service.ts` |
| `ipc/` | 9 | 通道注册表、参数校验、载荷预算、各域 handler 装配 | `registry.ts`、`executor.ts`、`channels.ts`、`channel-budgets.ts`、`handlers.ts` |
| `transport/` | 17 | **后端能力端口**（7 个领域端口，2026-09-17 Prompt 3）+ `BackendAdapter` 聚合面（= 端口交集 + 接线槽）、real/mock 两实现、存活检测、protocol-v2 帧与 REST 映射 | `backend-ports.ts`、`backend-adapter.ts`、`real-backend.ts`、`mock-backend.ts`、`connection-liveness.ts`、`protocol-v2/frame-mapper.ts` |
| `tools/` | 16 | 工具注册表、风险重算、授权存储、参数哈希、审计、执行器、审批历史、文件身份；**共享执行契约与数值策略**（2026-09-17 起，解 `tool-service ↔ tool-executors` 值导入环） | `tool-policy.ts`、`tool-service.ts`、`tool-executors.ts`、`tool-execution-contract.ts`、`tool-limits.ts`、`grant-store.ts`、`param-hash.ts`、`file-identity.ts` |
| `attachments/` | 5 | 附件校验/上传/媒体状态、`fileRef` 令牌表、媒体字节路由与签名 URL 策略 | `upload-service.ts`、`attachment-policy.ts`、`file-ref.ts`、`media-service.ts` |
| `characters/` | 7 | 多角色域：服务、后端端口、草稿、装配、mock | `character-service.ts`、`character-backend-port.ts`、`character-service-assembly.ts` |
| `chat/` | 3 | 会话与消息编排、后端错误上提 | `chat-service.ts`、`chat-handlers.ts`、`backend-error-handlers.ts` |
| `persistence/` | 9 | userData 子目录守卫、会话/角色草稿存储、写失败语义、损坏隔离、退出 flush | `user-data-dirs.ts`、`session-store.ts`、`persist-flush.ts`、`safe-open.ts`、`write-failure.ts` |
| `credentials/` | 5 | `safeStorage` 加密凭据、原子写 | `credential-store.ts`、`safe-storage.ts`、`atomic-write.ts` |
| `diagnostics/` | 10 | 日志、审计、脱敏、诊断包导出与诊断状态（崩溃 marker 本身在 `windows/main-window.ts`，`diagnostics:last-crash` 通道在 `ipc/`） | `logger.ts`、`audit.ts`、`redact.ts`、`sanitize.ts`、`export-payload.ts` |
| `protocol/` | 9 | `cyrene://` 受限协议、CSP、MIME、路径与 scheme 守卫、Live2D 路径 | `scheme.ts`、`handler.ts`、`csp.ts`、`path.ts`、`mime.ts` |
| `live2d/` | 3 | 模型清单、注册表、dev 字节供给门 | `manifest.ts`、`model-registry.ts`、`serve-gate.ts` |
| `config/` | 9 | 运行时环境与 harness、GPU 回退判定、后端模式、开发端口、受信 origin、调试开关 | `runtime-environment.ts`、`gpu-mode.ts`、`backend-mode.ts`、`dev-ports.ts` |
| `voice/` | 1 | 录音 / 实时 / 转写三类会话的 Main 侧编排与音频上行守卫 | `voice-handlers.ts` |
| `models/` | 1 | 模型服务 Profile 通道 | `model-handlers.ts` |
| `settings/` | 2 | 设置读取、校验与持久化 | `settings-service.ts`、`settings-handlers.ts` |
| `connection/` | 1 | 连接配置（endpoint 等） | `connection-config.ts` |
| `fixtures/` | 29 | 线协议夹具 `wire-v2/*.jsonl` + `.manifest.json`（契约门禁对拍用） | — |
| `permissions/` | 1 | **仅一个占位 `README.md`**。授权判定实际落在 `tools/`（`tool-policy.ts` / `grant-store.ts`） | — |

> doc 01 §5 的推荐目录与现状有差异，读该节时应知道：现状**没有** `renderer/features/`、`tests/e2e/`、Local Worker 模块；`main/permissions/` 是空壳。

### 2.2 Preload / Renderer / Shared

- **Preload（3 文件）**：`desktop-api.ts` 是唯一 API 面（按域分组的具名方法，`export type DesktopApi = typeof desktopApi`）；`index.ts` 用 `contextBridge` 装配；`window.d.ts` 只声明类型。每个 `on*` 返回精确移除自身的 disposer。
- **Renderer（209 文件，`.vue` 60）**：`src/` 200 + `public/` 8 + `index.html`。`src/` 下 `components/` 61（59 `.vue`）· `live2d/` 74（含内置 Cubism framework 子集）· `utils/` 23 · `stores/` 22（其中 18 个 `*.store.ts`）· `assets/` 5 · `layout/` 3 · `voice/` 3 · `attachments/` 2 · 根文件 6（`App.vue`、`bootstrap.ts`、`main.ts`、`env.d.ts`、`tokens.css`、`reduced-motion.css`）。
- **Renderer 域逻辑（`src/renderer/src/` 下的非 store 目录，2026-09-17 Prompt 4）**：`stores/*.store.ts` 只保留响应式状态、UI 命令与 IPC 编排；可独立测试的判据下沉到这些**零 Vue / 零 Pinia** 的模块：
  | 目录 | 文件 | 内容 |
  |---|---:|---|
  | `message/` | 6 | `index-store`（消息表：去重、二分有序插入、乐观 key 迁移）· `acceptance`（replay/REST/快照三条来源的归档准入）· `fencing`（传输世代签名、按代会话身份、请求 owner 台账）· `attribution`（生成事件归属与栅栏判定）· `domain`（角色身份元组、取消码）· `index`（barrel） |
  | `conversation/` | 3 | `protocol`（会话线解析、绑定快照冲突校验）· `backend-identity`（端点事实域身份与「换端点 → 清保留数据」判定）· `index` |
  | `voice/` | 3 | `session`（三套语音会话的模式迁移表、会话栅栏、背压窗口、TTS 流归属）· `voice-capture`（PCM 采集，既有）· `pcm-worklet.d.ts` |
  | `composer/` | 1 | `dictation-hold`（「按住说话」手势状态机：指针 / 键盘 / 失焦三条时间线） |
  | `character-editor/` | 2 | `draft-patch`（JSON Pointer / dot-path 写入与原型污染守卫）· `draft-templates`（空草稿骨架、详情→草稿映射、错误构造与冲突码判定） |

  `live2d/directive-rules.ts` 同属这一类（后端 Live2D 表现指令的白名单与夹取规则）。
  `stores/session.ts` 仍是**零依赖的会话身份单例**（`conversation.store` 唯一写入，message/settings/voice 读取），
  是切断 `conversation ↔ message` 环的机制，位置与语义未变。

  **Vue 集成面（非纯域，但同样受门禁约束）**：`composables/` 是"组件侧可复用的响应式单元"目录，
  按目录语义整目录分类为集成面，受 Rule 2（不得碰 main/preload/electron/特权 Node）与 Rule 4（不得反向依赖
  renderer bootstrap）约束，只不受"纯域不得依赖框架"那条约束。当前唯一成员
  `composables/live2d-state-source.ts`——**它原先在 `live2d/state-source.ts`**，与纯域判据同目录；
  2026-09-17 Prompt 5 的门禁按"运行时依赖 `watch`"把它判为集成面，于是**移动生产代码**而不是登记豁免。

  > **分层已由机械门禁保护**（不再是文档约定）：`architecture-renderer.spec.ts` 的 Rule 3 判定
  > "纯域面（`renderer/src/**` 去掉 stores / components / composables / bootstrap / `.vue` / vendored /
  > 一个已登记的 Vue 框架适配器）不得 import `pinia`（含类型边）、不得**运行时** import `vue`、
  > 不得 import `stores/**` / `components/**` / renderer bootstrap（**含类型边**——这三者是下游层，
  > 它们的类型是实现细节，引用它构成 compile-time 依赖倒置）"。
  > 纯域面按**路径 matcher 的补集**定义，新增 `renderer/src/<新目录>/` 自动被保护，不需要登记文件清单；
  > 详见 §5.2 与 §5.4。
  >
  > 纯域面之外的 Vue 依赖只有两类，都不豁免任何规则：
  > ① `composables/**`（目录语义即集成面，新增文件无需登记）；
  > ② `utils/document-visibility.ts`（唯一登记项：`ref` 把 `document.visibilityState` 变成响应式源，
  > 与领域目录同址是刻意的）。
  > 其余"运行时依赖 Vue 但不在集成目录里"的文件会被门禁追问：挪目录、去掉 Vue，或登记并写明理由。
- **Shared（33 文件）**：`contracts/` 19（跨进程契约类型）· `domain/` 7（纯领域逻辑）· `schemas/` 6（zod 运行时校验）· `errors/` 1。零 Electron / Vue / Node 依赖。

### 2.3 测试与脚本

- `tests/unit/` 291 文件（**286 spec** + `global-setup.ts` + `helpers/desktop-api.ts` + `helpers/architecture-imports.ts` + `setup/live2dcubismcore.ts`）。含判别力门禁类 spec：`ipc-surface-alignment`、`ipc-budget-declaration`、`window-presentation-guard`、`dependency-classification`、`main-dependency-graph`、`main-bootstrap-order`、`backend-capability-ports`、`store-graph`（store 间不得有环）、`architecture-root` / `architecture-renderer` / `architecture-transport`（依赖方向，见 §5.2）。
- `tests/unit/helpers/architecture-imports.ts`：三个 architecture spec 共用的**依赖扫描器**（收源码 / 解析 specifier / AST 抽边 / 图容器 / Tarjan）。它只服务测试、不含任何规则——规则与失败信息写在各自的 spec 里。全仓 dependency scanner 的清点见 §5.4。
- `tests/integration/` 52 文件（**45 spec** + `global-setup.ts` + `README.md` + `helpers/`）。真机 Electron + Playwright。
- `tests/helpers/temp-dirs.ts`：跨层共用的临时目录。
- `apps/desktop/scripts/` 14 个：`check-backend-contract.mjs`（跨仓契约）· `verify-sensitive.mjs` + `verify-sensitive-core.mjs`（敏感信息扫描）· `verify-artifact.cjs`（产物 + Fuses + 打包产物与 `out/` 字节一致）· `package-app.mjs` · `refresh-wire-manifests.mjs` · `live2d-install.mjs` · `check-node-version.mjs` · `gpu-fallback-forensics.sh`（Linux GPU 取证脚本）。
- 仓库根 `scripts/` 2 个：`docs-check.mjs`（文档门禁 + 三个索引生成）、`setup-windows.ps1`。

---

## 3. 启动与退出次序（as-built）

### 3.1 启动

装配顺序里有若干**顺序即正确性**的点，改动前请先读对应注释。2026-09-17（架构整改 Prompt 2）起，
`main()` 只编排阶段，每一步的实现落在 `src/main/bootstrap/` 的对应模块（括号内为落点）：

1. `normalizeHarnessForPackagedRun()`——必须最先，后续所有 harness 读取点都看归一化后的值（`bootstrap/pre-ready.ts`）。
2. **规范化之后**才建立对话框入口（`defaultDialogService()` 单例会解析 `runtimeEnvironment()`，见下）。
3. `rejectForbiddenDebugSwitches()`——固定 remote-debugging 端口等被安全策略拒绝（`bootstrap/pre-ready.ts`）。
4. `app.commandLine.appendSwitch('enable-precise-memory-info')`（同前）。
5. GPU 回退判定 `resolveGpuDecision()` → 必要时 `appendSwitch('disable-gpu')`（判定在 `config/gpu-mode.ts`，**必须 app ready 前生效**）。
6. 测试 appData 门 `applyTestAppDataOverride(mode)`——早于身份安装与任何 userData 落盘。
7. `setAppDataFlavor()` 与 `registerCyreneScheme()`（app ready 前）。
8. `installAppIdentity()` → `requestSingleInstanceLock()`：单实例锁派生自 userData 路径，故身份与风味必须先定；顺序颠倒会让 dev 与正式版互相顶掉。
9. `await app.whenReady()`（阶段模块在**同一函数内**跨越 ready 边界：只有持锁主实例才等到 ready）→ `setAppUserModelId` → userData 路径断言 → 生产菜单（`bootstrap/infrastructure.ts`）。
10. `ensureUserDataDirs()`（子目录守卫）→ `createDiagnostics()` + `audit` / `auditAsync`（同前）。
11. 崩溃与进程级兜底：`child-process-gone` → `handleChildProcessGone`（GPU 分支只留痕 `gpu:crash`，**不 reload**）；`setCrashSink`（Renderer 崩溃 → 审计 + crash marker + reload）；`installProcessErrorGuards`（未捕获异常/拒绝，fatal 前等审计落盘）。装配点在任何可能崩溃的构造之前（`bootstrap/runtime-guards.ts`）。
12. 启动门禁：dev 形态（`config.devToolsAllowed`，即未打包）的 `ELECTRON_RENDERER_URL` 必须指向受信地址且端口与本项目配置一致（`bootstrap/infrastructure.ts`）。
13. 后端适配器构造：打包恒 Real；未打包默认 Real，仅 `CYRENE_BACKEND=mock` 显式 Mock。mock 夹具 `CYRENE_MOCK_*` 的 env 桥全部在此解析（`bootstrap/transport.ts`）。
14. 业务服务构造：设置（eager load）→ 目录授权仓库 → 工具服务 → 文件引用表 → 会话存储（eager load）→ 角色草稿（eager load）→ chat → 上传/媒体 → Live2D 注册表 → 退出 flush requester（`bootstrap/services.ts`）。
15. 跨服务接线：后端回调 → chat / media / tool；窗口 `close` 上的退出 flush。**构造与接线分离**是 Prompt 2 的核心结构（`bootstrap/wire.ts`）。
16. 通道装配 `registerHandlers(...)`（`bootstrap/register-ipc.ts`）→ 退出编排 `app.on('before-quit', ...)`（`bootstrap/shutdown-sequence.ts`）。
17. 窗口创建：协议供给 `registerCyreneProtocolHandler` → 启动痕 → `markAppStarted()` → `ensureMainWindow(...)`（`bootstrap/start-application.ts`）。窗口呈现走 `window-presentation` 唯一入口。

> **对话框入口与环境解析的次序**（2026-09-17 修正）：`createDialogService()` 的默认参数会解析
> `runtimeEnvironment()` 的进程级单例。此前它在 `index.ts` 的**模块作用域**被调用，即打包态残留
> `CYRENE_TEST_HARNESS=1` 时，静默窗口模式会在归一化**之前**被记忆。现在统一在归一化之后经
> `defaultDialogService()` 建立（全仓仍只有一个实例）。

### 3.2 退出

真实退出路径上的事件次序（Electron 43.3.0 实测，注释在 `windows/main-window.ts:200-213`）：

```text
窗口 close →（挂在这里的 flush 钩子）→ destroy → closed（mainWindow 置 null）
  → window-all-closed（非 macOS 调 app.quit()）→ before-quit →（shutdown steps）→ 退出
```

- **退出前持久化 flush 挂在窗口 `close`**（`main-window.ts:214-228`），接线在组合根的 wire 阶段（`bootstrap/wire.ts`），不是只挂 `before-quit`：`window-all-closed` 时 `getMainWindow()` 已为 `null`，只挂 `before-quit` 的 flush 在生产路径上恒空转。
- flush 由 Main 发起：`before-quit` 发 `app:persist-flush-request` 下行请求，等 Renderer 经 `app:persist-flush-done` 回 ack；预算 700 ms（`persistence/persist-flush.ts:14`），无窗口 / 投递抛错 / 超时 / Renderer 失败一律**不阻断退出**（fail-open），超时留诊断。
- 退出步骤由 `shutdown.ts` 的 `createShutdownHandler` 有序 await，装配在 `bootstrap/shutdown-sequence.ts`：`renderer-persist` → `credentials` → `adapter` → `diagnostics`（顺序与失败/超时语义不受组合根整改影响）。
- 工具侧收口 `app.on('before-quit', () => tools.shutdown())` 与上面的有序 flush **同为 `before-quit` 监听**，注册顺序决定执行顺序（工具侧在前），故两者必须在同一处装配（`bootstrap/shutdown-sequence.ts`）。

---

## 4. 关键数据流

| 流 | 路径 | 要点 |
|---|---|---|
| **聊天生成** | `chat:send` → `chat/chat-service.ts` → `ChatServiceBackendPort`（连接 + 事件源 + 会话/消息三个端口视图）→ WS v2 帧 → `protocol-v2/frame-mapper.ts` → 域事件 → `chat:event` 推送 → `stores/message.store.ts` → 组件 | 一次 generation = 一条 assistant 消息 + 有序 segments；`generation.completed` 是父终止事件，分段完成只结束该段；`assistantSegments` 是可见内容唯一真源；token/model/心情保留后端语义与来源标签，**不按字符估算** |
| **附件** | 拖入/选择/粘贴 → Renderer 只持有 `File` → preload `toIpcDescriptor` 换 `fileRef` → Main `resolveFileRef` → realpath / 黑名单 / 大小 / 魔数逐条复核 → 上传 | `fileRef` 为 32 字节 CSPRNG，TTL 10 min、容量 256（`attachments/file-ref.ts:35,37`）；拖入只产生待发送附件，**不自动发送**；`bytes` 分支走 IPC（受 4 MiB 全局不变量约束），`fileRef` 分支载荷为空、由 Main 自己读盘并按 kind 复核真实字节数 |
| **媒体字节与签名 URL** | 页面请求 `cyrene://renderer/__cyrene-media/{type}/{id}` → `attachments/media-service.ts` → 解析签名 URL → Main 取回正文（体积截断）→ 作为同源资源返回 | 目标地址策略在 `media-service.ts:69-86`：与后端**同源**放行；否则主机名必须是**公网字面 IP**；公网域名与回环/私网/链路本地/组播一律拒绝。同源资源意味着「Main 取什么，页面就能读什么」，所以这条策略是安全边界而非优化 |
| **工具与权限** | 后端 `tool.request` → Main 风险重算 `tools/tool-policy.ts` → 授权窗（Renderer 展示目标与数据范围）→ `tool:decide` → `tools/tool-service.ts` 执行 → 审计 + 公开事件 | 风险取「本地基线 ∨ 后端上报」的较大者，黑名单恒 high；按 `callId` 幂等、终止态不重入；**唯一执行点**在 `tools/tool-service.ts:515`（测试经 `deps.executorOverride` 注入，不另开生产路径）；撤销授权写盘失败 fail-closed（`grant-store.ts` 抛 `GRANT_REVOKE_NOT_PERSISTED`） |
| **语音** | ① 普通录音 ② 实时语音会话 ③ 输入法转写，三条独立链路 | 只有**转写 final 文本**进草稿；实时字幕不进草稿。转写终态须属于**当前打开的**转写会话（`clientRequestId` 相符，判据在 `voice/session.ts`），故已取消/已放弃会话的迟到终态不会经 `CyChatInput` 的 watch 插进当前会话草稿。音频上行是唯一的单向 IPC（`voice:audio-chunk`，1 MiB/块，`voice/voice-handlers.ts:22`）；敏感转写内容不进日志与诊断包 |
| **Live2D** | `live2d:list-models` 清单 → Renderer 加载 → 渲染环（rAF；窗口隐藏时 `beginFrameSubscription`） | dev 形态经 `live2d:read-model-file` 供字节（`corsEnabled:false` 下 `cyrene://` 跨源 `fetch` 会被拒），打包形态走 `cyrene://`（`protocol/live2d-path.ts`）；任何失败进可诊断失败态，不阻塞聊天 |
| **持久化** | Renderer 防抖 → `chat:persist-session` → Main 原子写 userData 子目录；启动 `chat:hydrate-persistence` 一次性水合 | 守卫在 `persistence/user-data-dirs.ts`：POSIX 用 `O_NOFOLLOW\|O_DIRECTORY` + fd 锚点，Windows 用 `lstat` + `realpath`；写失败语义 `write-failure.ts`，损坏隔离 `corrupt-isolation.ts`；退出 flush 见 §3.2 |
| **连接与断线** | `transport/real-backend.ts` + `transport/connection-liveness.ts` | 后端能力面按领域端口划分（`transport/backend-ports.ts`：连接 / 事件源 / 会话消息 / 附件媒体 / 模型服务 / 语音 / 桌面工具），每个 Main 服务只被注入自己声明的那几个视图；real / mock 是**同一个实例**的两套实现，连接状态、鉴权、重连与存活检测都只有传输层一份。断线时 Renderer 保留已显示内容与草稿 |

### 4.1 Renderer 的 Store 模式与身份栅栏（as-built）

**Store = Renderer facade。** 每个 Pinia store 持有响应式状态、对组件暴露的稳定命令、以及自己那几步 IPC 编排；
判据（状态机、栅栏、分页算法、纯转换）落在 `src/renderer/src/{message,conversation,voice,composer,character-editor}/**`
与 `live2d/directive-rules.ts` 这些**不 import `vue` / `pinia` / 任何 `stores/*`** 的模块里（§2.2 表）。
依赖方向单向：`组件 → store（facade）→ 域逻辑模块 → preload `window.cyrene``。域模块不得反向 import store，
故它们可以在 node 环境下直接单测，不需要 Pinia 实例、mock api 或假定时器。

**会话身份与栅栏（三条彼此的权威来源互不复制）：**

| 身份 | owner / 栅栏读取方 |
|---|---|
| 当前会话 id | **owner = `conversation.store` 的 `currentId`**：全部 8 处写入都在该文件内（activate 成功后提交、create、删除当前会话、`clearBackendData`、`removeCreatedConversation`、`activateLocal`）。它经**单向** `watch(currentId, …, { flush: 'sync', immediate: true })` 镜像到 `stores/session.ts`，**session 侧没有任何回写路径**（`setCurrentConversationId` 全仓唯一调用点就是那个 watch）。**栅栏读取方 = `session.ts`**：它是中性身份镜像与读取点，不是第二 owner；`message.store` 取 `currentConversationIdRef()` 的 ref 本体，`settings.store` / `voice.store` / `attachment.store` 取取值函数，都只读且都**不 import `conversation.store`**——这正是环被切断的原因 |
| 传输世代 | `message/fencing.ts` 的 `connectionSignatureFor(state)` + `stores/message.store.ts` 的 `connectionEpoch`。签名由 status / endpoint / connectionId / 协议版本 / 能力集合构成；**`activeConversationId` 有意不参与**（它是聊天选中项，不是传输转世）。`connected(A) → connected(B)` 因此也会被判定为换世代（不必先观察到断线） |
| 一代生成 | `generationId` → `generationByConversation` / `generationSessionById` / `generationIdentityById` 三张表（`message.store`，唯一持有者）。中间事件（delta / segment.*）没有 `conversationId`，归属只能查表，查无即丢；`generation.started` 是唯一登记点。迟到终态另受「连接世代 + 会话 + 角色身份元组」三重校验 |
| 在途请求 | `message/fencing.ts` 的 `createRequestOwners()`（send / voice-commit / resend+regenerate 共用一个，分页与上下文窗口各一个）。latest-wins：新请求使旧 owner 立即失效；会话切换 / 换世代 / 快照载入 `revokeAll()`。旧请求的 `finally` 只释放「仍属于自己的那一个」 |
| 语音会话 | `voice/session.ts` 的 `acceptedSessionId`（后端 `voice_session.started` 带回的 id）+ store 的 `activeRecordingId` / `dictationClientRequestId`。录音字幕按 `recordingId`、转写终态（`final` / `cancelled` 共用一条）按 `clientRequestId`、实时会话事件按 `sessionId` 三条独立栅栏。后端**原样回显**前端上行的 `vs_<uuid>`（`real-backend.ts` 的 `voice_session.start` 与 `frame-mapper.ts` 都直接透传 `frame.sessionId`），故「后端确认的 id」与上行 id 同值；但栅栏的**活跃判据是会话已开始（控制帧被接受）而不是 `mode === 'realtime'`**——`mode` 要等 `capture.start()`（getUserMedia）之后才置位，而 `started` 紧随控制帧到达，以 mode 为判据会丢掉建立会话的那条事件本身 |
| 语音 start 序列 | `stores/voice.store.ts` 的 `sessionStartInFlight`（同刻只有一次 start）+ `sessionStartGeneration`（`reset()` 自增，使**跨越 reset 的在途 start 在每个 await 边界作废**）。两条门分工不同：前者挡「同一时刻的第二次进入」，后者挡「一次进入跨越了 reset」 |
| Live2D 模型 | `stores/live2d.store.ts` 的 `lifecycleGeneration` + controller 自身状态。`init` / `dispose` 各自自增世代，每个 `await` 之后自查；在途 `createModel` 不得装进已被丢弃的 controller |

**两侧 fence 都不读对方的权威状态**：`message.store` 不从 `conversation.store` 读 `currentId`（改读 `session.ts` 单例），
`conversation.store` 的端点事实域判定也只用自己的 `conversation/backend-identity.ts`——两者唯一的交汇是 `session.ts` 的镜像。

> **另一条同名但不同层的 `activeConversationId`**：`connectionStore.state.activeConversationId` 来自**后端** session 帧
> （`main/transport/frame-mapper.ts`，Main 侧透传），表示「后端当前激活的会话」。它只在
> `conversation.store.initializeConnected` 里被用来决定「首次/重连时该激活哪个会话」，是**激活候选的来源**，
> 不是 UI 选中项的 owner。两者名字相同、语义不同，不要互相替代。

---

## 5. 契约面与门禁

### 5.1 契约面

| 面 | 位置 | 门禁 |
|---|---|---|
| IPC 命令通道（89） | `shared/contracts/ipc.ts` 的 `IpcChannels` | `ipc-surface-alignment.spec.ts`：声明面 ⇔ Main 装配面 ⇔ preload 可达面**集合相等**，三张例外表必须为空 |
| IPC 推送通道（8） | 同文件 `PushChannels` | 同上：与命令面不相交、不得被注册成 handler |
| 单向通道（1） | `voice:audio-chunk`，经 `ipc/registry.ts:76-85` 的 `registerOneWayHandler`（`ipcMain.on`，无 invoke 语义） | 通道预算 + `voice-handlers` 运行期 1 MiB 上限 |
| 单通道载荷预算 | `ipc/channel-budgets.ts`（上界取全局不变量 `MAX_IPC_MESSAGE_BYTES` = 4 MiB，`shared/contracts/ipc.ts:128`） | `ipc-budget-declaration.spec.ts`：新通道必须申报预算 |
| 后端 WS v2 帧 | `transport/protocol-v2/raw-schemas.ts` + `frame-mapper.ts` | `pnpm -F @cyrene/desktop check:contract`（对真实后端） |
| 后端 REST | `protocol-v2/rest-schemas.ts` + `rest-mapper.ts`、`character-rest-*.ts` | 同上 |
| 前端域事件 | `shared/contracts/events.ts` + `shared/schemas/events.ts` | 单测 + 集成 |
| Main 后端能力端口（7 领域端口） | `transport/backend-ports.ts`（聚合面 `transport/backend-adapter.ts` = 端口交集 + 接线槽） | `backend-capability-ports.spec.ts`：端口清单与逐端口方法名**冻结表**、端口间不重叠/不互相 extends、无未登记端口（interface 与 type 别名两种形态）、除事件源外无单方法端口、消费方 → 端口与 Pick 视图逐字对账、聚合面（含 barrel/命名空间等绕法）只允许 `transport/**` 与 `bootstrap/**`、Real/Mock 对每个端口的编译期与源码级一致性 |
| 线协议夹具 | `main/fixtures/wire-v2/*.jsonl` + `.manifest.json` | `refresh-wire-manifests.mjs` 刷新，契约门禁对拍 |

**纪律：** 未知或畸形外部输入必须**显式失败**，不得用 `any`、宽松 schema 或静默丢字段掩盖漂移。新增 IPC 通道必须同时改三处（Main 注册 + preload 引用 + 预算表），否则门禁红。

### 5.2 本地门禁

| 命令 | 保证什么 | **不保证什么** |
|---|---|---|
| `pnpm typecheck` | 两套 tsconfig（node / web，后者 `vue-tsc`）类型通过 | 运行期行为 |
| `pnpm lint` | `eslint --max-warnings=0`，含 type-aware 规则 | 架构约束（那由判别力 spec 承担） |
| `pnpm test` | 单测 + 上述判别力 spec + **§5.4 的全部 architecture gate**；配置启用 `expect.requireAssertions` | 真机 Electron 行为；打包形态 |
| `pnpm test:integration` | 真机 Electron + Playwright（默认静默窗口）；默认 mock 装配，另有 `real-assembly.spec.ts` 以 `CYRENE_BACKEND=real` 启动并断言缺凭据时 **fail-closed** | **负载敏感**：整套绿不是稳定信号，判读按单文件；real 形态只覆盖「装配能起来 + fail-closed」这两件**免凭据**的事——带凭据的真实往返在 Linux CI 上本就 `skip`（`safeStorage` 不可用） |
| `pnpm -F @cyrene/desktop check:contract` | 对**真实后端**核对 WS / REST 契约 | 未挂载后端契约目录时 exit 2 = `NOT VERIFIED`——**这不是通过** |
| `pnpm -F @cyrene/desktop verify:sensitive` | 敏感信息 / 密钥形态扫描 | 语义级泄漏 |
| `pnpm docs:check` / `pnpm docs:index` | 核心文档元数据、编号连续性、生成索引一致、受检面链接、doc 16 行宽 | 非编号文档的元数据与行宽；`docs/review/**`、`docs/archive/**` 只做断链计数守护 |
| `pnpm build` / `pnpm package` / `pnpm verify:artifact` | 构建、`electron-builder --dir` 打包、产物静态校验（Fuses 读回、`dist` 与 `out` 字节一致、smoke） | 分发级验收（阶段 8 范围） |
| `pnpm verify` | 聚合 = `typecheck && lint && test && test:integration && build` | **不含** `docs:check`、`verify:sensitive`、`check:contract`、`verify:artifact` |
| `pnpm test:e2e` / `pnpm make` | 无——**故意非零退出的占位** | 两者都不得报告为通过或已实现 |

### 5.3 CI

`.github/workflows/ci.yml` 的 6 个作业（runner 已从托管迁到自建）：

| 作业 | Runner | 内容 |
|---|---|---|
| `check`（typecheck + lint） | `[self-hosted, Linux, X64, fe-light]` | typecheck、lint、docs:check、verify:sensitive、check:contract（CI 无后端仓库 ⇒ 常态 exit 2，降级为 warning 注解） |
| `unit tests` | `fe-light` | `pnpm test` |
| `integration (shard N)` | `fe-linux` | 非 live2d 集成套件，分片 |
| `integration (live2d …, self-hosted)` | `fe-linux` | live2d core / motion / settings 三文件 matrix |
| `packaged artifact smoke` | `fe-light` | 清 `out/` + `dist/` → package → `verify:artifact --smoke`（xvfb）+ SHA 证据上传 |
| `windows build-level` | `[self-hosted, Windows, X64]` | typecheck、lint、`pnpm test`、build、package、静态 `verify:artifact` + SHA 证据上传 |

另有 `linux-runtime.yml`、`windows-runtime.yml` 两个**观测**工作流（运行时取证，非必过门禁；`windows-runtime` 仅 `workflow_dispatch`）。

`ci.yml` 有 `concurrency`（同 ref 只留最新一次），因此**连推时中间提交不留完整 CI 记录**。

### 5.4 依赖方向门禁（architecture gates）

架构边界由三个 spec 机械保护，全部经 `pnpm test` 进入 CI（`unit tests` 与 `windows build-level` 两个作业都跑）。扫描器共用 `tests/unit/helpers/architecture-imports.ts`；判定口径统一为 **AST 抽边**（`import` / `export … from` / `import =` / 动态 `import()` / `ImportTypeNode` 全形态），并区分 **值边**（有运行时后果）与 **类型边**（编译期擦除）。

| spec | 保护的边界 | 主要规则 |
|---|---|---|
| `architecture-root.spec.ts` | `src/shared` 的跨进程中性；`src/preload` 的窄桥地位 | shared ✕ main/preload/renderer（**含类型边**）、✕ electron/vue/pinia、✕ 特权 Node 内建；shared 内部无**值**导入环；preload ✕ main/renderer、外部依赖只允许 electron + zod + `@shared/**` |
| `architecture-renderer.spec.ts` | Renderer 不可信进程；Renderer 纯域模块分层 | renderer ✕ main/preload 实现（含类型边）、✕ electron、✕ 特权 Node 内建；纯域面 ✕ pinia、✕ vue（**仅值边**）、✕ stores/components/renderer bootstrap（**含类型边**）；只有 `main.ts`/`App.vue` 可 import renderer bootstrap |
| `architecture-transport.spec.ts` | Main 的分层方向 | transport ✕ 有状态服务实现（工厂 / 有状态类 / 整模块导入）；只有 `main/index.ts` 可 import `main/bootstrap/**`；bootstrap ✕ `main/index.ts` |

**依赖方向矩阵（as-built）**：`YES` 允许，`NO` 门禁判红（**类型边与值边一并禁止**，除非该格另行注明），`TYPE-ONLY` 仅 `import type` 形态允许，`COND` 条件允许（括号内为条件）。

> **类型边口径（每一格各自成立，不存在全局豁免）**：`import type` 编译期擦除、**不构成 runtime edge**——这是事实。
> 但"因此它对任何层都合法"是推论，**不成立**：层规则可以明确禁止 type-only 依赖（目标是**下游层的实现类型**时）。
> 本矩阵据此分两类，读者不必猜：
> - **目标是框架机制**（`vue` / `pinia`）：类型面不引入框架语义 ⇒ **只禁值边**（`renderer 纯域 → vue` 为 TYPE-ONLY）；
> - **目标是下游层**（`stores/**` / `components/**` / renderer bootstrap）：其类型是**实现细节的所有权**，
>   引用它形成 compile-time 依赖倒置 ⇒ **类型边一并禁止**。
> 另：`shared ✕ main/preload/renderer` 与 `renderer ✕ main/preload` 同样**含类型边**——契约层/不可信层引用实现层，
> 方向本身就是错的（这几格的当前实测违规数为 **0**，故不需要任何 exception）。

| From → To | shared | preload | main/bootstrap | main 其余层 | renderer bootstrap | renderer stores | renderer composables | renderer 纯域 | renderer 组件 |
|---|---|---|---|---|---|---|---|---|---|
| **shared** | YES | NO | NO | NO | NO | NO | NO | NO | NO |
| **preload** | YES | YES | NO | NO | NO | NO | NO | NO | NO |
| **main/bootstrap** | YES | NO | YES | YES | NO | NO | NO | NO | NO |
| **main/index.ts** | YES | NO | YES | YES | NO | NO | NO | NO | NO |
| **main/transport** | YES | NO | NO | COND（仅纯常量 / 纯函数 / 类型；工厂与有状态类判红） | NO | NO | NO | NO | NO |
| **main 其余层** | YES | NO | NO | YES | NO | NO | NO | NO | NO |
| **renderer bootstrap** | YES | NO | NO | NO | YES | YES | YES | YES | YES |
| **renderer stores** | YES | NO | NO | NO | NO | YES | YES | YES | NO |
| **renderer composables** | YES | NO | NO | NO | NO | YES | YES | YES | YES |
| **renderer 纯域** | YES | NO | NO | NO | **NO**（含类型边） | **NO**（含类型边） | YES | YES | **NO**（含类型边） |
| **renderer 组件** | YES | NO | NO | NO | NO | YES | YES | YES | YES |
| **renderer/utils（通用）** | YES | NO | NO | NO | NO | **NO**（含类型边） | YES | YES | NO |

`renderer 纯域` 行的高亮说明（提交前边界一致性复核的结论，实测基线）：
纯域面的类型边只落在 **`shared/**`（23 条）· 同域纯模块（5 条）· 通用 utils · vendored Cubism 类型面（9 条）**，
指向 `stores` / `components` / bootstrap 的类型边为 **0 条** ⇒ 收紧为 `NO` 不需要迁移任何类型、也不需要 exception。

矩阵未列出的组合（如 main 服务 → main/transport）均为 `YES`：Main 内部的分层由 `main-dependency-graph.spec.ts` 的**值导入环 = 0** 与组合根方向规则共同约束，`transport → 具体服务` 是其中被单独钉住的错误方向。

| 项目 | 事实 |
|---|---|
| **机械强制** | 上表全部 `NO` / `TYPE-ONLY` / `COND` 格子；Main 值导入环 = 0（`main-dependency-graph`）；Store 值导入环 = 0（`store-graph`）；后端能力端口消费面（`backend-capability-ports`）；启动/退出次序（`main-bootstrap-order`）；窗口与对话框唯一入口（`window-presentation-guard`）；IPC 三面对齐与通道预算（`ipc-surface-alignment`、`ipc-budget-declaration`） |
| **仍只是约定（无门禁）** | ① "Renderer 只能经 `window.cyrene` 取能力"的**正向**要求（门禁只禁 electron/Node，不强制经 preload 面）；② "通用 utils 不反向依赖领域语义"（`utils/**` 只被规则 1 覆盖，没有"utils 不得 import 领域模块"的规则）；③ Application Service 与 Electron UI primitive 的距离（`native-ui/dialog-service.ts` 本身就是基础设施适配器，剩余调用点尚未收敛，见 §7.1 指向的 doc 16 §5）；④ 领域模块之间的语义边界（如 message 域不得直接读 conversation 域状态）——由 review 与单测覆盖，无静态规则 |
| **vendored 精确排除** | 只有 `src/renderer/src/live2d/framework/**`（Cubism SDK 第三方源码，59 个 ts）退出依赖方向规则；Cyrene 自己的 `live2d/directive-rules.ts`、`state-machine.ts`、`gl/**` 仍在受保护面内（有专门用例与 mutation 钉住） |
| **exception / allowlist** | **0 条豁免**。唯一的两个"清单"都不是豁免而是**分类**：`architecture-renderer.spec.ts` 的 `VUE_FRAMEWORK_ADAPTERS`（**1 项**：`utils/document-visibility.ts`，把浏览器可见性接成响应式源的通用适配器；`composables/**` 按目录整类分类、无需登记）；`architecture-transport.spec.ts` 的跨层纯叶子依赖。两处新增都会被专门的用例追问，且**纯域内的 store 命名规则、类型边、`.js` 出后缀、别名写法全部按行为判定，不依赖任何清单** |
| **判别力证据** | 每条规则都有 mutation 记录（注入违规 → 红 → 逐字节恢复 → 绿）；解析器另有 AST 形态判别力自证（`require` 三种引号 / 命名空间 / 转出口 / `import =` / 动态 `import()` / `ImportTypeNode` / 注释里的 import / `.js` 出后缀 / 别名归一 / `.vue` 的 `<script src>` / `.d.ts` 边 等 25 条形态）。纯域类型边政策的判别力另由 5 条 mutation 钉住（M16/M16b → stores 类型边红、M17 → components 类型边红、M17c → bootstrap 类型边红、P1–P3 → shared / 同域 / utils 类型边绿） |

---

## 6. 变更影响地图

| 我要改… | 必须同时改 | 会红的门 |
|---|---|---|
| 新增 / 删除 IPC 通道 | `shared/contracts/ipc.ts`、Main 注册（`ipc/handlers.ts` 或各域 handler）、`preload/desktop-api.ts`、`ipc/channel-budgets.ts` 预算 | `ipc-surface-alignment`、`ipc-budget-declaration` |
| 新增窗口 / 对话框 / 通知 / `openDevTools` 调用 | 必须走 `windows/window-presentation.ts`、`native-ui/dialog-service.ts` | `window-presentation-guard` |
| 改后端 wire 字段或新增帧 | `protocol-v2/raw-schemas.ts` + `frame-mapper.ts`（REST 同理），并刷新 `main/fixtures/wire-v2/` 与其 manifest | `check:contract`、契约相关单测 |
| 改 renderer 对后端字段的消费方式 | 先看是否该落在**域事件**（`shared/contracts/events.ts`）而不是组件；需要新的后端能力时先改 `transport/backend-ports.ts` 的领域端口 | 类型检查 + 契约测试；越层会被 review 打回 |
| 改 Renderer 的聊天/会话/语音判据（栅栏、分页、状态机、准入） | 先找 `src/renderer/src/{message,conversation,voice,composer}/**` 里对应的纯模块，在那里改并补该模块的边界用例；**不要**把判据搬回 store | 对应模块的判别力 spec（这些模块不依赖 Vue/Pinia，用例直接构造边界） |
| 在 store 里加跨模块协调 | 优先走 `stores/session.ts` 的单例镜像或域模块的纯判据，**不得**让两个 store 互相 import（会成环） | `store-graph.spec.ts`（Tarjan SCC，环即红）、`store-graph` 对 `session.ts` 零依赖的断言 |
| 往 `src/renderer/src/stores/` 加非 store 文件 | 新的 Pinia store 必须叫 `<name>.store.ts`；辅助模块应放到 `stores/` 之外，或在 `architecture-renderer.spec.ts` 的 `NON_FACADE` 里写明理由 | `architecture-renderer`（store 命名面用例） |
| 改某个 Main 服务能用哪些后端能力 | 先在 `transport/backend-ports.ts` 找到/新增领域端口（**不得**再把聚合面注入服务），再改 `backend-capability-ports.spec.ts` 的消费方 → 端口冻结表 | `backend-capability-ports`、`main-dependency-graph` |
| 在 `src/shared/**` 里新增契约 | 只能引 shared 自己的模块 + 跨运行时内建；需要 main 的逻辑时把**纯类型/纯函数下沉**到 shared | `architecture-root`（shared 隔离 / 无值环） |
| 在 `src/renderer/src/` 下新增纯域模块 | 放进 `renderer/src/<域>/`（**不要**放 `utils/**`，那是通用工具）；不得 import vue（运行时）/ pinia / stores / components / bootstrap——**取类型也不行**（下游层的类型是实现细节，需要中性契约就放 shared 或该域自己的纯模块） | `architecture-renderer` Rule 3（新增目录自动纳入保护；类型边同样判红） |
| 在纯域模块里需要响应式 | 把编排留在 store / 组件里（store 侧 watch 后回调传入）；确有"框架适配器"性质的模块需把该文件登记进 `VUE_FRAMEWORK_ADAPTERS` 并写明理由；组件侧可复用的响应式单元放 `composables/**`（整目录免登记） | `architecture-renderer`（"未登记的 Vue 运行时依赖"用例会追问） |
| 让 `main/transport/**` 依赖另一层的逻辑 | 只允许**纯常量 / 纯函数**（且目标模块不含工厂与有状态类），并在 `architecture-transport.spec.ts` 的值导入目标清单里登记 | `architecture-transport` Rule 5 + 清单对账 |
| 在 renderer 里取 Main 能力 | 走 `window.cyrene`（新增能力需三处同改：Main 注册 + `shared/contracts/ipc.ts` + `preload/desktop-api.ts`） | `architecture-renderer` Rule 2、`ipc-surface-alignment` |
| 新增持久化文件 / 目录 | `persistence/user-data-dirs.ts` 的子目录清单 + 原子写与写失败语义 | 相关单测 + 集成 |
| 新增 Renderer 侧订阅 / rAF / 定时器 / AudioContext | 对应卸载点（`onBeforeUnmount` / `unmounted` 标志） | 集成用例与 review |
| 改凭据或密钥处理 | `credentials/` + `diagnostics/redact.ts` 形态规则 | `verify:sensitive`（注意 `SELF_EXCLUDED_FILES`） |
| 新增敏感字符串到测试文件 | `scripts/verify-sensitive-core.mjs` 的 `SELF_EXCLUDED_FILES`（并有 spec 钉住条目数） | `verify:sensitive` |
| 改文档 | `pnpm docs:index` → `pnpm docs:check`；新增编号文档还要改 `scripts/docs-check.mjs` 的核心文档数 | `docs:check` |
| 改打包 / 构建产物 | `scripts/verify-artifact.cjs` 的读回与一致性检查、`.github/workflows/ci.yml` 的对应作业 | `verify:artifact`、CI |
| 改数据库 / 后端契约行为 | 不在本仓库改：走 [doc 02](02-Cyrene-前后端通信协议与前端数据结构-v0.2.md) 记录映射，并跑 `check:contract` | `check:contract` |

---

## 7. 本文的边界与口径

### 7.1 本文不覆盖

- **阶段进度、阻塞项、最近验证读数**：读 [doc 16](16-Cyrene-前端实施任务清单与进度跟踪.md)（唯一状态源）。
- **设计意图与取舍**：[doc 01](01-Cyrene-Electron-前端总体架构设计-v0.2.md) 与各分册（02～09、11）。
- **后端内部架构**：后端在自己的仓库，本仓只有适配层。
- **单条缺陷、已知缺口、未取证项**：doc 16 §5 与 `docs/review/` 的最新审计/裁决记录。
- **未实现能力**：Local Worker、任务中心（暂缓/排除）、`pnpm make` 与 `pnpm test:e2e`（故意非零占位）。

### 7.2 计数口径与复核命令

- 「文件数」= 该目录下**全部文件**（含非 `.ts` 资产与 `.md`）；「spec 数」= `*.spec.ts`。
- 数字随开发漂移，本文**只在结构性变化时**更新（新增/删除模块、通道面、数据流、门禁）；不逐次追平文件计数。需要当前精确值时跑下面的命令（PowerShell，仓库根）：

```powershell
# 各层文件数
foreach ($p in 'src/main','src/preload','src/renderer','src/shared','tests/unit','tests/integration') {
  "{0,-18} {1}" -f $p, (Get-ChildItem "apps/desktop/$p" -Recurse -File).Count
}
# IPC 命令通道数（只数 IpcChannels 块）
$t = Get-Content apps/desktop/src/shared/contracts/ipc.ts -Raw
$b = [regex]::Match($t, '(?s)export const IpcChannels = \{(.*?)\} as const').Groups[1].Value
([regex]::Matches($b, '(?m)^\s{2}[A-Za-z0-9_]+:')).Count
```

> 命令通道数**不被门禁钉住**：`ipc-surface-alignment.spec.ts` 保证的是「三面集合相等、例外表为空」，不是字面上的 89。加通道后该 spec 仍会绿，本文的数字需要人工同步。

### 7.3 复核纪律

本文每条结论都给了落点文件。**引用本文做设计或审计时，先打开落点文件确认**——本仓历史上有过「文档声称某行为存在、代码里其实是死代码」的事故（如 `fileRef` 的「重连即清空」），这也是本文坚持给出落点而不是只给结论的原因。

---

## 8. 维护规则

**必须更新本文**（结构性变化）：

- 进程边界、信任边界或不变式的落点发生变化；
- 新增/删除 Main 模块、Renderer 顶层目录、Shared 子目录；
- 通道面（命令/推送/单向）、后端适配面、域事件面的结构变化；
- 启动/退出次序、持久化路径、CI 作业集合变化；
- **§5.4 的依赖方向矩阵或 architecture gate 集合变化**（新增/删除规则、新增 exception、vendored 排除范围变化、某条规则从"机械强制"退回"约定"）。

**不要写进本文**：

- 测试计数与门禁读数（属 doc 16）；
- 阶段状态、阻塞项、下一步（属 doc 16）；
- 单条修复的来龙去脉（属 `docs/review/` 的决策记录）；
- 设计意图与未采纳方案（属 doc 01 与各分册）。
