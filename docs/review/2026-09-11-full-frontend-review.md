# Frontend Architecture & Code Review

**项目：** Cyrene — Electron 桌面 AI 助手客户端（`apps/desktop/`）
**基线：** `d71f37d`（main，工作区干净）
**范围：** `apps/desktop/src/{main,preload,renderer,shared}`（约 49.6k 行，其中 renderer 约 15k 行为 vendored Live2D Cubism framework，不计入评审）、`tests/`、`scripts/`、构建与 CI 配置、`docs/`
**方法：** 7 个领域 Subagent 并行审查 + 主 Agent 对全部 Critical/High 逐条二次验证（读完整调用链、实测、反证）
**本轮不修改任何业务代码。** 唯一的文件写入是本文档。

> **⚠️ 历史快照（基线 `d71f37d`，2026-09-11，未随代码更新）：** 本文正文（含 Executive Summary、`Architecture` 各节与全部 H/M/L 条目）按**当时**代码写下，**不得当作现状读**；其中所有行号与体量读数（如 `main/index.ts` 503 行组装根、`RealBackend` 1859 行、`message.store` 1120 行、组合根自引用与晚绑定）**均已漂移**。2026-09-16/17 的架构整改 Prompt 1～5（`203b4e3`／`10d5e9d`／`883e210`／`70528bd`）处置了其中的组合根与桥容器问题。架构现状读 [doc 20](../20-Cyrene-前端架构现状总览.md)，批次状态读 [doc 16](../16-Cyrene-前端实施任务清单与进度跟踪.md) §3.5。**正文一字未改**（历史主张按仓纪律保留；条目的当代状态见 doc 16 的 `S5-*` 台账）。

> **文件名说明：** 任务书指定 `docs/review/full-frontend-review.md`，但本仓库 `docs/review/` 的历史记录一律采用 `YYYY-MM-DD-<标题>.md` 约定，且 `scripts/docs-check.mjs` 的索引生成器依赖该日期前缀（`dateFromName()` 正则 `^\d{4}-\d{2}-\d{2}`）。为不破坏索引与既有链接检查，本文档落为 `docs/review/2026-09-11-full-frontend-review.md`。若要严格使用任务书原路径，改回即可，但需同步 `pnpm docs:index`。

---

## 0. 验证基线（本轮实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | **PASS**（exit 0） |
| Lint | `pnpm lint`（`--max-warnings=0`） | **PASS**（exit 0） |
| 单元测试 | `pnpm test` | **PASS**：214 文件 / 2682 passed + 6 expected-fail + 21 skipped |
| 集成测试 | `pnpm test:integration` | **FAIL（本机）**：22 文件全红、81 failed / 12 passed / 47 skipped。根因已定位为 **本机 Playwright ↔ Electron 43 握手失败**，非产品缺陷 — 见 §11 R-09 的实测反证 |
| 打包 | `electron-builder --dir` | **PASS**，产物 `dist/win-unpacked/`（已清理） |
| 打包安全性假设 | 「`files:` 只含 `out/**` 导致 externalized 依赖不进包」 | **证伪** — electron-builder 自动复制生产依赖闭包，`resources/app/node_modules` 存在且 `zod`/`ws`/`diff` 均可 resolve |
| 工作区完整性 | `git status --short` / `git ls-files --others --exclude-standard` | 均为空 — **无任何受版本控制的文件被修改** |

---

## 1. Executive Summary

### 1.1 当前整体工程质量

这是一个**工程纪律明显高于平均水平**的 Electron 项目，而且它的高纪律是"可验证的"而不是"自称的"：

- 静态门禁真实有效：`typecheck` / `lint` / 214 个单测文件 / CI 5 个 job 全绿。
- 安全基线是**结构性**的而非注释性的：`contextIsolation + sandbox + nodeIntegration:false`、preload 只暴露具名窄接口（93 个方法，集成测试用**硬编码白名单**钉死，刻意不从 `IpcChannels` 派生以免断言恒真）、每个 IPC handler 都过 `isTrustedSenderFor` 的**五条件**校验（含 `senderFrame === mainContents.mainFrame`，使子框架即使同源也拿不到桥）、协议路径经 `resolveRendererPath` + `realpath` 双重包含性检查、Live2D 的两条供给通道**共用同一个 `gateLive2dFile`**（`serve-gate.ts` 的头注释明确写了"分叉的那一侧就是绕过入口"）。
- 首方代码**零 `any`、零 `@ts-ignore`、零 `eslint-disable`、零 TODO/FIXME**（6 处标记全在 vendored 目录内）。
- 核心业务域（工具权限、消息流、多角色）的测试是**行为断言**而非形状断言，且做过红绿变异验证。

同时，本轮发现了**一批通过全部静态门禁、却直接影响用户体验或数据安全的问题**。它们的共同特征是：**门禁测的是"形状"和"来源"，而不是"权威"和"行为"**。

### 1.2 最大的 5 个问题

| # | 问题 | 级别 | 一句话 |
|---|---|---|---|
| 1 | **`attachments:upload` 可被 Renderer 用来读取任意本地文件并外传** | **High（现实可利用）** | `path` 是 Renderer 可传的裸字符串，Main 只排除 userData 一个目录；工具域已有的 `PATH_BLACKLIST_DEFAULTS`（`~/.ssh`/`~/.aws`/`.env`/`C:\Windows`…）在这条链上**完全没被调用**。违反 `CLAUDE.md` 明文的进程边界不变量。 |
| 2 | **助手回复既不自动跟随底部，也无法被复制** | **High** | `atBottom` 在内容增长时从不重算、也没有任何 follow-bottom 逻辑（spec 明文要求），长会话里按 Enter "像没反应"；同时 `body { user-select: none }` + 无复制控件 + 无右键菜单，使"复制回答"这一最高频操作**三条路全断**。 |
| 3 | **所谓"80ms 流式节流"实为尾沿防抖，token 速率一高就完全不渲染中间态** | **High** | `createTrailingDebounce` 每次调用都 `clearTimeout` 重排；delta 间隔 < 80ms（>12.5 tok/s，即常态）时回调**永不触发**，回复整段一次性出现。"流式"这一核心卖点实际不成立。 |
| 4 | **退出时 Renderer 侧防抖持久化从不 flush** | **High** | 草稿 800ms / 设置 500ms / 布局 200ms 防抖，`flush()` 只有两个调用点（切会话、断线）；主进程 `before-quit` 只 flush credentials/adapter/diagnostics。关窗前 ≤800ms 内敲的字**静默消失**。 |
| 5 | **契约镜像大面积失守，唯一跨仓门禁不在 CI** | **High** | `z.ZodType<T>` 编译期锚点只覆盖 82/199（事件 schema **0/36**、REST wire **1/25**）；`check:contract` 不在 CI（本机实测 exit 2 = NOT VERIFIED）。契约漂移是默认状态而非例外。 |

### 1.3 最大的架构风险

**"单点"是路由点，不是策略点。** `registerHandler` 被文档描述为 IPC 的单一收口，但它只校验**来源**和**参数个数**；`createIpcHandler` 只校验**形状**。于是所有"本应全局成立"的不变量 —— 消息大小上限（`MAX_IPC_MESSAGE_BYTES` 只有 `chat:cache-messages` 一条通道真的执行）、文件路径围栏、能力适当性 —— 都必须**逐通道重新实现一遍**，遗漏就是永久缺口。S-01（文件读取）和 S-03（大小上限）是同一个根因的两个实例，而不是两个独立 bug。

第二风险是**"知识只存在于注释里"**。多处关键不变量以注释形式声明为事实，却无任何机制执行：`path?: string // 仅 Preload 注入；Renderer 永不构造`（S-01 的成因）、`atomic-write.ts:23` 的"单实例无并发写者"（R-02 的成因）、`LIVE2D_PATH_PREFIX` 的"单一事实来源"（仍有一处硬编码副本 T-13）、`repo 已四次手写复制的安全校验器`（A-03）。注释描述**意图**，代码执行**现实**；两者之间的空隙每次都由真机事故来填。

### 1.4 是否存在发布阻塞问题

**当前状态下不建议对外分发**，但阻塞原因**不是**本轮新发现的问题，而是仓库已登记的既有阻塞项：

1. **`EXT-01`（第三方资产授权）** — Live2D Cubism SDK 与模型来源/授权未落地，`docs/16` §4.1 已立为对外分发阻塞项。
2. **`asar: false` + 两个 asar 完整性 fuse 为 DISABLE + 无签名** — 特权 Main 包是磁盘上可直接改写的明文文件，`verify:artifact` 也不校验 `resources/app/**`。阶段 8 暂缓决策已覆盖，但它是**真实的完整性缺口**而非仅"未优化"。
3. **Windows 打包路径从未在 CI 验证** — CI 只在 Linux 打包；`pnpm package` 在本机 `@electron/fuses` 步骤 ENOENT 失败过一次（重跑即过），而主目标平台恰恰是 Windows。

**对内继续开发新功能没有阻塞**（见 §15 结论）。

---

## 2. Project Architecture

### 2.1 进程与模块划分

```
┌─ main/ (97 文件 / 13.9k 行) ────────────────────────────────────────┐
│ index.ts            组装根（503 行，15 字段 deps 单字面量）          │
│ config/             env / backend-mode / debug-switches / dev-csp   │
│                     / trusted-renderer-origin（纯 Node，三处共用）   │
│ windows/            main-window / navigation / mic-permission       │
│ ipc/                channels(schema) / registry(sender+arity)       │
│                     / executor(schema+错误脱敏) / *-handlers        │
│ protocol/           cyrene:// scheme / handler / path / mime / csp  │
│ transport/          backend-adapter(端口) / real-backend(1859)      │
│                     / mock-backend(1214) / protocol-v2/(raw+rest)   │
│ chat/ attachments/ voice/ models/ characters/ live2d/ tools/        │
│ credentials/ persistence/ settings/ diagnostics/                    │
└─────────────────────────────────────────────────────────────────────┘
                    ▲ contextBridge（93 个具名方法，无 ipcRenderer）
┌─ preload/ (3 文件 / 784 行) ───────────────────────────────────────┐
│ desktop-api.ts     逐方法 invoke + 响应 zod 校验 + 订阅退订闭包      │
└─────────────────────────────────────────────────────────────────────┘
                    ▲ window.desktopApi
┌─ renderer/ (179 文件 / 41.7k 行，含 15k vendored) ─────────────────┐
│ main.ts            createApp + 全局错误兜底 + bootstrap.register()  │
│ bootstrap.ts       订阅编排 + epoch/世代栅栏 + 水合                 │
│ stores/ (24)       Pinia setup store；desktop-api.ts 为注入点       │
│ components/ (60)   Cy* 纯展示组件                                   │
│ live2d/            adapter/controller/state-machine/perf + framework│
└─────────────────────────────────────────────────────────────────────┘
┌─ shared/ (32 文件 / 3.2k 行) ──────────────────────────────────────┐
│ contracts/ 纯类型  schemas/ zod 镜像  domain/ 纯函数  errors/       │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流（主链路）

**出站（用户发消息）**
`CyChatInput.vue` → `draft.store`（内存 + 800ms 防抖）→ `message.store.send()`（乐观消息 + 稳定 `clientRequestId`）→ `stores/desktop-api.ts` 的 `api` 注入点 → preload `ipcRenderer.invoke` → `registry` 五条件 sender 校验 → `executor` 请求/响应双向 zod → `chat-handlers` → `chat-service` → `real-backend` WS/REST。

**入站（流式回复）**
后端 WS 帧 → `real-backend` 原始帧解析 → `protocol-v2/frame-mapper` 映射为领域事件 → `chat-service.send()` → `webContents.send(chat:event)` → preload `parseBackendEvent` 再校验 → `bootstrap.ts` 回调（按 `event` 判别键旁路到 live2d / tool / character，其余落 `message.applyEvent`）→ `StreamAccumulator`（renderer 侧，`shared/domain/`）→ `byId[id].assistantSegments` 就地赋值 → `CyMessageList` 虚拟窗口 → `CyMessageBubble` → `CyMarkdown`。

**错误传播**
Main 抛出 → `executor` 归一为 `{ok:false,error}`（白名单字段 + sanitize + 截断 500 码点 + 拒绝 `backendDetails` 过桥）→ preload `unwrap()` → store `parsePublicError` → `utils/error-message.ts`（15 个组件消费）→ UI。

### 2.3 架构判断

**成立的部分（已逐一读码核实，非文件名推断）：**

- 分层方向**没有**被破坏：`main`/`preload` 不 import `renderer`，`renderer` 不 import `main`（Subagent 独立跑 Tarjan SCC：118 个 renderer 模块 **0 环**）。
- `shared/` 是**真正的契约层**（contracts / schemas / domain 三分），不是垃圾堆。
- `stores/desktop-api.ts` + `desktop-api.types.ts` 的 `StripOptional + Pick<Window['desktopApi']>` 编译期镜像，是本仓库最强的设计之一：preload 增删方法会在 renderer 侧编译报错。
- `protocol-v2/` 的 raw schema 层与领域层解耦干净，且有 `rawSchemasFingerprint()` + fixture manifest 哈希门禁。
- 组件层基本无领域逻辑（无 zod、无领域 schema；7 个组件直接调叶子 `api`，全部只读）。

**不成立/退化的部分 → 见 §7。**

---

## 3. Critical Issues

**无。** 本轮未发现满足 Critical 定义（安全/数据/crash/核心功能/发布 的立即阻断）的问题。

需要说明两点以免误读：

1. 本轮**没有**为了"显得严格"而下压级别，也**没有**把 High 抬成 Critical。S-01（任意文件读取）之所以是 High 而非 Critical，是因为它需要 Renderer 先被攻陷（XSS 类），而"Renderer 不可信"虽属设计前提，但**当前仓库没有已知可达的 XSS 入口**：DOMPurify 3.4.14 显式白名单（无 `target`、无事件属性、无 `style`）、代码块走插值不走 `v-html`、`markdown-xss.spec.ts` 在真实 Chromium 里跑。所以它是"**一条已经断掉但本不该存在的越权能力**"，而非"今天就能被打穿"。
2. 项目**已经存在**一个它自己登记的对外分发阻塞项 `EXT-01`（第三方资产授权）。它不在本轮"新发现问题"内，但它是真实的发布前置条件。

---

## 4. High Priority Issues

### H-01 `attachments:upload` 把 Renderer 提供的字符串变成任意本地文件读取，并上传出机 — 【已二次验证：真实】

- **Evidence**
  - `apps/desktop/src/main/ipc/channels.ts:91` — `path: z.string().max(1024).optional(),   // D7A-13：attachment 路径 1024 上界`
  - `apps/desktop/src/main/attachments/upload-service.ts:143` — 唯一的排除项：`if (isInside(this.userDataBase(), real)) throw new CyreneError(...)`
  - `apps/desktop/src/main/attachments/upload-service.ts:146,152-154` — `isFile()` 检查 → `sniffKind(head)` → `if (st.size > sizeLimitFor(kind)) throw` → `bytes: new Uint8Array(await this.fs.readFile(d.path))`
  - `apps/desktop/src/main/attachments/attachment-policy.ts:44` — `return sniff(head) ?? 'file'`（未识别二进制 → `file` → 20 MiB 上限，`shared/contracts/attachments.ts:74`）
  - 工具域**已有**黑名单但**未在此链调用**：`apps/desktop/src/main/tools/tool-policy.ts:11` `PATH_BLACKLIST_DEFAULTS`（含 `~/.ssh`、`~/.aws`、`~/.gnupg`、`.env`、`.git-credentials`、`C:\Windows`…），仅被 `tool-service.ts:467` 与 `tool-executors.ts:32` 消费
  - 不变量以注释形式存在：`apps/desktop/src/shared/contracts/attachments.ts:39` — `path?: string      // 仅 Preload 注入；Renderer 永不构造`
  - 外传落点：`apps/desktop/src/main/transport/real-backend.ts:1363,1365` — `form.append('files', new Blob([bytes…]))` → `${serverUrl}/api/uploads`
  - 端点 Renderer 可设：`apps/desktop/src/main/ipc/channels.ts:25` `chatSetEndpointSchema = z.object({ serverUrl: z.string().min(1).max(4096) })`

- **Why**：`toIpcDescriptor` 只在 Renderer 传**真实 `File` 对象**时才用 `webUtils.getPathForFile`；传普通对象时 `path` 原样穿过 preload（`desktop-api.ts:431`）到达 Main。Main 侧那三道检查不是包含性边界：只排除 userData **一个目录**、只要求是普通文件、大小上限靠魔数嗅探（未识别即 20 MiB）。`PATH_BLACKLIST_DEFAULTS` 在这条链上从未被调用。

- **Impact**：Renderer 一旦被攻陷（XSS 类），可读取 Electron 用户进程可读的**任意文件**并 POST 到任意 HTTPS 主机 —— 每次 ≤64 MiB（10 文件 × 20 MiB）、可重复。`~/.aws/credentials`、`.git-credentials`、`%APPDATA%` 下的凭据库都**不在**那份黑名单覆盖范围内（黑名单在 Windows 只覆盖 `C:\Windows`/`Program Files`/`AppData`），因此恰好是"黑名单挡不住"的那一类最敏感文件。这直接违反 `CLAUDE.md` 的进程边界不变量："Renderer never receives ... absolute local paths" 与 "no generic filesystem methods"。

- **为何既有文档没覆盖**：`docs/07` §9.2 与 7A 安全清单第 5 行把"`registerHandler` 校验来源 + `createIpcHandler` 校验 schema"当作完整控制。那是**形状与来源**的控制，不是**权威（capability）**的控制。S-01 在形状与来源上**完全合规**。

- **Recommendation**
  - **方案 A（推荐）**：让 `attachments:upload` 结构上无法指认文件 —— `attachments:validate` 返回 Main 签发的不可猜 `fileRef`（由 Main 解析出的真实路径铸造，带 TTL），`upload` 只接受该 handle。代价：多一次往返 + Main 侧会话表；拖拽/粘贴流已走 validate，UI 不变。
  - **方案 B（廉价但较弱）**：`path` 存在时套用 `isPathBlacklisted`，并从 schema 中移除 `path`，除非描述符确实经 `webUtils.getPathForFile` 铸造。代价：留下"Renderer 可指认任意非黑名单路径"这一比 `CLAUDE.md` 声明更弱的不变量。
  - 无论选哪个，**必须**把 `contracts/attachments.ts:39` 的注释改成描述"实际强制了什么"，而不是"意图是什么"。

---

### H-02 助手回复既不自动跟随底部，也无法被复制 — 【已二次验证：真实】

- **Evidence（跟随底部）**
  - `apps/desktop/src/renderer/src/components/CyMessageList.vue:102` `const atBottom = ref(true)`
  - 全文件 `atBottom` 赋值点**穷举**（`grep` 实测）：`:145`（`onScroll`）、`:187`（`commitScrollHeights`）、`:202`（`restoreLoadAnchor`）、`:246`（`currentId` watch）、`:271`（`restoreScrollFor`）、`:278`（`backToBottom`）、`:300`（`scrollToHighlight`）、`:362`（viewport **变矮**时贴底）。**没有任何一处由"内容增长"触发。**
  - 两个 `items.length` watcher 分别是 `:251-256`（切会话一次性恢复，`pendingRestoreId` 消费后失效）与 `:318-321`（高亮重试），都与 follow-bottom 无关。
  - `:415` `.cy-messages { … overflow-anchor: none; … }` 主动**关掉**了浏览器原生滚动锚定补偿。
  - 明文规格要求却未实现：`docs/superpowers/specs/2026-08-14-phase3-history-drafts-design.md:201` — "`atBottom && 有新内容（流式）` → 跟随回底"；`docs/03-…:213-214` — "用户位于底部附近时，流式内容自动跟随；用户主动上滚后暂停自动滚动"。
  - 门禁盲区：`tests/integration/perf-gate.spec.ts:205-216,250-255` **手动** `cont.scrollTop = …` 驱动，因此该路径从未被自动覆盖。

- **Evidence（复制）** 三条互相独立的断点：
  1. `apps/desktop/src/renderer/src/tokens.css:151` — `body { … user-select: none; overflow: hidden; }` 全局生效；唯三的 opt-in 在 `CyToolCard.vue:399,442,467`。`CyMessageBubble.vue:281-288` 与 `CyMarkdown.vue:63-67` 都没有恢复 `user-select`。
  2. `CyMessageBubble.vue` 整个模板（`:129-203`）无任何消息级操作行；剪贴板工具仅被 `CyCodeBlock.vue:11` 与 `CyToolCard.vue:14` 引用。
  3. `contextmenu` 在 `apps/desktop/src` 下 **0 命中**，Electron 不提供默认编辑菜单 ⇒ 右键复制也不存在。
  - 规格同样明确要求：`docs/03-…:205-209` §7.5（复制 / 重新发送 / 重新生成 / 播放 Public Reply）；`docs/2026-08-29-UI精修整改清单.md` §7 要求可选中文本保持可选中。

- **Why**：`upsertMessage` 追加行 → `prefix` 变 → `win.paddingTop/Bottom` 变 → `scrollHeight` 增长，而 `scrollTop` 不变且 `overflow-anchor: none` 移除了浏览器补偿，新行因此落在视口**下方**；`atBottom` 是被缓存的布尔量而非派生值，仍为 `true`，所以 `v-if="!atBottom"` 的"回到底部"按钮**也不出现**。

- **Impact**：在任何超过一屏的会话里，按 Enter 后用户自己的消息与整段流式回复都在屏幕外，且**没有任何提示** —— 用户感受是"按了发送没反应"。这是产品最核心交互在常态路径上失效。复制侧：AI 回答这一最高频操作三条路全断，用户只能手抄。`user-select: none` 同时使 Ctrl+A/Ctrl+C 无效。

- **Recommendation**：`atBottom` 改为派生化（在 `prefix`/`items` 变化后从 DOM 重算，保留既有 40px 阈值语义），并在"增长前位于底部"时于 `nextTick` 写 `scrollTop = scrollHeight`；同时按 §7.5 补消息操作行（复用 `copyText`）与 `context-menu` → 标准 Edit 菜单。代价：动作行落在虚拟列表行内，须保持在既有 `.cy-vlist-row` DOM 契约内并重跑 perf-gate ②/③。

---

### H-03 "80ms 流式节流"实为尾沿防抖，token 速率高时中间态完全不渲染 — 【已二次验证：真实】

- **Evidence**
  - `apps/desktop/src/renderer/src/utils/debounce-trailing.ts:15-18` — 每次调用先 `if (timer !== undefined) ct(timer)` 再重新 `st(...)`。这是**纯防抖**：只有静默满 80ms 才触发。
  - `apps/desktop/src/renderer/src/components/CyMarkdown.vue:18,25,30` — `MARKDOWN_DEBOUNCE_MS = 80`；`blocks.value = renderMarkdown(props.source)` 由该防抖驱动；`watch(() => props.source, () => scheduleRender())`。
  - `blocks.value` 是可见分段文本的**唯一来源**（`CyMarkdown.vue:50-57`）。
  - 语义被项目自己的测试**锁死**：`apps/desktop/tests/unit/debounce-trailing.spec.ts:11-13`（40ms 后再调用 → 只触发 1 次）。
  - 触发源：`message.store.ts:426` `m.assistantSegments = acc.toAssistantSegments()` 随每个 delta 执行。

- **Why**：delta 间隔 < 80ms 时定时器被无限重排，回调永不执行。

- **Impact**：token 速率超过约 12.5 delta/s（典型 30 tok/s ≈ 33ms 间隔，即**常态**）时，助手气泡**完全不显示渐进文本**，直到流结束或分段边界才整段出现。"流式回复"这一核心卖点在此速率下退化为一次性渲染；且没有测试覆盖 token 速率的流式渲染。

- **Recommendation**：改为**真节流 + 最大等待**（最少间隔 80ms 且保证尾沿 flush），或 rAF 合并 + 100ms 硬上限。代价：markdown 全量解析频率升到 ≤12.5 次/秒，须与 H-04 的缓存修复配套（否则每次 flush 都是全量 `marked.parse` + `DOMPurify.sanitize`）。

---

### H-04 退出时 Renderer 侧防抖持久化从不 flush，关窗前输入静默丢失 — 【已二次验证：真实】

- **Evidence**
  - `apps/desktop/src/renderer/src/stores/draft.store.ts:9` `DRAFT_DEBOUNCE_MS = 800`；`:24-28` 每次按键重排定时器；`:77-81` 的 `flush()` **只有两个调用点**：`CyMessageList.vue:238`（切会话）与 `message.store.ts:1064`（断线）
  - `settings.store.ts:80` 500ms 防抖，无 flush API；`layout.store.ts:26-29` 200ms，无 flush API
  - `beforeunload` / `pagehide` / `visibilitychange` 在 `apps/desktop/src` 下 **0 命中**
  - 主进程退出只 flush 自己那一侧：`apps/desktop/src/main/index.ts:461-466` `steps: [{credentials}, {adapter}, {diagnostics}]`
  - `index.ts:496-498` `window-all-closed → app.quit()`

- **Impact**：输入后 ≤800ms 内关闭窗口（定时器按击键重排，**连续打字时任何时刻都不落盘**），刚敲的内容无提示、无日志、无痕迹地消失；重启后才发现。设置同理（≤500ms 窗口的开关丢失）。这与工程其余部分对持久化的谨慎（原子写 + 序列化队列）形成明显反差。

- **Recommendation**：给 `draft.store` / `character-editor.store` / `layout.store` 加 `flushAll()`，并由 Main 的 `before-quit` 发一条"flush"IPC 并在 `createShutdownHandler` 既有 step 循环内 await（比 `beforeunload` 可靠 —— 后者无法 await 异步 IPC）。代价：新增一条下行 flush 契约。

---

### H-05 契约镜像大面积失守；唯一跨仓门禁不在 CI — 【已二次验证：真实】

- **Evidence**
  - `z.ZodType<T>` 编译期锚点覆盖率实测：`ipc-response.ts` **18/66**、`events.ts` **0/36**、`rest-schemas.ts` **1/25**、`character.ts` 37/46、`character-rest-schemas.ts` 26/27 → 合计 **82/199**
  - 未锚定的高流量 schema：`ipc-response.ts:14`（`ConnectionStateSchema`）、`:95`（`ToolCallRecordSchema`）、`:123`（`PublicToolEventSchema`）、`:146`（`MessageSchema`）、`:165`、`:327`、`:347`、`:375`
  - `shared/schemas/events.ts` 28 成员判别联合中 **15 个成员没有 `.strict()`**（raw wire 层 66 处全 strict）⇒ 上游 mapper 发出未声明字段时在 preload 再解析处**静默丢弃**
  - `apps/desktop/scripts/check-backend-contract.mjs:12` 自陈"本脚本不进入 CI 主流程"；`.github/workflows/ci.yml` 无 `check:contract` step。本机实测：后端目录未挂载 → **exit 2 = NOT VERIFIED**（该修复本身是真的，见 §14）
  - 实例：`ToolCallRecord.diff` — 契约声明 `shared/contracts/tool.ts:29-31` `diff?: PublicToolEvent['diff']`，实时 store 会写入 `tool.store.ts:77` `if (ev.diff) rec.diff = ev.diff`，但 `.strict()` 的 `ToolCallRecordSchema`（`ipc-response.ts:95-113`）**没有 `diff`**
- **二次验证修正**：`ToolCallRecord.diff` 目前**不可达** —— `Message.toolCalls` 的唯一生产者是 `rest-mapper.ts:169` 的 `parseToolCallSkeletons`（REST 历史 + WS 回放配对），从不携带 `diff`；而实时带 `diff` 的记录只活在 renderer 的 `tool.store`，不被写入消息。因此这是**潜伏的类型缺口**（一旦按 F-7 契约把实时记录并入 `Message.toolCalls`，`cacheMessages` 会整体 `SCHEMA_VALIDATION_FAILED`，消息缓存静默停写），**不是当前缺陷**。原报告定为 High，此处下调为 **Medium**。

- **Impact**：字段级漂移是**默认状态**而非例外：48 个 ipc-response schema 与全部 36 个事件 schema 没有任何编译期或 CI 期保护；15 个非 strict 事件成员让上游 mapper 漂移表现为"UI 少个字段"而不是报错。唯一的机器校验（25 个 REST wire schema）在没挂载后端仓库的机器上手动跑。

- **Recommendation**：给镜像命名契约类型的 schema 补 `z.ZodType<T>` 锚点（它们都已有对应类型）；给 15 个事件成员补 `.strict()`（raw 层已是 fail-closed 边界）；把 `check:contract` 接入 CI（内置契约快照）或明确降级为"非门禁"并在 doc 16 记为 NOT VERIFIED。代价：`z.ZodType<T>` 会抹掉 `.shape`（测试里已有 `as unknown as {shape}` 转换）。

---

### H-06 `RealBackend` 吸收角色域，成为双端口上帝类；Mock 结构分叉 — 【架构，已核实】

- **Evidence**
  - `apps/desktop/src/main/transport/real-backend.ts:280` `class RealBackend implements BackendAdapter, CharacterServiceBackendPort`；角色 REST 在 `:1214-1338`，文件 **1859 行**（架构债务清单撰写时为 1292 行）
  - Mock 结构**不同**：`mock-backend.ts:358` 只 `implements BackendAdapter`，角色行为独立在 `mock-character-backend.ts`（550 行），经 `index.ts:238-240` 注入
  - 端口绑定靠**无校验 downcast**：`characters/character-service-assembly.ts:43`
  - 测试代价：8 个 `real-backend*.spec.ts` 各自重写 `class FakeWs`（`real-backend-character-compat.spec.ts:9`、`character:18`、`live2d:10`、`model-services:13`、`tools:11`、`tts:16`、`voice:13`、`real-backend.spec.ts:72`）

- **Impact**：角色域没有共享的 adapter 契约，Mock/Real 结构不一致；要测一个角色 REST 调用必须拉起完整 WS 握手。这是 `docs/review/2026-08-28-架构债务清单.md` D1 的**恶化**（1292 → 1859 行 + 吸收新域），而非新问题。

- **Recommendation**：抽出 `RealCharacterRestClient` + `RealWsTransport` 于 facade 之后；让 Mock 实现同一角色 adapter 接口。复杂度 L。

---

### H-07 角色状态在 Main/Renderer 两侧用**不兼容的键空间**各缓存并各加栅栏一次 — 【架构，已核实】

- **Evidence**
  - Main：`characters/character-service.ts:128` 15s TTL，`:234-236` 以 `state:${instanceId}` 为键（**实例键**），`:245-281` epoch/in-flight 栅栏
  - Renderer：`character-runtime.store.ts:33-35` `snapshotKey = [instanceId, characterId, revision]`（**含 revision**）；`:288-308` 收到更新 revision 的快照 → `markSnapshotStale`（**从不存储**）；`:73-76` `activeState` 只读绑定键 → 其它 revision 恒 `undefined`；`:230-248` `loadState` 只在 `'ready'` 时短路，`'stale'` 会**重复请求**
  - 第三份规则副本：`CyCharacterPublicState.vue:65-74` 又写了一遍"revision 必须精确匹配"

- **Impact**：`follow_latest` 会话（绑定 revision 2、实例已推进到 3）下，Main 持续返回缓存的 rev-3 快照，Renderer 持续标记 stale 并重复请求 —— 角色卡渲染为空且**不收敛**（既不自愈也不报错）。这是多角色域（项目最新、也是最易出问题的域）的状态归属混乱。

- **Recommendation**：改为 revision 感知读取（`getCharacterState(instanceId, expectedRevision) → {state, revisionMatched}`）并把 Main 缓存按 revision 分键，或直接去掉该缓存。复杂度 M。

---

### H-08 消息列表的全量重算 + 估算器扫全文 + 数组永不封顶 — 【性能，已核实】

- **Evidence**
  - `CyMessageList.vue:53` `items`；`:91-99` `prefix`（`buildPrefix` 对未实测行调 `estimate`）；`:57-65` `dayFirst`（每消息一次 `Intl…formatToParts`）；`:116-126` `turnStartSet`
  - 估算器按文本长度线性：`utils/virtual-window.ts:9-13` `for (const line of text.split('\n')) …`、`:30` `seg.text.match(/^\s*[-*] |^\s*\d+\. /gm)`
  - 失效触发点：`:229` `heights.value[id] = h`（ResizeObserver，流式行增长或 markdown 突发时反复触发）
  - 数组无上限：`message.store.ts:917,1035` 的 `loadOlder`/`loadEarlier` 无限前插；只有 `resetConversation`（`:492-493`）清空。`session-store.ts:247` 的 `.slice(-CACHE_MESSAGES_PER_CONV)` 只约束**持久化副本**
  - 门禁只种 200 条：`perf-gate.spec.ts:276` `CYRENE_MOCK_HISTORY_LARGE: '200'`

- **Impact**：每次高度提交 = O(N) + 对每个未实测行做一次全文 `split`+正则。5000 条会话（多数行从未实测）下，每次高度提交是数 MB 的字符串分配扫描，流式期间每秒数次 → 数十 ms/s 主线程工作 + 可见滚动卡顿。项目的性能门禁规模（200 条）**结构上覆盖不到**这个量级。

- **Recommendation**：为每消息估算加 `Map<messageId, {segmentsRef, height}>` 记忆（`assistantSegments` 身份变化时失效），消除全文扫描项；并给活跃窗口封顶（保留最新约 1000 条、更早按需分页）。代价：封顶会改变回滚与跳转语义，需重定 anchor/highlight 测试与 `≤60 rows` 基线。

---

### H-09 `desktop.file.write` 在授权**之后**才检查内容大小，而 Main 线程上跑同步 diff — 【性能/稳定，已核实】

- **Evidence**
  - `main/tools/tool-service.ts:430` `const d = computeTextDiff(oldText.replace(/^\ufeff/, ''), String(rec.arguments_['content']))`（决策链第 7 步，**授权之前**）
  - 上限只在 executor 里、且**授权之后**：`tool-executors.ts:68` `if (Buffer.byteLength(content,'utf8') > MAX_WRITE_CONTENT_BYTES) throw`
  - 写入 schema **无 `.max()`**：`tool-registry.ts:48` `content: z.string()`
  - diff 的上限是**输出侧**的：`text-diff.ts:9` `diffLines(oldText, newText)` 与 `:15` `p.value.split(/(?<=\n)/)` 在 `:17` 的 `MAX_DIFF_LINES` 检查**之前**就已分配全部行

- **Impact**：`diffLines` 是同步 Myers diff，不让出事件循环。一个携带数百 KB～数 MB `content` 的工具请求（远低于 2 MiB 的最终上限、也完全在生成模型的能力范围内）足以让**整个应用**卡住一拍 —— 窗口不重绘、IPC 不回、WS 读取停摆，而所有超时都是定时器驱动的，此时**都无法触发**。

- **Recommendation**：把 `MAX_WRITE_CONTENT_BYTES` 校验前移到 `preReadForDiff` 之旁（与既有读取上限同处），或把 diff 移入 `utilityProcess`/worker 并对超阈值输入直接省略预览。代价：超限写入的错误码在授权前暴露，且大文件预览能力丢失 —— 均可接受。

---

### H-10 流式生命周期没有客户端出口（无 watchdog、取消粗粒度、切会话不取消） — 【稳定，已核实】

- **Evidence**
  - 状态设置后**永不过期**：`message.store.ts:559,564`（`activeGenerationId` / `status:'streaming'`），该文件**完全没有** `setTimeout`/`setInterval`
  - Main 的超时都键在别处：`real-backend.ts:182-188`（ack 15s / handshake 10s / REST 10s / upload 60s）—— **没有**任何键在 generation 开始或结束上
  - 丢一个 delta 比丢终态更糟：`shared/domain/stream-accumulator.ts:184` `this.state.status = this.hasGap() ? 'completing' : 'completed'` —— `completing` 会**永久滞留**
  - 取消在 await **之后**才改本地状态：`message.store.ts:789` `await api.cancel(...)`，`:801-805` 才解除；且 Main 侧**忽略参数**：`real-backend.ts:1086` `async cancelGeneration(_input: CancelGenerationInput)` → `:1091` 发无定向 `interrupt`
  - IPC invoke **两端都无超时**：`ipc/executor.ts:31-88` 无定时器；`preload/desktop-api.ts:151-157` 裸 `await ipcRenderer.invoke`
  - 切会话不取消：`conversation.store.ts:516` 唯一的切换前清理是 `stopTtsPlayback()`；`message.store.ts:492-495` 删掉半成品消息并清 `activeGenerationId`，而后端**仍在生成**

- **Impact**：WS 保持连接（因此不会触发唯一自动恢复路径 `advanceConnectionSession`）但后端卡住或丢终态时，气泡永久 `is-streaming` + "生成中…"，唯一出口是手动停止按钮 —— 而它要等一个无超时的 IPC 往返；切会话后连这个按钮都没有了，用户正在消耗后端 token 却**无法取消**。

- **Recommendation**：加 generation 静默 watchdog（对当前 generation 的每个 `generation.*` 事件重置，到期标 `interrupted` 并给出可见原因）；取消改为乐观（await 前先改本地状态，保留 `:796-799` 的归属栅栏）；协议允许时把 generationId 传给后端；切会话时取消。

---

### H-11 持久化层可能丢写/毁数据且上报成功 — 【稳定，已核实 + 二次验证修正】

- **H-11a 并发写丢数据（原报告定为 High → 下调 Medium）**
  - `credentials/atomic-write.ts:28` `const tmp = join(dir, `${basename(filePath)}.tmp`)` —— **固定**临时名；`:44-46` 的重试只覆盖"顺序陈旧 temp"场景
  - `persistence/session-store.ts` **无任何**写序列化（无 queue/lock），却有多条写同一文件的路径：`:229` `writeDrafts`(persistSession)、`:276`(setActiveConversation)、`:255` `writeCache`(cacheMessages)、`:264`(syncConversationList)、`:285-286`(purgeConversation)
  - `chat-service.ts:92,104,111` 三条都是 **fire-and-forget**（`.catch(()=>{})`）
  - 同仓已有正确先例：`credential-store.ts:50-53` 的 `queue`、`character-draft-store.ts:273-287` 的 `writeTail`
  - **二次验证修正**：冲突对是 **drafts 文件**（`persistSession` × `setActiveConversation`）与 **cache 文件**（`cacheMessages` × `syncConversationList`/`purgeConversation`）；竞态窗口是"`openSafeFile` 到 `rename`"之间的数毫秒，且 `draft.store` 已防抖，因此触发概率低。原报告的机制描述正确，但"High"过高 → **Medium**（静默丢一次草稿写，失败被 `draft.store.ts:42-44` 吞掉）
  - **Recommendation**：复用 `credential-store` 的写队列；临时名改 `${basename}.${randomUUID()}.tmp`（免费）

- **H-11b 损坏/旧 schema 会话文件被静默重置并覆写（High）**
  - `corrupt-isolation.ts:38` `await rename(file, dest).catch(() => {})` —— 隔离改名失败被**丢弃**
  - `session-store.ts:111-117` 无条件 `return parse({})` 重建空态，而 `:121` 的 `writeDrafts` 下一次就**无条件覆写**
  - `schemaVersion` 声明了但**从未被读**：`:21` `interface DraftsFile { schemaVersion: 1; … }` vs `:59` 的 `if (data.entries && typeof data.entries === 'object')`
  - 同仓正确先例：`character-draft-store.ts:116,167-169`（schema 失败 → throw → warn + isolate）、`settings-service.ts:42-56`
  - **Impact**：(a) 文件不可解析或 `safe-open` 权限检查拒绝、而改名又失败（AV/备份代理/只读目录）时，原文件**留在磁盘上**、内存态被清空、用户下一次击键即覆写；(b) 字段名变化（正是"旧数据不迁移"决策预期的情形）或任何外来 JSON 会在第一次写入时**无痕**丢弃最多 50 条草稿 + 整个消息快照缓存。该决策是"不**转换**旧数据"，不等于授权"无备份地销毁现存格式数据"。
  - **Recommendation**：`isolate` 失败视为硬错误（保留损坏文件、拒绝写入、向用户暴露持久化故障 —— `CharacterDraftStore.getLastError()` 已是现成模式）；显式校验 `schemaVersion`，并把版本不符或"非空文件解析出空态"一并送入同一隔离路径。

- **H-11c REST 写入已成功却被报失败并诱导重复提交（Medium-High）**
  - `real-backend.ts:1112` 记录 `requestTransportIncarnation` → `:1118` await fetch → **`:1124-1127` 在检查状态码之前**套栅栏 → `:1128` 才 `if (!res.ok)`
  - 行为被项目自己的测试锁死：`real-backend-character.spec.ts:230` "同一 source 的 socket reconnect 也会让旧角色 REST 响应失效" → `:246` 期望 `GENERATION_CONFLICT`
  - **Impact**：任何 WS 重连（含自动重连）都会作废在途 REST 响应，把已到达的正常 `200` 丢弃并替换为"连接来源已切换，请重试"。fetch **未被 abort**，服务端副作用已提交 ⇒ 对非幂等写（上传、建会话、保存 provider）用户被引导**重复提交**（二次上传、二次会话）。
  - **Recommendation**：区分"transport incarnation 变了但本请求已完成"（接受响应，或后续读回对账）与"source scope 变了"（丢弃）—— 栅栏的目的是阻止**另一个后端**的数据进入领域，同 scope 重连不是那个情形；无法安全接受时，改以错误契约里已有的幂等素材（`requestId`/`clientRequestId`/`idempotencyDurable`）为门。

---

### H-12 Main 无 unhandled-rejection 兜底；一个 push 点无销毁守卫 — 【稳定，已核实】

- **Evidence**
  - `grep process.on(` 在 `apps/desktop/src/main` 下**没有** `unhandledRejection`/`uncaughtException`；唯一网是 `index.ts:501` `void main().catch(...)`，只覆盖 `main()` 自己的链路
  - 具体未捕获浮空 promise 落在用户动作上：`persistence/persistence-handlers.ts:24` `void shell.openExternal(u.toString())` —— **没有** `.catch`，而同仓 `main-window.ts:122` 的同款调用**有** `.catch`（约定明明存在）
  - 三条 `void` 化的 Main 调用都经由**唯一完全无守卫**的 push 点：`index.ts:354` `pushEvent: (ev) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(...) }` —— 三个 send 点中唯一既无 null 检查也无 `isDestroyed()`
  - Renderer 侧兜底存在但只 `console.error`：`renderer/main.ts:36-37`（C-17 决策接受）

- **Impact**：Electron 主进程遵循 Node 默认 `--unhandled-rejections=throw`，无 handler 的 rejection 变成无人监听的非捕获异常 —— **既不进诊断日志也不进审计**，进程状态此后未定义。具体触发：在没有注册浏览器处理器的机器上点击回复里的 `http(s)` 链接（`shell.openExternal` reject），handler 在 await 前就返回，renderer 已收到 `{ok:true}`，UI 认为链接打开了。

- **Recommendation**：在 `main()` 注册 `process.on('unhandledRejection')`/`('uncaughtException')` 并接 `diagnostics.logger` + `audit`（对齐 renderer 的 C-17）；给 `:24` 补 `.catch`；给 `:354` 补 `w.isDestroyed()` 跳过。

---

## 5. Medium Priority Issues

| ID | 问题 | 关键证据 | 影响 |
|---|---|---|---|
| M-01 | **Renderer JS 错误从不进入诊断导出** | `renderer/main.ts:32-37` `console.error` 后即结束；Main **没有**订阅 `console-message`（`main-window.ts` 只有 `will-navigate`/`before-input-event`/`render-process-gone`）；`export-payload.ts`/`diagnostics-service.ts:295` 的 summary 只含 `origin/status/protocolVersion` | 用户导出诊断包时，**renderer 侧 JS 异常完全不在包内**；`main.ts:68-72` 的注释把"JS 异常是独立候选"列为可观测性目标，代码未落地。这是可观测性缺口，不是崩溃 |
| M-02 | **`ToolCallRecord.diff` 类型缺口**（H-05 的实例，已修正级别） | `contracts/tool.ts:29-31` 声明 `diff?`；`tool.store.ts:77` 会写入；`.strict()` 的 `ipc-response.ts:95-113` 无 `diff` | 当前不可达（`toolCalls` 只来自 `rest-mapper.ts:169`，不带 `diff`）；一旦按 F-7 契约并入实时记录，`cacheMessages` 整体 `SCHEMA_VALIDATION_FAILED`、消息缓存静默停写 |
| M-03 | **IPC 大小不变量不是不变量** | `registry.ts:39-43` 只校验 arity；4 MiB 只在 `session-store.ts:235` 一处执行；`voice:audio-chunk` 每块 1 MiB 但**无累积/速率上限**；`ipc-limit.spec.ts:59-61` 只断言常量值 | 文档（doc 07 §6.3）声明为全局不变量，实际是逐通道自选。危害有限（Renderer 本就能自伤），但说明"单一收口"是**路由点而非策略点** |
| M-04 | **`shell.openExternal` 三处调用三种严格度** | 严格：`persistence-handlers.ts:21-23`（`new URL` + 协议白名单 + 2048 上限）；中等：`main-window.ts:120-122`（`classifyNavigation`）；**最松**：`main-window.ts:114` `details.url.startsWith('http:')` | 三条路径中，被 `window.confirm` 保护的只有 markdown 点击（`CyMarkdown.vue:41`）；最松的那条无确认。**二次验证修正**：`startsWith('http:')` 在 URL scheme 文法下**只能**匹配 http/https（`URL.protocol` 必带冒号且 scheme 字符集受限），因此原报告"`http:evil` 可绕过"的论证**不成立** → 这是**一致性/可维护性**问题而非可利用漏洞，定为 Medium（若只算安全性则是 Low）。推荐抽 `isSafeExternalUrl()` 由三处共用 |
| M-05 | **`preload`/`Main` 双重校验不对称且不统一** | Main 双向校验（`executor.ts:32-42`）；preload 对所有方法校验**响应**（`desktop-api.ts:230-242`）但只对 character 路由校验**请求**（`:331,335,339…`），chat 路由原样透传（`:302-304`） | 防御纵深分布不均；`doc 07` §6.2 已正确声明 preload 校验不是安全控制，故这是**一致性**问题 |
| M-06 | **preload 的 `marker` 参数是死依赖**（原报告 S-05 的错误部分已证伪，剩余部分保留） | `main-window.ts:143` `marker: crashMarker`（**按值**在 `createMainWindow` 时求值为 `null`），`handleRendererGone`（`:29-41`）**从不读** `deps.marker`，只调 `deps.setMarker`（`:39`） | **功能是好的**：`setMarker` 闭包写模块变量，`getCrashMarker()` 读同一个变量 —— `tests/integration/renderer-crash.spec.ts:60-64` 实测 banner 出现、marker 被一次性消费。真正的问题只是 `marker` 字段是**说谎的注入依赖**：任何未来"让 `handleRendererGone` 读 `deps.marker`"的重构会静默破坏该功能。建议删掉该字段 |
| M-07 | **secret scanner 对最可疑的目录树是盲的** | `verify-sensitive.mjs:283-284` 文件集仅为 `git ls-files`（即使 `--include-untracked` 也到不了被 ignore 的路径）；`verify-sensitive-core.mjs:80-84` **整树**排除 `third_party/`（291 文件）等 3 个前缀，无行级兜底；allowlist 校验（`:296-322`）**不约束 anchor 广度**，`rules: undefined` 意为"全部规则"，故 `{anchor: /./}` 可一次性放行全部 8 条规则而仍满足 fail-loud 检查 | `tmp/` 下恰有 `token-snapshot/`(57 文件)、`token-apply.mjs`、`token-audit*.mjs` 等被扫描器**完全看不见**的路径；绿线高估了实际检查范围 |
| M-08 | **`noImplicitAny` 被共享 preset 显式关闭** | `node_modules/@electron-toolkit/tsconfig/tsconfig.json:7,17` —— 同时有 `"strict": true` **和** `"noImplicitAny": false`；两个 app tsconfig 都未重新打开 | 显式列出的 flag 胜过 `strict` 家族；与 M-09 叠加成两个 `any` 逃生口 |
| M-09 | **5/11 个 `@framework/*` import 走空通配声明 ⇒ 隐式 `any`** | `live2d/framework.d.ts:14` `declare module '@framework/*'`（**无体**）；只显式声明了 6 个子路径（`:16,43,66,88,100,110`）；`adapter.ts:29-33` 导入的 `cubismmotion`/`cubismmotionmanager`/`cubismexpressionmotion`/`cubismexpressionmotionmanager`/`cubismmodelmatrix` **均无显式块** | Live2D adapter 是首方最大的 renderer 模块之一，却只有部分被类型检查；vendored SDK 改签名/改名对 typecheck 与 lint **都不可见**，只在运行时炸。该类已发生过：`docs/review/2026-08-18-阶段5批次B-决策记录.md:37` 记录了 `CubismId.getString()` vs `.getId()` 的混淆 |
| M-10 | **`pnpm lint` 不含任何类型感知规则** | `eslint.config.mjs:19` 用 `tseslint.configs.recommended`（非 type-checked），无 `projectService`；缺 `no-floating-promises`/`no-misused-promises`/`no-unsafe-*`/`await-thenable`/`require-await` 等 | `--max-warnings=0` 只能提升**已存在**的规则。318 处 `as` 断言与全部浮空 promise 都在门禁之外；本报告里每一个"类型说 X、代码做 Y"的问题都通过了这道门 |
| M-11 | **4 份手抄的安全校验器已文本分叉，只有 1 份被测** | `isSafeRegistryId`/`isSafeThemeColor`/`isUtcIsoTimestamp`/`SAFE_CSS_NAMED_COLORS` 位于 `shared/schemas/character.ts:87,98,109,139`、`rest-schemas.ts:8,16,36`、`raw-schemas.ts:16,25,83,103`、`character-rest-schemas.ts:38,48,73,94`（其文件头自陈"四处修改需同步"）；shared 副本用 `CHARACTER_LIMITS.registryId`（`:72-73` = 200/64），另三份**硬编码 200/64** | 测试只覆盖 shared 副本 + 2 份的颜色拒绝路径；改一处不改其余 = 安全校验在部分通道静默放松 |
| M-12 | **"这个异步结果还是当前的吗"没有共享原语，有 7 种方言** | `message.store.ts:150-157`（4 个 owner symbol）、`cache.store.ts:54-72`、`character-runtime.store.ts:223-228`（6 字段 owner）、`character-catalog.store.ts:185-200`（epoch+generation+request，11 处复查）、`character-editor.store.ts:282-287`、`identity.store.ts:90-97`、`conversation.store.ts:347-360` | 与 `cloneValue` 事故同类：`docs/review/2026-09-10` 记录六份副本"靠自觉保持一致"，其中一份漏了就 `DataCloneError` 崩掉消息列表。建议抽一个 operation-scope helper，先从 message + character-catalog 迁移 |
| M-13 | **连接身份有 3 种定义；Main 铸造的 source 栅栏只有 1 个 store 读** | `real-backend.ts:836` 每次 connect 铸 `connectionScopeId`，但只盖在 2 类事件上（`:809-813`）；`message.store.ts:58-70` 用自己的签名元组；`conversation.store.ts:78-85` 第二种；`bootstrap.ts:103-111` 第三种；`bootstrap.ts:119-129` 记录了它们不一致时的形状 | 直接连 `connected→connected` 时，对角色 store 是"新 source"、对 messageStore 是"同一会话" —— 这类分歧正是多角色域缺陷的温床 |
| M-14 | **Main 侧值导入环已存在，并已逼出一份重复实现** | `tool-service.ts:7` ↔ `tool-executors.ts:9`（值导入；`tool-service.ts:83` 自陈"值导入互引…仅函数体内使用不触发 TDZ"）；`grant-store.ts:11` 也值导入 `ToolServiceError`。**后果已可见**：Wayland 检测**实现了两遍** —— `tool-service.ts:101-105`（用于 `:473`）与 `tool-executors.ts:16-20`（用于 `:99`，注释写"独立实现免循环依赖"），且两个 spec 只测注入覆盖（`tool-service.spec.ts:292`、`tool-executors.spec.ts:233`），**重复的那份 env 默认值无测试** | Renderer 有 Tarjan 环门禁（`store-graph.spec.ts`），**Main 完全没有**；且该门禁只匹配同目录 `from './x.store'`（`:36`），看不到经工具函数或别名的边 |
| M-15 | **助手内容是 Renderer 计算的权威副本，却由 Main 持久化** | 分段合并/去重/缺口/终态语义全在 `shared/domain/stream-accumulator.ts:12-23`，唯一生产消费者 `message.store.ts:21,553`；最终消息经 `message.store.ts:610-616` 推给 Main，Main 只做形状再校验 + 按 id 合并（`session-store.ts:234-256`） | Renderer 的累积缺陷会变成**持久历史**；`CLAUDE.md` 把消息不变量划归 Main，实际 Main 无法执行 |
| M-16 | **`message.store`（1120 行）/ `conversation.store`（787 行）现在还owns 角色世代身份** | `message.store.ts:40-56,131-133,143,473-489`；2026-09-10 记录已推迟拆分 | 不是"太长"的抱怨：后果是**消息分页、传输栅栏、角色身份三者必须一起评审与回归** |
| M-17 | **`live2d:read-model-file` 读文件无大小上限且经 IPC 整体回字节** | `ipc/live2d-handlers.ts:38-40` `readFile(gate.absPath)` → `new Uint8Array(buf)`；协议通道 `protocol/handler.ts:66` 是 `net.fetch` **流式**，IPC 通道**整体缓冲** | 同一文件两条通道不对称。受限（文件须在 integrity 清单内且尺寸与清单一致，模型由用户自装），故为可用性而非机密性；但特权 Main 进程的内存放大由 Renderer 触发 |
| M-18 | **下载无任何超时，附件/贴图可永久转圈** | `media-service.ts:150`（唯一信号是 renderer 自己的请求信号，`<img>` 等待响应时不会 abort）、`:224`（贴图代理）、`:247`（`checkStatus` Range-0 探测）均无超时；`AbortSignal.timeout` 在 main 下 0 命中 | 上游接受 TCP 连接后永不响应时，`cyrene://` 请求永不 settle ⇒ `<img>` 既不 `load` 也不 `error` ⇒ 占位符永不出现、无原因、无重试。正是 2026-09-10"渲染失败态"修复想消灭的那类死角 |
| M-19 | **设置保存失败对用户不可见且被丢弃** | `settings.store.ts:85-98`：`pending = {}` 在 `await` **之前**执行，catch 只写 `saveError`（`:97`，`:130` 导出）；grep 显示**无任何组件渲染它**；而 `CyLive2DPane.vue:228` 却告诉用户"修改即时预览，500ms 自动保存" | 用户拨动 Live2D / 自动朗读 / 字幕开关，看到即时生效 + "已保存"文案，重启后被静默还原。doc 11 §9 明确要求 未同步/同步中/已同步/错误 四态 |
| M-20 | **`--cy-accent`（背景色 token）被当文本色用 15 处** | `tokens.css:30` `--cy-accent: light-dark(#dce8ff, #294466)`，而同文件 `:32` 有配对的 `--cy-accent-text`。15 处在 11 个文件：`CyToolApproval.vue:150-151`（**「允许一次」安全授权按钮**，在 `#ffffff` 上 ≈1.23:1）、`CyLinkAttachment.vue:17`、`CyRealtimeBar.vue:53`，以及 hover 家族 `CyNavRail.vue:129`、`CyChatInput.vue:510,618,677,734,756,773`、`CyConnectionPanel.vue:312,527`、`CyMessageList.vue:430`、`CyToolCard.vue:418`（≈1.05:1） | 应用里后果最重的那个按钮标签**几乎不可见**；hover 时图标/文字直接消失。两套主题下均远低于 4.5:1 |
| M-21 | **`CyVoiceConsentDialog` 是全屏 modal，但零焦点管理** | `CyVoiceConsentDialog.vue:14-20` `role="dialog" aria-modal="true"` + `:33-41` `position:fixed; inset:0`；91 行文件内**无** `.focus()`、无 `activeElement`、无 `keydown`、无焦点恢复、无关闭按钮。对比四个做对的：`CySettingsView.vue:59-68,89-98`、`CyHistoryViewer.vue:171-181,210-226`、`CyProfileWizard.vue:77-81,142-152`、`CyToolApproval.vue:60-85` | 键盘用户触发后焦点仍在覆盖层**之后**的麦克风按钮上，Enter 会重新触发语音动作而不是回答提示；Tab 走进被遮挡控件；Escape 无效；读屏器可能永远不告知对话框已出现 —— 用户不知道录音正卡在一个他看不见的问题上 |
| M-22 | **按住说话按钮键盘不可操作** | `CyChatInput.vue:406-419` 只绑 `@pointerdown/@pointermove/@pointerup/@pointercancel`，**无** `@click`/`@keydown` | 它是原生 `<button>`（可 Tab、看起来可操作），但键盘唯一能产生的 `click` 无 handler ⇒ WCAG 2.1.1 失败，且**全程无替代路径** |
| M-23 | **响应式断点 9 处永不匹配，`BREAKPOINTS` 是死代码** | `main-window.ts:76` `minWidth: 1100` vs `@media (max-width: 680px)`（`CySettingsView.vue:247`）及 720/760/560px 共 9 处；`constants.ts:13` `BREAKPOINTS` 只被自己的定义和 `layout-constants.spec.ts:20-25` 引用 | doc 03 §3.1 与整改清单 §2/§5 把它当作**产品承诺**，测试还断言了数值，给出"响应式分层存在"的假信心 |
| M-24 | **`prefers-reduced-motion` 零支持；项目自己的"减少动态"开关不管 CSS 动画** | grep `prefers-` 全 renderer **0 命中**；6 处 `animation` **全部 `infinite` 且全部无门控**（`CyAttachmentQueue.vue:38`、`CyProfileCard.vue:156`、`CyChatInput.vue:647`、`CyMessageList.vue:432`、`CyRealtimeBar.vue:67`、`CyToolCard.vue:320`）；`settings.live2d.reduceMotion` 只在 `CyLive2DPanel.vue:115,159` 被读 | 该开关描述文字就是"减轻晕动"（`CyLive2DPane.vue:206`），但开启后 5 个元素仍永久脉冲/闪烁/旋转；整改清单 §5 line 73 明文要求"UI 动画也应尊重该设置" |
| M-25 | **Live2D 纹理由本项目 glue 创建却从不 `deleteTexture`** | `live2d/adapter.ts:729-737` `gl.createTexture()` + `texImage2D`；teardown（`:666-681`）只置 `this.gl = null; this.canvas = null`；grep `deleteTexture` 只命中 vendored framework 的离屏渲染目标 | 2048² 模型（Haru 自带两张，1.53MB + 1.19MB 源）每次加载约 **33 MB VRAM** 滞留至 GC；面板下拉每换一次模型（`CyLive2DPanel.vue:329`）再滞留一份，试听模型可无界累积。切换瞬间还有两份并存（`controller.ts:170-172` 先建后毁） |
| M-26 | **录音把整段 PCM 历史留在 renderer 堆里，停止时再翻三倍** | `voice/voice-capture.ts:96` `floatChunks: Float32Array[]` 每 20ms 追加（`:275`），只在停止时消费（`:178-187` 建 `AudioBuffer`）；唯一约束是 `voice.store.ts:29` 的 `RECORD_HARD_CAP_MS = 600000` | 16kHz 单声道 float32 = 64KB/s ⇒ 10 分钟录音滞留 **约 38 MB** + 约 30000 个独立 `Float32Array` 对象头；停止瞬间再加两份完整拷贝（扁平数组 + `AudioBuffer`）≈ **115 MB 瞬时**，恰在用户按下停止的时刻 |
| M-27 | **消息行每次渲染对响应式代理做深克隆，且 `structuredClone` 必然先抛异常** | `CyMessageList.vue:31-36,393` 每可见行每次列表渲染调用一次；`character-catalog.store.ts:129-130` 命中缓存后 `return cloneValue(cached)`；`shared/domain/clone.ts:26-32` `try { structured(value) } catch { JSON.parse(JSON.stringify(value)) }`，而缓存值本身是深响应式的（`:76` `ref<Record<…>>`）⇒ **每次都抛 `DataCloneError` 再走 JSON 回退**（本机实测 20000/20000 次） | 每次列表重渲染约 1ms（16.9µs × ≤60 行），占 16.7ms 帧预算的 6–12%；滚动时约 1MB/s 短命字符串垃圾。且这正是曾经崩掉消息列表的同一条调用链 |
| M-28 | **`diagnostics:clear-logs` 让 Renderer 抹掉本地审计痕迹** | `ipc/diagnostics-handlers.ts:28-29` 零参数、无二次确认、无重认证；`diagnostics-service.ts:261-269` 清空后又把 `diagnostics:logs-cleared` 审计写回**同一个被清空的目录** | 反取证：被攻陷的 Renderer 可在外传（H-01）或用户察觉之前，先销毁自身工具调用/端点变更/连接历史的本地记录。它无法销毁 logs/audit 之外的数据，也无法读取日志，因此是证据遏制而非提权 |
| M-29 | **集成测试门槛存在但开发态（`pnpm dev`）零自动覆盖** | `helpers/app.ts:76` `delete env['ELECTRON_RENDERER_URL']` + `:77` `args: [ROOT]`（跑构建产物）；`config/env.ts:41-42` 决定 dev 分支；`docs/review/2026-09-10-dev形态Live2D资源跨源失败修复-决策记录.md` 记录该 bug 并明说"dev 形态仍无自动化测试覆盖" | 只在 Vite dev server 下可达的回归（资源供给、dev CSP 头、`@fs`/`@vite` 拒绝、受信 origin 门控）**全部**无保护 —— 而这一类已经真实产生过一次用户可见故障 |
| M-30 | **没有任何测试断言"每个 `IpcChannels` 都有已注册 handler"** | `IpcChannels` 的完整枚举只出现在 4 处**否定式**成员检查（`ipc-security.spec.ts:65,74,82,91`）；暴露面哨兵是硬编码的 **preload 键**列表，与 channel 无映射（`:39-56`）；注册分散在模块里（`handlers.ts:39` 往下），`grep registerHandlers` 在 `tests/**` 下 **0 命中**；`registry.ts:8` 的 `registered` 是模块私有 | 一个 channel 加进 `IpcChannels` + preload 但从未注册（或 handler 改名）⇒ 功能永久以 Electron "no handler registered" 失败，而 typecheck/lint/unit/integration **全绿** |
| M-31 | **唯一的端到端审计断言无法区分成功与失败** | `tests/integration/audit-lifecycle.spec.ts:27` catch 吞掉一切，`:33,35` `.toContain('credential:set')` —— 该子串同时匹配 `credential:set success` 与 `credential:set failed`；工具审计只有单测（`tool-audit.spec.ts:5-28` 测 mapper 输出对象） | 六条强制测试路径（授权/拒绝/超时/取消/冲突/审计）里前五条都有显式测试，**审计腿**只有 mapper 级 + 一次子串 grep。审计 sink 停止写成功记录、或只写失败，测试仍绿 |
| M-32 | **真实 `safeStorage` 加解密路径在 CI 从未被执行** | 所有单测注入 fake（`safe-storage.spec.ts:6-14`、`credential-store.spec.ts:16-24`）；唯一真实往返在 `ipc-security.spec.ts:107-130`，而 `:111` 按 `getCredentialStatus()` 分支 —— 无 keyring 的 headless Linux（即 CI）走 `basic_text → unavailable` 分支，只断言 `CREDENTIAL_UNAVAILABLE`（`:125`） | 最高风险的凭据行为（OS 加密确实被使用、密文跨进程重启能往返）只在有可用 keychain 的开发者机器上被验证。降级路径**是**被测的（这点做得对） |
| M-33 | **`electron-tools.spec.ts` 硬编码 POSIX fixture 根** | `:19` `const FIXTURE_ROOT = '/tmp/cyrene-fixtures'`（喂给 `CYRENE_MOCK_TOOL_ALLOW_ROOT`，`:62,77,189…`）；同文件 `:20-27` 已修过姊妹问题并解释了模式（`BLACKLISTED_DIR = process.platform === 'win32' ? 'C:\\Windows' : '/etc'`） | Windows 上该 mock allow-root 解析为 `C:\tmp\cyrene-fixtures`，与真实用户目录走**不同的字符串变换路径**。本仓库已两次被 Windows 路径处理咬过（`safe-open.ts`/`atomic-write.ts` 的 8.3 短名、`normalizeToolPath` 的盘符解析），而 Windows 是 `CLAUDE.md` 列在首位的目标平台 |
| M-34 | **secret scanner 无端到端测试；allowlist 无 anchor 广度防御** | `tests/unit/verify-sensitive.spec.ts:3` 自陈"脚本自跑…不走单测"，只 import `verify-sensitive-core.mjs`；56 条 `ALLOWLIST`、`git ls-files` 外调、两个退出码**均无测试**；"禁止用通配锚定批量放行"只是注释（`verify-sensitive.mjs:15`） | 门禁的绿线高估实际检查范围；一次静默收窄扫描面的回归（新增排除前缀、`git ls-files` 调用坏掉）会持续通过 |
| M-35 | **生产 bundle 未压缩** | electron-vite 三个 target 默认 `minify: false`（`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:536,300,407`），`electron.vite.config.ts` 未覆盖；产物 `out/renderer/assets/index-*.js` = **1,731,370 B / 44,728 行**，仍带 license banner 与中文源码注释；`out/main/index.js` 585,046 B；`out/preload/index.js` 217,190 B。**反证（已验证良好）**：`sourcemap` 未设且 `out/` 下 **0 个 `.map`** | 约 2.5 MB 源码文本随包分发；冷启动解析成本；`asar: false` 下这些注释与模块布局对任何审计者是免费的侦察信息 |
| M-36 | **无 chunk 分割、无动态 import，15k 行 vendored framework 与 app shell 同块** | `out/renderer/index.html` 只加载一个 module（`index-DJjY4GeT.js`）；构建只产出 `index-*.js`/`index-*.css`/`pcm-worklet-*.js`；`electron.vite.config.ts` 无 `build.rollupOptions`/`manualChunks`；`import('` 在 renderer 下只命中类型位置 | `CLAUDE.md` 的不变量是"Live2D 是纯展示、必须能在不阻塞聊天的情况下降级"，但在 bundle 层面**没有任何降级**：整个 framework 解析完之前 shell 无法执行；framework 模块作用域的语法/运行时错误会让整个应用失败而非只坏一个面板 |
| M-37 | **Live2D 在最小化/被遮挡时仍全速渲染** | `main-window.ts:96` `backgroundThrottling: false`（`:91-95` 的注释把"窗口隐藏暂停"明确委托给 app 自己的 active 门）；但该门没有窗口状态项：`CyLive2DPanel.vue:55-57` `active = currentView==='chat' && live2dShown && enabled && status==='ready'`；`visibilitychange`/`document.hidden`/`IntersectionObserver` 在 `apps/desktop/src` 下 **0 命中**；main 也不推送 minimize/hide | 应用最小化时仍在做每帧完整模型更新 + 绘制（`auto` 模式约 60/s，`quality` 模式 `perf.ts:52-53` 返回 `0` 即无上限，本项目真机记录实测过约 240Hz）—— 对不可见窗口持续 GPU/CPU 唤醒与耗电。门禁只覆盖**应用内折叠**（`perf-gate.spec.ts:381`） |
| M-38 | **全量依赖树双份进包：约 16 MB 死重** | `package.json:37-45` 把 `vue`/`pinia`/`marked`/`dompurify` 放在 `dependencies`，而它们只被 renderer 使用且已打进 1.73MB chunk；`out/main/index.js` 实测只 `require("diff")`/`require("ws")`/`require("zod")`。打包后 `resources/app/node_modules` = **20.87 MB**（`@vue` 6.35、`zod` 4.03、`@babel` 3.76、`vue` 2.40、`dompurify` 1.66…） | `dependencies` 是**打包契约**而非构建输入清单；把它当后者会让每个 renderer-only 库连同传递树被原样复制。约 16 MB 重复且可直接改写的文件，且 `dependencies` 不再表达"main/preload 运行时需要什么"这一保命不变量 |
| M-39 | **Windows 打包路径从未在 CI 验证；`pnpm package` 曾在本机 fuse 步骤失败** | CI 只在 Linux 打包（`ci.yml:136` job `artifact`，`runs-on: ubuntu-latest`）；`windows` job（`:151-170`）只跑 `typecheck && lint && test && build`，**不跑** `package`/`verify:artifact`；本机 `pnpm package` 首跑在 `@electron/fuses` 步骤 `ENOENT … Cyrene.exe` 失败、重跑即过 | 主目标平台（Windows）的打包与产物校验路径无任何 CI 保障；维护者执行文档所述命令会看到间歇性硬失败。`linux.executableName: Cyrene` 是**手工钉**的（`electron-builder.yml:22`），而 `verify-artifact.cjs:71` 的 win32 分支从未在 CI 执行 |
| M-40 | **CI 不跑 dev 形态、不跑 `check:contract`；`windows` job 无 Electron 缓存** | `grep check:contract` 在唯一 workflow 中 0 命中（脚本自陈不进 CI）；无 job 设 `ELECTRON_RENDERER_URL` 或起 `electron-vite dev`；`windows` job 无 `~/.cache/electron` 缓存步骤 | 只在 dev 形态或跨仓契约上出现的回归对门禁不可见 —— 而这两类项目历史上都已发生过 |

---

## 6. Low Priority Issues

| ID | 问题 | 证据 | 备注 |
|---|---|---|---|
| L-01 | 未压缩 bundle 下 `@types/marked` 是弃用 stub | `package.json:49`；`node_modules/@types/marked/package.json` → `"deprecated": "This is a stub types definition. marked provides its own type definitions"`；`marked/package.json` 自带 `"types"` | 唯一可移除依赖（其余 14 个经测试/脚本/配置核实均有真实使用点）。当前 typecheck 通过，无实际破坏 |
| L-02 | `check:contract` 的两条"部分验证"路径仍 exit 0 | `check-backend-contract.mjs:60-64` 的"后端未挂载 → exit 2"修复**是真的**（本机实测 exit 2）；但 `:285-286` 有 `rest.py` 缺失时**静默跳过整个 REST 半段**并 exit 0，`:133` 帧循环在无 `ws-v2-*.jsonl` 时退化为 `:149-167` 的两个合成探针（足以满足 `:171` 的防假通过守卫） | 修复只覆盖了"完全缺失"，未覆盖"部分挂载" |
| L-03 | `isDocumentRequest` 只依赖客户端可提供的 `Sec-Fetch-Dest` | `media-service.ts:50-52`；`protocol/handler.ts:111,125` | 浏览器会设置该头，应用内 fetch 无法伪造；且代码自己已加第二把锁（`navigation.ts:30-31` 的前缀 deny + `csp.ts:12` 的 `frame-src 'none'`）。仅在 handler 出现非浏览器调用者时才成为问题 |
| L-04 | preload 路径只靠 `__dirname` 布局、无运行时断言 | `main-window.ts:83` `join(__dirname,'../preload/index.js')`；`verify-artifact.cjs:14` 的期望布局 | 若解析错，Electron **静默**失败：`window.desktopApi === undefined`，所有 UI 功能降级而不报错。该失败模式已被 `--smoke` 断言覆盖（`:190`），但只在 CI |
| L-05 | 崩溃 marker 的 `marker` 字段是说谎的注入依赖 | 见 M-06 | 功能正常，仅删除死参数 |
| L-06 | `openExternal` 经 `window.open` 绕过 IPC 白名单 | `persistence-handlers.ts:21-23`（严格）vs `main-window.ts:114`（前缀测试） | 与 M-04 同根因 |
| L-07 | `resolveTrustedDevOrigins` 在**所有**构建（含打包）中无条件信任任意回环端口 | `trusted-renderer-origin.ts:20,41-42` 被 `registry.ts:28` 无 `isPackaged` 门调用 | 打包态下主窗口是 `cyrene://renderer` 且唯一，`isSenderCorrect` 的 `event.sender !== win.webContents` 已挡住其它窗口 ⇒ **当前不可达**。仅在新增第二个窗口时变为可达（与 L-08 同题） |
| L-08 | `mainWindow` 是单模块槽位，但 `tool:event` 广播给**所有**窗口 | `registry.ts:7-11`（单槽位）vs `index.ts:354` `for (const w of BrowserWindow.getAllWindows()) w.webContents.send(...)`；对比有守卫的 `:248`、`:296`（都走 `getMainWindow()`） | 今日仅一个窗口 ⇒ 不可达。但若将来加第二个 `BrowserWindow`，它会收到主窗口会话的完整工具事件流（含截图 data URL 与 diff），却从未被纳入任何信任集合。`:354` 是三个 send 点里唯一无 null/销毁检查的 |
| L-09 | `getEndpoint()` 向上行完整后端 URL，是"绝对路径不过桥"的未申明例外 | `chat-service.ts:72-75` 返回 `e.baseUrl` | 用户已知配置，非机密泄漏；问题是同文件族里 `diagnostics-service.ts:244-245` 特意 sanitize、`tool-service.ts:281` 只发 `pathSummary` —— 这是一处**未标注**的例外，建议加一行注释说明为有意为之 |
| L-10 | `attachments:validate`/`upload` 接受 Renderer 自述的 `size`，与 Main 后来的真实 `stat` 无交叉校验 | `attachment-policy.ts:64-65` 用自述值算聚合；`upload-service.ts:117,153` 用真实值 | 今日不可达（Main 读盘前一律以 `st.size` 重判），故只是"聚合门是建议性的"；但注释 `attachment-policy.ts:61` 把它写成"客户端/权威共用的预检"，未来若信任自述值以省一次 stat 会静默移除唯一真实上界 |
| L-11 | `session-store` 每次写整文件、无批处理 | `session-store.ts:120-125`；`persistSession` 每次调用即写 | 原子写纪律正确且是有意为之；观察点是**成本随存储总量而非增量增长**（50 条接近 100KB 上限的草稿 ⇒ 每次保存都是数 MB 磁盘写）。若为 M-03 加速率限制，应一并覆盖此处 |
| L-12 | `preload` 的 IPC 传输错误丢掉成因 | `desktop-api.ts:154-156` 把"handler 未注册"等一律映射为不透明的 `'[IPC_ERROR] IPC 调用失败'`，丢弃 channel 名；`bootstrap.ts:282,286` 又把该字符串直接喂给连接横幅 | 与本报告 M-01（renderer 错误不进诊断）叠加 |
| L-13 | 三处 `as never` 抹掉类型检查 | `grant-store.ts:64` `deps.settings.save({ tools: { grants: next } } as never)`（该形状**结构上可赋值**，cast 疑似多余）；`attachments/attachment-state.ts:48` `...(action.message ? { message: action.message as never } : {})`（见 L-14） | 若某个 cast 真在承重，说明存在被永久掩盖的真实分歧 |
| L-14 | 附件失败把机器码当用户文案渲染，而人话被写进未声明字段 | `attachment.store.ts:53,110` 写入 `reason: 'precheck'`/`'upload_failed'` 与 `message`；reducer 用 `as never` 让它通过（`attachment-state.ts:48`）；模板只渲染 code（`CyAttachmentQueue.vue:24` `{{ a.reason }}`），标签还错写成「校验失败」（`:12`） | 拖入超大图片显示字面量 `precheck`；上传失败显示 `upload_failed`。两个字段角色被写反 |
| L-15 | 7 处未加守卫的 `(e as NodeJS.ErrnoException).code` | `app/lifecycle.ts:80`、`credentials/credential-store.ts:67`、`persistence/safe-open.ts:67,90,100`、`persistence/session-store.ts:112`、`settings/settings-service.ts:49`、`persistence/user-data-dirs.ts:30,71`（9 处/7 文件）；同仓已有守卫先例 `tool-policy.ts:104`、`character-draft-store.ts:49` | catch 绑定是 `unknown`，`throw null`/原始值抛错时 `(e as X).code` 会抛 `TypeError`，把"ENOENT → 首次运行默认"的**设计分支**换成非捕获异常。`settings-service.ts:49` 与 `session-store.ts:112` 在启动路径上 |
| L-16 | eslint 的 `**/*.d.ts` 忽略比"vendored 树排除"更宽，且覆盖了首方 stub | `eslint.config.mjs:13,14` vs `tsconfig.web.json:22`；受影响：`live2d/framework.d.ts`（**首方手写**）、`preload/window.d.ts`、`main/env.d.ts`、`renderer/env.d.ts`、`live2d/core/live2dcubismcore.d.ts`、`voice/pcm-worklet.d.ts` | 那个"唯一职责是准确描述 15k 行被排除代码"的文件，只被 `tsc` 检查（且按 M-09 只覆盖 6/11 子路径） |
| L-17 | ~39 个导出值在 `src` + `tests` + `scripts` 中无人引用 | `shared/schemas/character-ipc.ts:69-85`（13 个别名）、`main/ipc/channels.ts:29,30,74,75,78,79,80,81`（8 个，注释称"chat-handlers 引用兼容"）、`character-rest-schemas.ts:387,401-428`（`RestCharacterProtocolErrorSchema` + 10 个未用 `parseRest*`）、`rest-schemas.ts:58,140`、`renderer/stores/session.ts:68,84`、`utils/session-boundary.ts:52`、`character-service.ts:383`、`character-draft-store.ts:278` | 死导出面放大了"暴露面"计数（安全/评审都依赖它）；13 个别名读起来像活跃的兼容层，会诱使新代码选错名字。`noUnusedLocals` 看不到导出符号 |
| L-18 | `matchesCharacterQuery` 在同一文件里被实现了两遍且完全相同 | `character-catalog.store.ts:495-500`（store 作用域，被 `:492` 用）与 `:659-665`（模块作用域，被 `:632,638,650` 用）；内层定义在外层闭包内**遮蔽**外层，两份都是活的 | 改一份不改另一份会让列表过滤与合并栅栏分歧：summary 可被过滤出可见列表却被 `mergeSummaries` 重新插入。无测试断言两者相等 |
| L-19 | `as` 断言计数与 `noUncheckedIndexedAccess` 缺位 | `src/` 下 318 处 `as`、14 处 `as unknown as`（`tests/` 另有 158 处）；`tool.store.ts:155` 的 `.filter(Boolean)` 与 `main.ts:115` 的 `r?.` 说明作者心智模型已包含 `undefined`；`main/index.ts:370` `path: r.filePaths[0]` 声明为 `string`，取消对话框时实为 `undefined`（兄弟调用点 `tool-executors.ts:26` **有**守卫） | 类型在说谎而非简化；今日路径都有守卫 ⇒ 潜伏，下一次信任该注解的重构即变活 |
| L-20 | 跨仓 wire 响应字段上的 `.default()` 会**编造**值而非失败 | `rest-schemas.ts:211,212,213,217,218,222,230,233`（`credentialConfigured: z.boolean().default(false)`、`source: …default('static')` 等 7 处）；被 `providers-mapper.ts:41` 消费；同一字段在手写 wire 接口里又是 optional（`providers-mapper.ts:13,22`）——**第三份 requiredness 契约** | 后端改名/丢弃 `credentialConfigured` 时，所有 provider 渲染为"凭据缺失"却解析全绿 —— 错状态 UI + 零诊断，而不是协议级失败 |
| L-21 | 异步失效（"bump 计数器"）是无强制机制的约定，且已出现 3 种计数器集合 | `character-editor.store.ts:182-187`（bump 5 个）、`:329-344`（只 bump 2 个 + 重置 6 个状态字段）、`:386-398`（同款少一行）、`:827-833`（bump 5 个但集合不同） | 意味着四处里至少有一处是错的，或者其余三处过度失效；后果是"用户已改动的草稿上显示旧校验结论" |
| L-22 | `LIVE2D_PATH_PREFIX` 的"单一事实来源"仍有一处硬编码副本 | `shared/contracts/live2d.ts:15-22` 声明单一来源并叙述了正因该重复而付出的调查代价；`main/protocol/live2d-path.ts:10`、`live2d/adapter.ts:35,39`、`dev-resource-fetch.ts:26,65` 都从它派生 —— 但 `CyLive2DPane.vue:24-26` 仍写死 `const LIVE2D_BASE = 'cyrene://renderer/__cyrene-live2d/'`（用于 `:45`） | 改前缀会静默只在设置页预览失效，主面板照常工作 |
| L-23 | 空字符串哨兵值 | `tool.store.ts:119` `error: ev.error ? { code: String(ev.error['code'] ?? ''), message: String(...) } : undefined`，而契约（`contracts/tool.ts:22`）声明为 optional | 全仓其它地方用 `...(x ? { y } : {})` 省略；此处实体化 `''`，使按 `!== undefined` 判定的消费者走错分支 |
| L-24 | 一个 `before-quit` 监听在另一处，顺序靠**注册顺序**而非显式排序 | `main/index.ts:389` `app.on('before-quit', () => toolSvc.shutdown())` 与 `:461` 的 `createShutdownHandler` | 顺序**当前正确**（Node 按注册序调用，`:389` 先于 `:461`，正是期望顺序），但无任何机制保证。建议在 `:389` 加注释，或把 `toolSvc.shutdown()` 折进 `steps` 数组成为显式第一步 |
| L-25 | `toolSvc.shutdown()` 清了 `timers` 但没清 `captureTimers` | `tool-service.ts:269-270` vs `:98` 声明的 map（TTL 120s）；且 `:173,183,194,247` 的 `void wireSend(...)` 会与随后 `adapter.disconnect()` 关闭 socket 竞态 | 有界（TTL 120s），但属于退出路径的未收口资源 |
| L-26 | `tool-status-sender.send` 吞掉一切失败 | `main/tools/tool-status-sender.ts:21` 裸 `catch { return false }`，无日志无审计 | 系统性失败的状态上报在诊断里不可见 |
| L-27 | `live2d.store.ts:416` 的"恢复默认"在 fetch 失败时静默无操作 | `const list = models.value.length > 0 ? models.value : await api.listLive2dModels().catch(() => [])`，而兄弟路径 `init()` 会记录 error | 行为不一致 |
| L-28 | 集成套件泄漏临时 userData 目录且无回收 | 本机实测 `%TEMP%\cy-int-ud-*` 累积 **103 个 / 59.65 MB**（最早的 2026-08-22，最新的即本次失败运行）。`closeApp`（`helpers/app.ts:102`）只在**成功**路径删目录；启动失败的 catch（`:93`）只在 `opts.userData === undefined` 时清；`global-setup.ts` 的 `reclaimOrphanTestApps` 只回收**进程**，不管目录 | 反复失败的本地/CI 运行会持续堆积。本轮已清理这 103 个目录（未触及仓库） |
| L-29 | 对话框取消时 `path: r.filePaths[0]` 类型不实 | `main/index.ts:370` 声明 `string`，实为 `undefined`；`tool-executors.ts:26` 的兄弟实现有 `r.canceled || r.filePaths.length === 0` 守卫 | 见 L-19 |
| L-30 | 三处重复的字面量 `3000` | `App.vue:60`、`CyChatInput.vue:116`、`CySettingsView.vue:31`；`main-window.ts:109` 的 `5000` | 全仓约 45 个命名超时/限额常量，工程化程度很高 —— 这 4 个是仅存的裸字面量 |
| L-31 | `safeDialogs` 未设置 | `main-window.ts:73-98` 的 webPreferences 未设该键（默认 `false`） | 仅在"对话框轰炸"成为关切时才有意义；**不是**缺陷，记录以免下次重复推导 |
| L-32 | `Electron` 的 `viewMenu` 一旦为其它目的加入，会带回 `toggleDevTools` | `main/index.ts:73-79` 当前只含 `appMenu`/`editMenu`/`windowMenu` | 记录为前向风险：这是该面最经典的回归方式 |
| L-33 | `resolveTrustedDevOrigins` 的 allowlist 无法**收窄**回环 | `trusted-renderer-origin.ts:41-42` 注释明说"回环 hostname 恒放行任意端口" | 与 L-07 同题，记录供未来多窗口设计参考 |

---

## 7. Architecture Issues

### 7.1 收口点不是策略点（根本问题）

`registerHandler`（`ipc/registry.ts:31-45`）是**来源 + arity** 收口；`createIpcHandler`（`ipc/executor.ts:25-88`）是**形状 + 错误归一**收口。所有"应全局成立"的策略都必须逐通道重写。三个实例：

- 大小上限：`MAX_IPC_MESSAGE_BYTES` 只在 `session-store.ts:235` 一条通道执行（M-03）。
- 路径围栏：`PATH_BLACKLIST_DEFAULTS` 只在工具域两条链上执行，附件链完全没有（H-01）。
- 能力适当性：无人检查"这个通道该不该有这个能力"（H-01、M-28 同属此类）。

**建议**：把"预算/围栏/能力"做成收口点的**默认值**而非**可选项** —— 例如给 `registerHandler` 加 `maxBytes` 默认 `MAX_IPC_MESSAGE_BYTES`，并加一个"枚举所有已注册通道、断言每个都声明了预算"的测试，使**遗漏变成红灯**而不是无证缺口。

### 7.2 关键不变量只存在于注释里

| 注释声明 | 实际执行 | 后果 |
|---|---|---|
| `contracts/attachments.ts:39` "path 仅 Preload 注入；Renderer 永不构造" | 无任何强制 | H-01 |
| `atomic-write.ts:23` "单实例无并发写者" | `chat-service.ts:92,104,111` 三条 fire-and-forget 写；`session-store` 无写队列 | H-11a |
| `contracts/live2d.ts:15-22` `LIVE2D_PATH_PREFIX` 单一来源 | `CyLive2DPane.vue:24-26` 硬编码副本 | L-22 |
| `character-rest-schemas.ts:5` "四处修改需同步" | 4 份副本，3 份无测试、已硬编码分叉 | M-11 |
| `verify-sensitive.mjs:15` "禁止用通配锚定批量放行" | 无代码校验 anchor 广度 | M-07 / M-34 |
| `verify-artifact.cjs:44` 注释预期 `out/` 里有 `.map` 需同扫 | 实际 `out/` 下 0 个 `.map`（好事），但注释与现实不符 | M-35 |

**建议**：把每条"注释即契约"的不变量转成**一个可失败的测试或一条 schema/类型**。优先级：附件路径、session-store 写序列化、LIVE2D 前缀。

### 7.3 契约镜像（三向手抄 + 无生成器）

`docs/review/2026-08-28-架构债务清单.md` D2 已记录此债务；本轮**量化并发现其恶化**：

- `z.ZodType<T>` 锚点覆盖 **82/199**（事件 0/36、REST wire 1/25）。
- 三份/四份/六份手抄：安全校验器 4 份（M-11）、public error 形状 **6 份**（`contracts/ipc.ts:104` / `ipc/executor.ts:48` / `chat/backend-error-handlers.ts:14` / `preload/desktop-api.ts:674` / `utils/public-error.ts:5` / `character-editor.store.ts:30`）。
- **具体分歧已存在**：`currentRevision` 与 `issues` 走 `invoke`（`executor.ts:48-53` 有）时存在，走 `chat:error` 推送（`backend-error-handlers.ts:14-27` + `PublicErrorShape`）时**丢失** ⇒ 同一错误类型在两条传输上形状不同，`character-editor` 的 CAS 修复提示与逐字段 issues 只在一条路上到达 UI。
- 编译期镜像（`desktop-api.types.ts:221-228`）比的是**方法签名**，而所有分歧字段都是 optional ⇒ 双向仍可互相赋值，镜像检测不到。

**建议**：给镜像命名契约类型的 schema 补 `z.ZodType<T>`；把 public error 的推送形状从 `IpcErrorBody` 用 `Pick<>` 派生；把 `check:contract` 接入 CI 或降级为显式非门禁。

### 7.4 组合根的自引用与 TDZ 惰性绑定

`main/index.ts:250`（`getBuild` 在 `adapter` 自己的初始化表达式里闭包引用 `adapter`）、`:326-328`（`backendIdentity` 闭包引用 `:393` 才声明的 `connConfig`）、`:223-227` 三个 bridge 容器**纯粹**为构造顺序存在、`handlers.ts:39-53` 的 15 字段 deps 由 `index.ts:460` 一个字面量填满。

不是 bug，但阅读顺序必须靠注释维持。**建议**：显式 `late<T>()` holder + 命名清晰的"装配顺序错误"。

### 7.5 扩展成本：新增一个 IPC 方法 = 5 处编辑 + 2 条隐形约定

`channels.ts` 请求 schema → `registerHandler` arity（不匹配只报笼统 `SCHEMA_VALIDATION_FAILED`）→ preload 函数 → preload 导出（`desktop-api.ts:699-809`）→ renderer 镜像（**这一环有编译期保障**，做得好）。隐形约定两条："arity 1 必须恒发 `{}`"（注释在 `desktop-api.ts:570,585`）、硬编码暴露白名单（`ipc-security.spec.ts:39-55`，其历史里有一次 91 键漏项的教训）。

### 7.6 `shared/domain` 混入 renderer 专用 UI 辅助

`shared/domain/index.ts:1-6` 同时导出真正共享的 `clone`/`tool-status`，以及只被 renderer 用的 `isCompositionEnter`（`CyChatInput.vue:6`）、`stickerRenderUrl`（3 个组件）、`isoToLocalDate`（`utils/message-time.ts:2`）、`stream-accumulator`（renderer 专用）。**建议**：拆 barrel + 加一条 import 方向测试。

### 7.7 已验证**健康**的三条既有主张（无需重做）

架构债务清单的三条"healthy"声明经独立核实仍成立：**无跨层 import**（main/preload 不 import renderer，反之亦然）、**`shared/` 是干净契约层**、**`protocol-v2` 解耦**。另外该清单 D5 已**半过时**：`live2d.store` 不再 import layout（可见性由 `CyLive2DPanel` 推入），但仍读 `message.byId/order` 与 `voice.tts.playing`（`live2d.store.ts:126-154,190`）。

---

## 8. Electron / IPC / Security

### 8.1 已验证**良好**的控制（覆盖证据，供下次评审免于重新推导）

1. **preload 暴露面恰好是测试钉死的那些**：93 键，`EXPECTED_SURFACE` 硬编码而非从 `IpcChannels` 派生（`ipc-security.spec.ts:30-31` 解释了为何派生会让断言恒真）；且 `hasIpc === false`、`hasRequire === 'undefined'`、`hasProcess === 'undefined'`（`:57-59`）。该哨兵历史上真的抓到过 91 键漏项。
2. **sender 校验是五条件守卫，不是 origin 检查**：窗口存在且未销毁 → `senderFrame` 非 null → `event.sender === win.webContents` → `event.senderFrame === win.webContents.mainFrame` → frame 当前 URL 受信（`registry.ts:19-23`）。**`senderFrame === mainFrame` 是真正起作用的那条**：子框架即使到同一文件也拿不到桥，所以 `frame-src 'none'` 是纵深而非主控制。`ipcMain.handle`（`:40`）与 `ipcMain.on`（`:62`）都过。隐藏窗口拒绝有集成测试（`:148-160`）。
3. **自定义 scheme 以 `secure`/`standard` 注册，CORS 与 CSP 旁路都为 false**（`scheme.ts:12-22`），且 renderer 内容**从不**用 `file://`（`main-window.ts:149-154` 在 `shouldUseViteDevServer` 为 false 时恒走 `cyrene://renderer/index.html`）。该谓词被协议注册与窗口加载**共用**（`index.ts:478` 与 `main-window.ts:70`），这才是"残留 dev env 无法劫持打包态"成立的原因。
4. **协议路径包含性是两段式，且对目录 index 目标重新施加**：`resolveRendererPath`（解码、拒 NUL、拒任何 `..` 段、`resolve('.')` + `relative` 首段检查 —— `path.ts:9-21`，注释解释了为何 `startsWith('..')` 会误伤 `..hidden`）；随后 `handler.ts:137-142` 用 `realpath` + Windows 大小写归一重验，`:149-155` 对 `index.html` **再验一次**而不是信任父目录的检查。失败模式是 403/404，从无 fallthrough。
5. **媒体字节不能变成文档 —— 两把独立的锁**：`isDocumentRequest`（`Sec-Fetch-Dest: document` → 403）在 `handler.ts:111,125`，加 `navigation.ts:30-31` 对 `__cyrene-media/` 前缀的导航级 deny。代码注释自称"双保险之一"，属实。`frame-src 'none'`（`csp.ts:12`）关掉 iframe 路径。
6. **Live2D 供给只有一份闸门，两条通道共用**：`gateLive2dFile`（`serve-gate.ts:51-72`）按固定顺序做 `verifyIntegrity`（fail-closed，首个命中 await 全量 hash）→ registered/available → `resolveModelFile`（realpath 包含性 + integrity 条目白名单 + 尺寸一致 + `lstat` 普通文件）。`protocol/handler.ts:59` 与 `ipc/live2d-handlers.ts:35` **都**调它 —— 我读了两个调用点确认。
7. **Markdown 消毒是分层的，且门禁是真浏览器**：DOMPurify 3.4.14 显式 `ALLOWED_TAGS`/`ALLOWED_ATTR`（无 `target`、无事件属性、无 `style`）+ lookbehind 安全的 `ALLOWED_URI_REGEXP`（仅 `https?`/`cyrene`/`mailto`）+ `ALLOW_DATA_ATTR: false` + `SANITIZE_DOM: true`；代码块经**插值**渲染而非 `v-html`（`CyCodeBlock.vue:8-9,52`）。安全门禁是真实 Chromium 里的 `markdown-xss.spec.ts`，happy-dom 单测被明确降级为"行为记录而非可信 oracle"（`markdown.ts:5`）。全 renderer grep `v-html`/`innerHTML`/`outerHTML`/`document.write`/`new Function`/`eval(`：只有 `CyMarkdown.vue:56`（已消毒）与 `CyNavRail.vue:73,96`（本地静态图标字符串）。
8. **凭据永不跨桥明文**，且 safeStorage 失败是 fail-closed：`isSafeStorageUsable` 显式拒绝 Linux `basic_text`（`safe-storage.ts:17-21`）→ 结果是 `unavailable` 而非明文降级。renderer 唯一的凭据面是状态枚举（`desktop-api.ts:215-223` 只保留 `status`）。模型 provider 的 API key 同样不回显（`ModelProfileSchema` 无 `apiKey` 字段）。
9. **token–origin 绑定在 connect 时**再次强制，而不只在 set 时：`connection-config.ts:65-72` origin 变化即清 token + binding；`chat-service.ts:44-45` 独立复查 `binding?.origin !== endpoint.origin`。所以即使 Renderer 改了端点，存量 token 也不会被发往新主机（结果为 `CREDENTIAL_UNAVAILABLE`），集成测试断言了绑定清除行为（`:131-142`）。
10. **远程调试在所有构建上都被拒**，不只打包态：`rejectForbiddenDebugSwitches()` 在 `main()` 最前（`index.ts:105`），且纯函数**刻意不接收** `isPackaged`（`debug-switches.ts:68-73` 的 docstring 说明了原因）。裸开关、显式端口、`=0`（除 `CYRENE_TEST_HARNESS=1`）、`--inspect-brk`/`-wait` 变体、`--remote-debugging-fd`/`-pipe`、`NODE_OPTIONS` 通道全覆盖；并诚实注明 `--inspect-brk` 在任何应用 JS（含本门）之前暂停、进程内无法拦截（`:58-59`）。
11. **工具执行没有通用命令入口，且有 13 步决策链**：`TOOL_NAMES` 恰好 4 个（`ipc-security.spec.ts:262` 断言）；`desktop.command.run` 未注册。路径参数先 `normalizeToolPath`（含父链完整 realpath）再 `isPathBlacklisted`（`tool-service.ts:459-470`），**grant 匹配在第 8 步之后**，所以黑名单恒赢（`:493-499`）。写盘是原子的且写前做 hash 冲突检查。
12. **截图是有状态机的、无旁路**：`pickSource` 要求 id 出现在枚举快照里（`:302-303`）；`confirmUpload` 要求先下发过预览（`:324`）；Wayland 在授权前降级而非静默失败（`tool-executors.ts:99`）。
13. **麦克风权限按 origin 与媒体类型双重收窄**：`decideMicrophoneAllow` 要求 `permission === 'media'`，在单数 `mediaType` 与复数 `mediaTypes` 两种 Electron 形状下都拒 `video`，并要求受信 renderer URL（`mic-permission.ts:21-26`）。双形状处理是真实的正确性细节，不是仪式（`:5-6` 注释说明两个回调的 detail 类型不同）。
14. **每条 IPC 错误路径都脱敏 + 截断**：`executor.ts:45-78` 把 message 限 500 码点、拒绝 `backendDetails` 过桥、只上提固定白名单字段；校验 `issues` 被过滤为 `/` 开头且拒 `\`、`://`、盘符（`:68`）—— 那是真正的路径泄漏守卫，不是形式。
15. **`before-input-event` 是 F12 门的正确钩子**：无条件注册、按键时求值（`main-window.ts:129-133`），这是 7A MED-1 修复的记录（创建时一次性求值会让打包态永不注册 F12）。
16. **无 `globalShortcut`、无 `webviewTag`** ⇒ 不必有 `will-attach-webview`。这一点值得明说，因为若 `webviewTag` 被开启，缺少该 handler **就会**是问题。

### 8.2 Electron 设计判断

`BrowserWindow` 配置经逐项核对**正确**：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`（显式）、`allowRunningInsecureContent`/`experimentalFeatures`/`webviewTag`/`nodeIntegrationInWorker`/`nodeIntegrationInSubFrames` 均走默认（安全）。两个刻意的偏离各有文档理由：`devTools: true`（D7A-04，唯一开启路径是设置页开关 + F12 门，且 devMode 是会话态闭包变量、不落 `settings.json`）与 `backgroundThrottling: false`（CI xvfb 遮挡判定 + 生产流式/语音实时性，`:91-95` 有完整理由；代价见 M-37）。

Fuses 三项（`runAsNode`/`NODE_OPTIONS`/CLI inspect）经**完整 9 位 wire 读回**确认已 DISABLE，并与基线 `electron.exe` 对比证明 electron-builder 恰好翻了 yml 里写的那三位。`OnlyLoadAppFromAsar` 与 `EmbeddedAsarIntegrityValidation` 保持 DISABLE（与 `asar: false` 一致，阶段 8 决策已覆盖）—— 但请注意 `asar: false` 意味着特权 Main 包是**磁盘上可直接改写的明文**，且 `verify-artifact.cjs` 从不校验 `resources/app/**`。这是 H-01 之外**唯一**能让本地攻击者拿到完整 Main 权限面的路径。

### 8.3 安全分级的现实性

按任务要求区分三类，避免把低概率理论风险说成漏洞：

**现实可利用（需 Renderer 先被攻陷）**：H-01（任意文件读 + 外传）、M-28（反取证清日志）、M-03（无累积上限的 `voice:audio-chunk`）。前提是 XSS 类入口 —— 当前仓库**没有已知可达入口**（见 §3），所以这些是"已断掉但本不该存在的能力"与"纵深缺口"，不是"今天就能打穿"。

**纵深缺口（当前不可达，屏障距一次重构之遥）**：M-17（read-model-file 无大小上限）、M-04/L-06（三处 `openExternal` 严格度不一）、L-04（preload 路径无运行时断言）、L-07/L-08/L-33（多窗口相关，今日单窗口不可达）、L-10（自述 size 与真实 stat 无交叉校验）、L-03（`Sec-Fetch-Dest` 单点依赖）。

**理论**：L-20（`.default()` 编造 wire 值 —— 需要后端先改契约）、M-07（scanner 盲区 —— 需要有人往被排除目录里粘密钥）。

**已证伪，不得作为结论**（详见 §14）：`setWindowOpenHandler` 前缀测试可被 `http:evil` 绕过（URL scheme 文法上不成立）；`getLastCrash()` 恒返回 `null`（集成测试实测 banner 出现、marker 被一次性消费）。

---

## 9. Frontend / State / UI

### 9.1 状态管理

**做得好的**（已核实）：`session.ts` 解环成立（零 store import，`conversation.store.ts:173-179` 以 `immediate + flush:'sync'` 单向写入；`items` 镜像因每次都是整数组重赋值而浅 watch 足够）；`store-graph.spec.ts` 虽只匹配 `from './x.store'`，但 renderer 下**确实没有** util/live2d/voice/layout 模块 import store，故无隐藏传递环；localStorage 读取全部做了校验（`layout-storage.ts:26-46` 逐字段类型 + 版本 + 钳位 + try/catch；`recent-emoji.ts:13-23` 检查 `Array.isArray` 并过滤非字符串）；6 个 `<form>` 全部 `@submit.prevent`；**唯一**需要拆响应式代理过 IPC 的地方（`model-service.store.ts:85-97`）已经处理（这正是 `DataCloneError` 事故的修复点）。

**主要问题**：见 H-04（防抖不 flush）、H-06/H-07（角色域状态两次缓存、键空间不兼容）、M-12（7 种请求栅栏方言）、M-13（3 种连接身份定义）、M-15（助手内容权威在 renderer）、M-16（store 职责）、M-19（`saveError` 死状态）、M-21（重算派生状态的重复副本 —— `hasMoreBefore`/`beforeCursor`/`nextCursor` 三个 ref 表达同一事实，由两条分叉的 loader 维护）。

### 9.2 UI / UX / 可访问性

按 UI 走查记录先读后评：**problems 1–11 除一项外均已在代码中修复**（`overflow-anchor:none` + 高度批处理、延迟渲染空 pill 已移除、Emoji 按钮归位输入框内、装饰点与品牌字样移除、`阶段 N` 标签移除、折叠开关与设置栏位置）。**仍开放**：`App.vue:87` 的「任务中心 · 阶段 6 落地」占位（走查文档已记为待 TSA-01 决策），本轮**不重复计入新发现**。

新发现按用户代价排序：H-02（不能复制 + 不跟随底部）、M-20（`--cy-accent` 当文本色，含安全授权按钮）、M-21（全屏 modal 零焦点管理）、M-22（按住说话键盘不可操作）、M-23（不可达断点 + 死常量）、M-24（无 reduced-motion，自有开关只管 Live2D）、M-25/M-26（VRAM 与录音堆滞留）、M-19（设置保存失败不可见）。

**无文字缩放的完整链条**（值得单独说明）：打包态 `Menu.setApplicationMenu(null)`（`main/index.ts:77`，`:145` 在 `!devToolsAllowed` 时调用，而 `env.ts:27` `devToolsAllowed = !isPackaged`）⇒ 没有 zoomIn/zoomOut/resetZoom role；`setZoomFactor|setZoomLevel|webFrame` 全仓 **0 命中**；`--cy-user-font-scale`（`tokens.css:11`）全仓**只被引用一次**（`:149`）且**无任何赋值者**；即便赋值，314 处显式 `font-size` 都是绝对 px（0 处应用该 scale）。低视力用户在**打包后**才会发现完全无杠杆 —— 开发态保留 Electron 默认菜单，所以这个回归在开发期不可见。doc 11 §7.2 与 doc 03 §12.4 规定的整个"外观"分区（字体缩放/代码字体/强调色/主题/恢复默认）均未实现，而导航项名字却叫「外观与 Live2D」。

**设计 token 合规实测**：57 个 SFC 中 48 个零颜色字面量；hex 5 处/4 文件，rgb(a) 8 处/6 文件，几何 px 38 处/28 文件（`tokens.css:79-82` 明文把这 15/20/22/26/28/30/40/41px 间距、4/5/11/13/16px 圆角标注为**有意不 token 化** ⇒ 是已记录缺口而非漂移）。**关键**：`token-contract.spec.ts` **抓不到其中任何一项** —— 它只断言 ① 每个 `var(--cy-*)` 能解析 ② 组件不得定义 `--cy-*` ③ 不得带 fallback。一个把所有颜色硬编码、只引用一个合法 token 的文件能通过全部五项测试。这正是 M-20（15 处误用 `--cy-accent`）能长期存活的机制原因：契约查的是**引用**，不是**用法**。

**规格漂移清单**（doc → 代码，逐条核对）：doc 03 §7.5 消息操作（复制/重发/重新生成/停止/播放）❌ 全缺 · §7.4 表格横向滚动 ❌ 被裁切（`CyMarkdown.vue:139-147` + `CyMessageList.vue:415` `overflow-x: hidden`）· §5.1 会话右键菜单 ❌ · §5.2 加载更多/失败重试 ❌ · §5.3 骨架屏 + 创建引导 ❌（`CyMessageList.vue:373` 「新会话,开始对话」还用了半角逗号，且用户只是"没有会话"时显示的是「该会话离线不可读或为空」）；§8.3 拖入聊天区 ❌ 落区只有输入条，且无无效拖放态；§10 截图需显示所选的屏/窗并在上传前重新警告 ⚠️ 预览只显示图，按钮是「确认上传」；§12.3 发送快捷键/自动滚动 ❌ 0 命中；§12.4 + doc 11 §7.2 外观设置 ❌ 整块缺失；doc 11 §3.3 VAD/静音结束/语言 ❌；doc 11 §9 同步状态 ❌（M-19）；doc 03 §15「1100×700 下四区正常」❌ 与算术矛盾（60+260+500+300 = 1120 > 1100 ⇒ 见下）；doc 03 §3.1 + 整改清单 §2 四档断点 ❌ 仅文档；整改清单 §3 `scrollbar-gutter` 4 容器 → 仅 1 处（`CyMessageList.vue:415`，另 `CyProfileWizard.vue:257`）；整改清单 §5 reduceMotion 覆盖 UI 动画 ❌；整改清单 §7 可选中文本 ❌（`tokens.css:151`）。✅ 已实现：§7.4 代码块语言/复制/横滚、§11「角色状态不能替代文字状态」（文字存在，但**不被播报** —— M-21/U-13 同类）、§14 大部分。

**异步状态覆盖矩阵**（摘要，全表在原始评审记录里）：最弱的是**聊天气泡区**（无首屏 loading 态、`lastError` 只在输入条渲染而列表旁没有、loading 态显示的是"空"文案）、**安全面板**（`catch { grants.value = [] }` 使 IPC 失败与"无授权"不可区分 —— `CySecurityPane.vue:44,47`）、**诊断导出**（只有 disabled，标签不变）、**工具卡审批按钮**（无 disabled、无 in-flight 标记，`CyToolCard.vue:198-202`）。整体：仓库有 24/30 个按钮做对了守卫，因此这是**不一致**而非缺少约定。进度条：全 renderer **0 个** `<progress>` / `role="progressbar"`。

---

## 10. Performance

按"用户是否真能感知"排序，已排除无收益的微优化：

| 排名 | 问题 | 量级 |
|---|---|---|
| 1 | **H-03 流式不流式** | token 速率 >12.5/s 时中间态**完全**不渲染；无测试覆盖 |
| 2 | **H-09 同步 diff 冻结整个应用** | 数百 KB～数 MB `content` 即可让主进程失去响应，且所有超时（定时器驱动）**都无法触发** |
| 3 | **H-08 O(N) 重算 + 全文扫描 + 数组不封顶** | 5000 条会话下每次高度提交数 MB 字符串分配；门禁规模（200 条）结构上覆盖不到 |
| 4 | **M-35 + M-36 1.73 MB 未压缩单 chunk + 228 KB Core 在首绘路径上** | 首次绘制前约 1.96 MB JS 解析/编译（本机实测 chunk ≈23ms、Core ≈10ms）；Live2D 在启动时无条件初始化（`CyLive2DPanel.vue:342`），即使用户关闭了它或没装模型 |
| 5 | **M-25 / M-26 两个最重子系统的无界缓存** | Live2D 每次加载滞留约 33 MB VRAM 至 GC；10 分钟录音滞留约 38 MB 并在停止瞬间瞬时约 115 MB |
| 6 | **M-27 渲染路径上的必然异常 + 深克隆** | 每次列表重渲染约 1ms（帧预算 6–12%）+ 约 1MB/s 短命垃圾；`structuredClone` 20000/20000 次必抛 |
| 7 | **M-37 最小化时全速渲染** | `auto` 约 60fps、`quality` 无上限（真机记录约 240Hz）持续 GPU/CPU 唤醒 |
| 8 | **M-38 约 16 MB 死重进包** | 安装体积与可改写文件面 |

**已核实**良好、**不要**去"优化"的：**流式 delta 是就地嵌套变更**（`message.store.ts:426`），`byId`/`order` 不逐 token 重建，因此 `items` 不失效、**整个列表不逐 token 重渲染** —— 一个 wire delta 一次 IPC 在真实 token 率下是 µs 级，**不要批处理**（合并只会加延迟）；累加器用 rope 追加 + 引用赋值（`stream-accumulator.ts:157,165`），无 O(n²) 字符串构建；虚拟列表是真二分窗口 + 实测高度前缀和；TTS 音频在 Main 侧**确实**按 `stream_id` 分块批处理（`real-backend.ts:735-741`）；`assetsInlineLimit: 0` 的理由**仍然成立且当前零代价**（worklet 产物 2087 B 低于 Vite 4KB 内联阈值，内联会变 `data:` URL 被 `script-src 'self'` 拦掉）；Live2D 完整性哈希**不是**主线程隐患（`manifest.ts:18-21` 用 `createReadStream` 流式 + `:56-62` 顺序 await + `model-registry.ts:231-234` 按模型记忆化），`listInstalledModels` 只做 `lstat` + 尺寸比较。

---

## 11. Reliability

按"正常使用中会不会咬人"排序：

1. **H-10 流式生命周期没有客户端出口** —— 无 watchdog、取消在 await 之后且不定向、切会话不取消。
2. **H-04 刚敲的字静默消失** —— 800ms 防抖 + 任何地方都没有退出 flush + `catch { return undefined }` 抹掉重试。
3. **H-11b 持久化可以毁数据并上报成功** —— 隔离改名失败被吞 + 无条件空态重建 + 覆写；`schemaVersion` 写了从不读。
4. **H-11c 已成功的写入被报失败并诱导重复提交** —— 任何重连都会作废在途 REST 响应，行为还被自己的测试锁死。
5. **H-12 Main 无 unhandled-rejection 兜底** + 一个无守卫 push 点。
6. **H-11a 并发写丢一次写**（已下调 Medium）—— 固定 `.tmp` 名 + `SessionStore` 无写序列化。
7. **M-18 下载无超时** ⇒ 永久转圈、无占位、无原因、无重试。
8. **M-19 / L-14 / M-01 失败以"什么都没有"或"噪音"的形式到达用户** —— 设置保存失败不可见且被丢弃；附件失败显示内部码（`precheck`/`upload_failed`）且标签错写成「校验失败」；renderer JS 错误完全不在诊断包里。
9. **M-30 没有任何东西把 `IpcChannels` ↔ 已注册 handler ↔ preload 面对齐** ⇒ 整个功能可以永久坏掉而所有门禁全绿。
10. **M-31 审计腿只在 mapper 级 + 一次子串（同时匹配成功与失败）**。

**超时清单**（摘要）：有超时的 12 项（WS 握手 10s、REST 10s、send+ack 15s、voice.commit ack 15s、switch_model 10s、set_tts_voice 10s、附件上传 60s、工具附件上传/读取 60s、退出 flush 1.5s、工具执行/截图驻留 120s、语音 45s/5s/600s）。**无超时**的关键项：附件媒体代理下载、贴图代理、`checkStatus` 探测、**`generation.completed`/`failed`**（无任何键在 generation 上的定时器）、TTS `audio_end`（缓冲区也无字节上限）、**IPC invoke 两端都没有**、请求路径上的本地文件读取。

**取消清单**：可取消 —— 文本生成（部分，不定向且慢）、附件上传（真）、语音采集（本地 teardown）、TTS 播放。**不可取消** —— 切会话后的后端生成、媒体代理下载、重连期间的 REST、重连时在途的 WS 发送。

**竞态矩阵**：Main 侧连接/传输栅栏**做得很扎实**（socket 对象 + 单调 `transportIncarnation` 双栅栏，每个 pending 家族各自的 timer 身份，无交叉清除、无第二 socket）；显式 connect 是硬 source 边界（轮换 source 世代 + 退休并关闭旧 socket + 拒绝四个 pending 家族 + abort 所有活动 REST controller）。弱项：renderer 连接 store 无 epoch（`connection.store.ts:29` 用无世代判定的方式写 error 态，只靠组件局部 `busy` 缓解）、**允许在 `activeGenerationId` 非空时再次 send**（`message.store.ts:660-724` 的 `send()` 不检查，`CyChatInput.vue:159-164` 的 `canSend` 也不含 ⇒ 发一条就会把前一条冻成 `interrupted` 且其后端生成永不取消）、`CyToolApproval.vue:72` 的 Escape 绕过 `:22` 的 `submitting` 守卫（服务端单向终态兜底）。

**R-09 关于本机集成测试全红的定性（已实测反证）**：`pnpm test:integration` 本机 22 文件全红（81 failed/12 passed/47 skipped），报错统一为 `electron.launch: Process failed to launch!`（exitCode=1，debugger 连上后立即 1006 断开）。**我反证了这不是产品缺陷**：用完全相同的参数（`--inspect=0 --remote-debugging-port=0 apps/desktop`）与 `CYRENE_TEST_HARNESS=1` + `CYRENE_TEST_APP_DATA=<temp>` 直接启动 `electron.exe`，应用**正常运行**（12 秒后仍在跑，被我用 Stop-Process 结束）。且 `debug-switches.ts` 的 harness 放行逻辑正确（`index.ts:90` `allowRandomPort = CYRENE_TEST_HARNESS === '1'`，`helpers/app.ts:73` 设了它）。因此这是**本机 Playwright ↔ Electron 43 握手/附加问题**（或 CI 与本机环境差异），与 HEAD 上"CI 全绿"不矛盾。**未解决**：未能定位本机根因；建议在有 CI 的机器上复跑确认，本报告不据此判定集成门禁失效。

---

## 12. Testing

**总评**：测试量（214 单测文件 / 2682 用例 + 约 23 集成文件）与**行为断言质量**都属上乘 —— 核心链路测的是行为而非形状（`message.store.spec.ts` 888 行 68 例覆盖 replay/REST 双向去重、跨世代丢弃、乐观发送→ack 迁移、取消/中断交错；`stream-accumulator.spec.ts` 覆盖乱序增量缺口缓冲、`segment.completed` vs `generation.completed`、权威 `completed.content` 覆盖 delta；`electron-tools.spec.ts` 在真实 Electron 里用真实点击覆盖拒绝/允许/取消/写冲突/目录授权/黑名单/身份不匹配）。而且**做过红绿变异验证**（`DataCloneError` 事故的回归测试是靠回退修复确认会红）。

**关键路径覆盖矩阵**（9 个领域）：

| # | 领域 | 状态 |
|---|---|---|
| 1 | 流式/消息组装、replay 与重连去重 | **已覆盖**（含真实 `WebSocketServer`） |
| 2 | 工具：授权/拒绝/超时/取消/冲突/**审计** | 6 条中 **5 条已覆盖；审计仅部分**（M-31） |
| 3 | 凭据存储与生命周期 | **部分** —— 白名单/版本/损坏/关闭排空/降级路径都覆盖了，**真实加解密往返未覆盖**（M-32） |
| 4 | IPC 信任边界 | **已覆盖且是对抗式的**（硬编码 93 键哨兵、超长串、4.5 MiB、类型混淆、未知通道、第二窗口非受信 sender、穿越哨兵）。缺口：channel↔handler 完整性（M-30） |
| 5 | 持久化损坏/迁移 | **已覆盖**（真的写坏 JSON 到磁盘：截断、非法 JSON、版本不符） |
| 6 | 多角色运行时 | **已覆盖已发货的那个崩溃；更新的面较薄** —— 无任何测试驱动**两个角色并发**通过事件管道，真机端到端复验仍待执行 |
| 7 | Live2D 集成 | **已覆盖（仅生产形态）** —— 30 用例含穿越、损坏模型、上下文丢失、竞态；dev 形态未覆盖（M-29）；单元 adapter **13+7 处 `vi.mock`** 把整个 framework 替掉（断言的是 stub），且唯一跑真 framework 的 spec 里 `lil` 分支被**机器本地**路径门控（`electron-live2d.spec.ts:32` 指向被 gitignore 的 `tmp/live2d/修女莉尔免费版`）—— `if (lilInstalled) { … }` 是**恒真通过的真空体**，vitest 报 passed 而非 skipped。Haru/Wanko 来自受版本控制路径，这些分支在 CI 里**确实**跑 |
| 8 | 窗口/生命周期/退出 | **已覆盖**（真实 `forcefullyCrashRenderer()` + 审计文件读取；shutdown flush/超时/顺序/双 quit） |
| 9 | 可访问性与键盘 | **未系统覆盖** —— 107 处 aria/role/focus 匹配里只有 1 处焦点断言（`cy-tool-approval.spec.ts:43`）与 1 处焦点陷阱测试（`cy-profile-wizard.spec.ts:59-77`）；无 axe/role 扫描，权限审批窗与设置 overlay 无焦点陷阱测试 |

**过度 mock**：Live2D adapter（见上）；`safeStorage`（M-32）；40 个组件 spec 手搓 `setDesktopApi({...} as never)`（39 个走无校验 cast）—— 这个 cast 抹掉了唯一能发现"mock 与 `DesktopApiLike` 漂移"的机制，preload 面在一个阶段内从 74 键涨到 93 键，重命名/移除方法会让 16+ 个 mock 静默提供一个已不存在的方法。**建议**：`tests/unit/helpers/desktop-api.ts` 导出 `createDesktopApiMock(overrides?: Partial<DesktopApiLike>)`，并用 `Partial<DesktopApiLike>` 保型而非 `as never`。

**"不会失败的测试"**：项目**已**做过测试陈旧性审查（`docs/review/2026-09-10-前端测试陈旧性审查.md`），本轮核实其结论仍成立，并**新增两处**未覆盖的：（a）上面 `lil` 的恒真 via-pass 分支；（b）`debounce-trailing.spec.ts:11-13` 把**错误语义**（防抖而非节流）钉成了正确行为 —— 这是"测试保护了 bug"的典型，H-03 因此长期未被发现。

**Flakiness**：固定时长 sleep 仍在（`electron-live2d.spec.ts:372-376` 在 600/800ms 墙上时钟窗口上断言 rAF 差**恰好为 0**；`electron-voice.spec.ts:182,207` 的 2000/800ms；`perf-gate.spec.ts:217,233,261,326,379` 的 150/300ms），POLL 预算逐文件不同（5000/8000/15000）。项目文档已记录机制（SwiftShader 饱和下 15s 只完成 4 次 `evaluate`，即约 3.75s/次），因此 6000ms 预算距饥饿线不足 2×。**建议**：rAF 停止改为应用侧信号（断言 store 的 `live2dShown=false` + 用同一次 evaluate 重置的注入计数器证明"自折叠以来无新帧"），并把 `electron-live2d` 默认 POLL 提到与 `SLOW_POLL` 一致。

---

## 13. Build / Tooling

### 13.1 已证伪：任务书假设的 `files:`/externalized 依赖断裂**不存在**

任务书提示"关注可能导致 dev 能跑但 production 出错"。我把它当最高优先假设做了实测，结论是**该断裂不存在**：

- `out/main/index.js` 确实只 `require("diff")`/`require("ws")`/`require("zod")`（`externalizeDepsPlugin` 生效），`electron-builder.yml` 的 `files:` 确实只列 `out/**` + `package.json`。
- 但 electron-builder **自动复制生产依赖闭包**（打包日志 `• searching for node modules  pm=pnpm`；`• duplicate dependency references dependencies=[...]`）。
- 打包产物实测：`dist/win-unpacked/resources/app/{package.json,out/**,node_modules/**}`，`zod`/`ws`/`diff` **均可从产物内部 resolve**。所以主进程不会因缺模块而启动失败。

**结论：不要为此做改动。** 真正的产物问题是 M-38（约 16 MB 死重）与 M-39（Windows 打包路径从未在 CI 验证），而非启动失败。

### 13.2 其余构建/工具链问题

见 M-35 ~ M-40、L-01、L-02、L-04。要点归纳：

- **生产 bundle 未压缩**（M-35，实测 1.73MB/44,728 行 renderer + 585KB main + 217KB preload），但**sourcemap 实测为 0 个** `.map`（好事，且与 `verify-artifact.cjs:44` 注释的预期不符 —— 见 §7.2）。
- **无 chunk 分割**（M-36）：`import('` 在 renderer 下只命中类型位置，与 `CLAUDE.md` 的"Live2D 必须能降级"在 bundle 层面矛盾。
- **CI 覆盖缺口**（M-40 / M-29 / L-02）：`artifact` job 本身**很强**（真实打包 → 写 fuse → **读回** → 冷启 smoke → 严格 CSP（响应头 + console 双验）→ 纯浏览器信任边界 → 调试门禁负路径），缺的是 Windows 打包（M-39）、dev 形态（M-29）、`check:contract`（L-02）。
- **`check:contract` 的"假通过"缺陷对"后端未挂载"已真修**（本机实测 exit 2 + 明确的 NOT VERIFIED 文案）；残留是 M-40/L-02 的两条"部分验证仍 exit 0"路径。
- **`@types/marked` 是可移除的弃用 stub**（L-01，唯一一个；其余 14 个依赖经测试/脚本/配置核实均有真实使用点，无声明-安装漂移）。
- **repo 卫生良好**：1124 个受控文件、**0 个未跟踪且未忽略的文件**、`out/`/`dist/`/`tmp/` 均无受控内容、`ref/` 与 `third_party/` 是有意且已记录的。

---

## 14. Technical Debt

### 14.1 既有债务清单的复核结论

`docs/review/2026-08-28-架构债务清单.md` 的 D1–D7 **全部仍准确**，且 **D1/D2/D3 比记录时更糟**：

- D1（`RealBackend` 上帝类）：1292 → **1859 行**，并**吸收了整个角色 REST 域**（H-06）。
- D2（三向契约镜像、无生成器）：校验器副本从"三处"变为**四处**（M-11）；`z.ZodType<T>` 覆盖率**量化后仅 82/199**（H-05）。
- D3（Mock/Real 双实现）：新增第三种角色后端实现，且 Mock 与 Real 的**结构分叉**（H-06）。
- D4（`createToolService` 闭包 + `tool-service ↔ tool-executors` 值导入环）：**未缓解，且已付出代价** —— 逼出了 Wayland 检测的重复实现，而重复那份的 env 默认值无测试（M-14）。
- 三条"healthy"主张经独立核实仍成立（§7.7）。
- 该清单**遗漏**的：整个 Stage-H 架构（H-06/H-07 + mock 结构分叉）、角色 REST 的契约门禁空洞（H-05）、Main 侧无环门禁（M-14）、连接身份碎片化（M-13）、请求栅栏重复（M-12）、preload 双重校验不对称（M-05）、组合根自引用（§7.4）。
- 它预期我会报的 `cloneValue` 重复**已经修好了**（`shared/domain/clone.ts:1-33`，6 个 store 全部 import 它）—— 本轮**不重复上报**。

### 14.2 本轮新增的债务主题

1. **"门禁测形状与来源，不测权威与行为"**（H-01、M-03、M-28 的共同根因）。这是最值得投入的结构性债务：它让一批问题能同时通过 typecheck + lint + 214 个测试文件 + 5 个 CI job。
2. **"注释即契约"**（§7.2 的六条）。建议逐条转成一个会失败的测试或一条 schema —— 优先 H-01 的附件路径、H-11a 的写序列化、L-22 的 LIVE2D 前缀。
3. **"测试保护了 bug"**（`debounce-trailing.spec.ts:11-13` 把防抖语义钉成正确行为；`electron-live2d.spec.ts` 的 `lil` 恒真分支）。建议把"这条断言在实现坏掉时会红吗"作为评审清单项。
4. **"Render 层无可观测性"**（M-01）。renderer JS 错误不进诊断包，而整个诊断导出机制（原子写、双段 sha256、逐行脱敏、截断标志）做得相当认真 —— 唯独缺了最常出问题的那一侧。
5. **vendor 边界的一致性**（M-09/M-10/L-16）：排除 vendored 树是对的，但替代它的**手写 stub 本身既不 lint 也不完整**（只声明 6/11 子路径），使"被排除的 15k 行"事实上只有部分被类型检查。

---

## 15. Recommended Refactoring Plan

复杂度：**S**（<半个文件级改动）/ **M**（单模块）/ **L**（跨模块）/ **XL**（架构级）。**不给时间估计。**

### P0 — 必须立即处理（安全 / 数据 / crash / 核心功能 / 发布）

| # | Task | Related | Scope | Expected Benefit | Risk | 复杂度 |
|---|---|---|---|---|---|---|
| P0-1 | **封死 `attachments:upload` 的任意文件读取路径** | H-01 | `shared/contracts/attachments.ts`（schema + 注释）、`preload/desktop-api.ts`（descriptor 铸造）、`main/attachments/upload-service.ts`、`main/ipc/channels.ts`、`main/attachments/attachments-handlers.ts`、新增单测（黑名单路径必拒）+ 集成用例 | 恢复 `CLAUDE.md` 明文的进程边界不变量；消除"XSS → 任意文件外传"链条 | **中**：改 preload↔Main 的附件契约，牵动拖拽/粘贴/选择器三条入口与 `attachment.store` 的 descriptor 形状；建议先加黑名单（方案 B，低成本、立即降险）再迁到 Main 签发 handle（方案 A） | **M**（先 B）→ **L**（后 A） |
| P0-2 | **退出时 flush renderer 防抖持久化** | H-04 | `stores/draft.store.ts`、`settings.store.ts`、`layout.store.ts`、`character-editor.store.ts` 加 `flushAll()`；`main/index.ts` 的 `createShutdownHandler.steps` 增加一步；新增 IPC flush 契约 + 单测 | 消除"关窗前刚敲的字静默消失"这一最高频数据丢失路径 | **低-中**：新增一条下行 flush 契约；flush 失败必须 fail-open 且不得拖慢退出（既有 1500ms race 已提供兜底） | **M** |
| P0-3 | **持久化损坏路径改为 fail-closed** | H-11b | `main/persistence/corrupt-isolation.ts`（isolate 失败上抛）、`session-store.ts:111-121,59,79`（显式校验 `schemaVersion`、拒绝覆写）、复用 `CharacterDraftStore.getLastError()` 模式、加 `schemaVersion` 不符的测试 | 消除"隔离失败后空态覆写"与"旧 schema 无痕销毁"两条静默数据销毁路径 | **中**：会引入"持久化降级"这一新运行态，UI 需有承载（可先只记日志 + 拒绝写入，不新增 UI） | **M** |
| P0-4 | **修复流式渲染（真节流 + 最大等待）** | H-03 | `utils/debounce-trailing.ts`、`CyMarkdown.vue`；修正 `debounce-trailing.spec.ts` 中把错误语义钉死的断言 | 让"流式回复"在常态 token 率下真正成立 —— 这是产品核心卖点 | **低**：改动局限在 1 个工具 + 1 个组件；须同步修测试（该测试当前保护的是 bug） | **S** |
| P0-5 | **消息列表跟随底部 + 回复可复制** | H-02 | `CyMessageList.vue`（`atBottom` 派生化 + 增长后贴底）、`tokens.css:151`、`CyMessageBubble.vue`（操作行）、Main `context-menu` handler、perf-gate 增补 | 修复产品最核心交互（发送后看不见）与最高频操作（复制回答） | **中**：动作行落在虚拟列表行内，必须守住既有 DOM 契约并重跑 perf-gate ②/③；`user-select` 放开需确认不破坏既有"界面不可选中"的意图（应只对内容区放开） | **M** |
| P0-6 | **主线安全：补 lifecycle 兜底 + 修 push 守卫** | H-12 | `main/index.ts`（注册 `unhandledRejection`/`uncaughtException` → logger + audit）、`:354` 加 `isDestroyed()`、`persistence-handlers.ts:24` 加 `.catch` | 让 Main 的未捕获异常至少留痕；消除一个静默无效的链接点击 | **低** | **S** |
| P0-7 | **发布阻塞项收口（仓库已登记）** | EXT-01、`asar:false` | `docs/16` §4.1 的 EXT-01；`electron-builder.yml`（评估 `asar: true` 或补 `resources/app/**` 的 SHA-256 清单）+ `verify-artifact.cjs` | 对外分发前的合规与完整性前置 | **高**：`asar` 切换会改动运行时文件布局，牵动 Live2D 模型路径解析与 `__dirname` join；EXT-01 依赖外部授权事实 | **L** |

### P1 — 建议近期处理（架构 / 稳定 / 可维护）

| # | Task | Related | Scope | Expected Benefit | Risk | 复杂度 |
|---|---|---|---|---|---|---|
| P1-1 | **把"预算/围栏"提升为收口点默认值** | M-03、H-01 根因 | `main/ipc/registry.ts`（`maxBytes` 默认值 + 结构化遍历）、各 handler 声明预算、新增"枚举所有已注册通道并断言各自声明预算"的测试 | 让"遗漏"变成红灯而非无证缺口；防止下一批全局不变量重蹈覆辙 | **中**：逐次 invoke 的结构遍历有 O(size) 成本，需对热通道做门控或采用"枚举 + 断言声明"的测试式方案（后者零运行时成本，推荐先做） | **M** |
| P1-2 | **`IpcChannels` ↔ handler ↔ preload 三面对齐测试** | M-30 | 导出 `registry` 的 `registered` 集（测试用）、数据驱动的 preload 方法→channel 表 | 阻止"功能永久坏掉而全门禁绿"这一类 | **低**：只暴露一个内部量供测试（`credential-store.spec.ts:13` 已有先例） | **S** |
| P1-3 | **契约镜像补锚点 + 事件成员补 `.strict()`** | H-05、M-02 | `shared/schemas/ipc-response.ts`、`events.ts`（15 个成员）、`rest-schemas.ts`；`ToolCallRecordSchema` 补 `diff` 并加 `z.ZodType<ToolCallRecord>` | 把"字段级漂移是默认"变成编译期/测试期错误 | **中**：`z.ZodType<T>` 会抹掉 `.shape`（测试里已有 `as unknown as {shape}` 转换需同步）；补 `.strict()` 可能立刻暴露上游 mapper 的多余字段（这正是收益） | **M** |
| P1-4 | **`check:contract` 接入 CI 或显式降级** | L-02、M-40 | 内置契约快照供 CI 使用，或把"部分验证"也改为非零退出码 + 明确 NOT VERIFIED 文案 | 消除"未核对"与"核对通过"在门禁语义上等价 | **低-中**：契约快照需维护机制 | **S** |
| P1-5 | **`SessionStore` 写序列化 + 唯一临时名** | H-11a | `main/persistence/session-store.ts`（复用 `credential-store` 的写队列）、`credentials/atomic-write.ts:28`（`randomUUID` 临时名） | 消除并发丢写；临时名改动零成本 | **低** | **S** |
| P1-6 | **REST 栅栏区分"已完成响应"与"scope 变更"** | H-11c | `main/transport/real-backend.ts:1118-1128` 的判定顺序；同步修改把它锁死的 `real-backend-character.spec.ts:230-246` | 消除"写入成功却被引导重复提交" | **中**：放宽 source 栅栏有安全含义，必须严格限定在同 `sourceGeneration` 内（`:1123` 已覆盖真正的 scope 变更） | **M** |
| P1-7 | **流式生命周期 watchdog + 乐观取消 + 切会话取消** | H-10 | `stores/message.store.ts`（watchdog、取消顺序、切会话取消）、`CyChatInput.vue` 的 `canSend` 加 `activeGenerationId` 判定 | 消除"永久生成中"与"无法取消的后端生成"；顺带修掉"允许并发两条 generation" | **中**：watchdog 窗口须容忍慢首 token（建议 45–60s 且任意事件重置）；`interrupt` 不定向是后端约束，本地只能做乐观态 | **M** |
| P1-8 | **`desktop.file.write` 大小校验前移 + diff 移出主线程** | H-09 | `main/tools/tool-service.ts:430` 之前加 `MAX_WRITE_CONTENT_BYTES` 校验（与既有读取上限同处）；`tool-registry.ts:48` schema 加 `.max()`；可选 utilityProcess | 消除"一个工具请求冻结整个应用" | **低-中**：错误码在授权前暴露（可接受）；worker 方案须处理传输与超时 | **M** |
| P1-9 | **消息列表估算记忆化 + 活跃窗口封顶** | H-08 | `CyMessageList.vue`（估算 `Map` 记忆）、`utils/virtual-window.ts`、`stores/message.store.ts`（窗口上限） | 长会话滚动/流式卡顿；堆增长有界 | **中**：封顶改变回滚与跳转语义，须重定 anchor/highlight 测试与 `≤60 rows` 基线 | **L** |
| P1-10 | **历史性地拆掉角色域的双缓存** | H-07、H-06 | `main/characters/character-service.ts`（revision 感知读 + 按 revision 分键或去缓存）、`character-runtime.store.ts`、`CyCharacterPublicState.vue`（去掉第三份规则副本） | 消除 `follow_latest` 下"角色卡空且不收敛" | **高**：触及多角色域核心（项目最新、最易出问题的域），需真机联调复验 | **L** |
| P1-11 | **类型与 lint 门禁加固** | M-08、M-09、M-10、L-16、L-19 | 两个 tsconfig 打开 `noImplicitAny`；`framework.d.ts` 补齐 5 个子路径并去掉空通配；eslint 启用 `recommendedTypeChecked` + `projectService`；收窄 `**/*.d.ts` 忽略 | 让"类型说 X、代码做 Y"进入门禁；Live2D adapter 从"半检查"变为"全检查" | **中**：type-aware lint 首轮会暴露一批既有问题（建议分批窄范围 disable 并记录）；`noImplicitAny` 首轮错误数未知 | **M** |
| P1-12 | **渲染层可观测性接入诊断导出** | M-01 | `main-window.ts` 订阅 `console-message` 或新增 renderer→Main 错误上报通道；`diagnostics-service` 汇总纳入 | 诊断包首次包含 renderer 侧故障 —— 这是实际最常出问题的一侧 | **低-中**：须过脱敏管道（`sanitize` + `redact`），并防止 renderer 噪声淹没主进程日志（需限速/环形缓冲） | **M** |

### P2 — 后续优化（cleanup / performance / DX）

| # | Task | Related | Scope | Expected Benefit | Risk | 复杂度 |
|---|---|---|---|---|---|---|
| P2-1 | 生产构建开启压缩 | M-35 | `electron.vite.config.ts` 三个 target 加 `build.minify: 'esbuild'`；保留 `--mode development` 供调试 | 约 2.5MB 源码文本不再随包分发；冷启动解析更快 | **低**：main/preload 堆栈失去原名且无 sourcemap ⇒ 保留 `verify:artifact --smoke` 作为压缩后门禁 | **S** |
| P2-2 | 拆分 vendored Live2D chunk + 动态 import | M-36 | `electron.vite.config.ts` 加 `manualChunks`；`live2dcubismcore.min.js` 改为按需加载 | 让"Live2D 可降级"在 bundle 层面成立；未启用者不付代价 | **中**：chunk 边界可能扰动 ambient 类型/别名安排；core 延迟加载会与 framework 的模块求值读全局竞争 | **M** |
| P2-3 | 依赖归类修正 | M-38 | `package.json` 把 `vue`/`pinia`/`marked`/`dompurify` 移到 `devDependencies`；加一个"main/preload 可达模块不得解析到 devDependency"的守卫测试 | 约 16MB 重复且可改写的文件不再进包；`dependencies` 重新表达运行时契约 | **中**：未来若 main 侧用到被移动的包，**只在打包态**坏掉 —— 守卫测试是让这个改动安全的前提 | **M** |
| P2-4 | Windows 打包路径进 CI | M-39 | `ci.yml` 的 `windows` job 加 `package` + 静态 `verify:artifact`；`@electron/fuses` 步骤对 ENOENT 重试一次 | 主目标平台的打包与产物校验获得保障 | **低-中**：Windows CI +3~5 分钟且该 job 当前无 Electron 缓存（应一并加） | **S** |
| P2-5 | dev 形态集成测试 | M-29 | 新增 `launchAppDev` 模式（起 Vite server 并传 `ELECTRON_RENDERER_URL`），断言模型字节 + CSP 响应头 + `@fs` 导航拒绝；独立 CI job | 覆盖"只在 dev 可达"的整类回归（此类已真实产生过一次用户可见故障） | **中**：第二启动模式、端口分配、CI 时长；须独立 job 以免拖慢快路径 | **M** |
| P2-6 | 集成测试 fixture 跨平台化 + 临时目录回收 | M-33、L-28 | `electron-tools.spec.ts:19` 改 `mkdtempSync(join(tmpdir(), ...))`；`closeApp`/`global-setup` 增加 userData 目录回收 | 让 Windows 路径语义真正被测；不再累积临时目录（本机实测曾累积 103 个/59.65MB） | **低** | **S** |
| P2-7 | 可访问性修复批 | M-20、M-21、M-22、M-24、M-23 | token 误用 15 处；`CyVoiceConsentDialog` 补焦点管理（直接复用 `CyToolApproval` 模式）；按住说话加键盘路径；`prefers-reduced-motion` + 自有开关门控 CSS 动画；清理不可达断点与死常量 | 修复安全授权按钮不可读、全屏 modal 键盘不可用等真实用户代价 | **低-中**：token 替换会略微改变 hover 品牌色（建议用 `--cy-accent-strong`，它已是 focus ring 颜色，配色仍自洽） | **M** |
| P2-8 | 死代码与死导出清理 | L-17、L-01、L-05、L-22 | 删除 39 个无引用导出、`@types/marked`、`handleRendererGone` 的 `marker` 字段、`CyLive2DPane.vue:24-26` 的硬编码前缀 | 缩小暴露面计数、消除会诱使选错名字的假兼容层 | **低**：`main/ipc/channels.ts` 的 8 个别名注释称"引用兼容"，删除前逐一确认 | **S** |
| P2-9 | 子进程/资源收口 | M-25、M-26、M-37、L-25 | Live2D 纹理 `deleteTexture`；录音改预分配可增长 `Int16Array`；Live2D 加窗口状态门；`toolSvc.shutdown` 清 `captureTimers` | VRAM 与堆滞留有界；最小化不再持续 GPU 唤醒 | **中**：录音改动触及音频热路径与 `onStop(AudioBuffer)` 契约；窗口状态门需 Main→renderer 推送 | **M** |
| P2-10 | 测试卫生 | M-34、M-31、M-32、I-06、`tests` flakiness | secret scanner 端到端测试 + allowlist anchor 广度校验；审计断言改解析 JSONL 断言 `type`+`status`；CI 加一个带 keyring 的 job 或至少记录走了哪个分支；`createDesktopApiMock` helper；rAF 停止改应用侧信号 | 让几个"绿但不会红"的门禁恢复判别力 | **低-中**：keyring job 增加 CI 复杂度；helper 迁移约 40 个文件 | **M** |
| P2-11 | 架构收口（长期） | H-06、M-11~M-16、§7.4、§7.5、§7.6 | 抽 `RealCharacterRestClient`/`RealWsTransport`；单一 IPC/错误契约来源；operation-scope fencing helper；Task 中心/组合根显式 `late<T>()`；`shared/domain` 拆 barrel + import 方向测试 | 降低多角色域与契约层的长期变更成本 | **高**：XL 级，建议按域分批并各自保留门禁 | **XL** |

---

## 16. 总体评价

> 评分基于本轮实际代码证据与验证结果，未为"显得严格"而下压。

**Architecture: 6.5/10**
分层方向真实成立（无跨层 import，renderer 图 0 环，`shared` 是干净契约层，`desktop-api.types.ts` 的编译期镜像设计优秀）。扣分在：收口点是路由点而非策略点（§7.1）、关键不变量只活在注释里（§7.2）、契约镜像覆盖率 82/199 且无生成器（§7.3）、`RealBackend` 1859 行双端口且 Mock 结构分叉（H-06）、角色域状态两次缓存且键空间不兼容（H-07）、新增一个 IPC 方法要改 5 处且含 2 条隐形约定（§7.5）。**这是"骨架正确但接缝未加固"的架构。**

**Code Quality: 8/10**
首方代码零 `any`、零 `@ts-ignore`、零 `eslint-disable`、零 TODO/FIXME，零死模块，390 余处 zod schema 中 `.passthrough()`/`z.any()`/`.catch(fallback)` 全为 0，命名诚实（无"get 却写"、无"is 却返回非布尔"），IPC 错误信封真正统一（单一构造点）。扣分在：318 处 `as` 断言无类型感知 lint 约束（M-10）、`noImplicitAny` 被 preset 关掉（M-08）、~39 个死导出（L-17）、同文件内两份相同的 `matchesCharacterQuery`（L-18）、三处 `as never` 抹掉检查（L-13）、7 处未守卫的 errno 访问（L-15）。**手工质量高，门禁对"类型谎言"无感。**

**Electron Design: 8.5/10**
这是本仓库最强的一环，且经得起逐项核对：`sandbox`/`contextIsolation`/`nodeIntegration`/`webSecurity` 全部正确；`senderFrame === mainFrame` 五条件校验挡住了子框架；自定义 scheme `secure`+`standard` 且 CORS/CSP 旁路皆 false；协议路径两段式包含性并对 index 目标重验；remote-debug 在所有构建上 fail-closed 且纯函数刻意不吃 `isPackaged`；fuses 三项经过 9 位 wire 读回验证；Live2D 两条供给通道共用同一闸门（我读了两个调用点）。扣分在：`asar:false` + 两个 asar 完整性 fuse DISABLE 使特权包是可直接改写的明文且无校验（§8.2）、preload 路径无运行时断言（L-04）、`backgroundThrottling:false` 的代价由 Live2D 自己承担而它没有窗口状态门（M-37）、`tool:event` 广播给所有窗口（L-08）、回环 origin 在所有构建上恒受信（L-07）。

**Security: 7.5/10**
强控制扎实且**经实测**（不是纸面）：93 键 preload 面硬编码哨兵、五条件 sender 校验、DOMPurify 显式白名单 + 真实 Chromium XSS 门禁、凭据永不跨桥明文且 `safeStorage` 失败 fail-closed（拒 `basic_text`）、token 与 origin 绑定在 connect 时**再次**强制、工具无通用命令入口且黑名单恒赢授权、截图有状态机无旁路。扣分在一个**真实的越权能力**（H-01：任意文件读 + 外传，违反明文进程边界不变量）、反取证通道（M-28）、以及既有安全清单把"来源 + schema"误当完整控制因而**结构上无法发现**这类问题。**未发现理论风险被夸大的情况，也未发现今天即可远程打穿的漏洞。**

**Reliability: 6/10**
强项真实：Main 的 socket/传输双栅栏 + 每 pending 家族各自 timer（无交叉清除）、显式 connect 是硬 source 边界、原子写核心正确（`O_EXCL|O_NOFOLLOW` + fsync + rename + 目录 fsync）、`safe-open` 彻底（`O_NONFOLLOW`/`O_NONBLOCK`、拒符号链接/FIFO/设备、双侧 realpath 包含性）、shutdown 每步独立 try/catch 且有超时兜底、`CredentialStore`/`CharacterDraftStore` 的持久化是正确范本（写队列 + await close + 拒绝覆写未知版本 + `retryPendingWrite`）。扣分在：退出不 flush 导致输入静默丢失（H-04）、流式生命周期无出口（H-10）、损坏隔离失败后空态覆写 + `schemaVersion` 写了不读（H-11b）、已成功写入被报失败并诱导重复提交（H-11c）、Main 无未捕获异常兜底（H-12）、多处"失败以什么都没有的形式到达用户"（M-18/M-19/M-01）。

**Performance: 6.5/10**
值得表扬的是**没做无收益的微优化**，且几处关键设计是对的：delta 就地嵌套变更（列表不逐 token 重渲染）、rope 式累加器、真二分虚拟列表 + 实测高度批处理、TTS 在 Main 侧按流分块、Live2D 完整性哈希流式且记忆化。扣分在：流式渲染实质不成立（H-03，最严重）、同步 diff 可冻结整个应用（H-09）、O(N) 重算 + 全文扫描 + 数组不封顶而门禁规模覆盖不到（H-08）、1.73MB 未压缩单 chunk + 228KB Core 在首绘路径（M-35/M-36）、两个最重子系统有无界缓存（M-25/M-26）。

**UI Engineering: 5.5/10**
有做得好的部分（暗色模式靠 `color-scheme` + 32 个 `light-dark()` token 完整成立且经截图确认；`CySwitch` 是正确实现；5 个 modal 里 4 个焦点管理完整且 `CyToolApproval` 把初始焦点放在「拒绝」这个安全默认上；图标按钮**无一**缺少可访问名；`error-message.ts` 是真单一来源被 15 个组件消费；工具卡是最好的一面；48/57 个 SFC 零颜色字面量）。扣分在：回答不能复制（三路全断）+ 不跟随底部（H-02）、安全授权按钮标签实际不可见（M-20）、全屏 modal 零焦点管理（M-21）、按住说话键盘不可操作（M-22）、**没有任何文字缩放途径**（§9.2）、自有"减少动态"开关不管 CSS 动画（M-24）、9 处永不匹配的断点 + 死常量（M-23）、设置保存失败不可见（M-19）、以及 token 契约只能查引用不能查用法（§9.2）。**规格（doc 03 / doc 11 / 整改清单）与实现之间存在成片的未落地条款，这是本维度分数最低的直接原因。**

**Testing: 7.5/10**
行为断言质量高、核心链路（流式组装、去重、工具六路径中的五条、持久化损坏、真实 Electron 崩溃与退出）覆盖扎实，且做过红绿变异验证与测试陈旧性审查，重点领域（多角色 8.7k 行测试）投入大。扣分在：9 个关键领域中"可访问性"未系统覆盖、"审计"只有 mapper 级 + 一次同时匹配成功与失败的子串、"真实 safeStorage 加解密"在 CI 从未执行、"dev 形态"结构上零覆盖、"channel↔handler 完整性"无人断言；以及两处**测试保护了 bug**（防抖语义、`lil` 恒真分支）。另有一处诚实性问题：本机集成套件全红（环境/工具链原因，已反证非产品缺陷，但需在有 CI 的机器上复跑确认）。

**Maintainability: 6.5/10**
文档体系（17 份核心文档 + 74 份历史记录 + 索引自动生成 + `docs:check`）在同类项目中属于优秀，且本仓库有"不重复记录状态、历史快照只描述当时事实"的明确纪律；代码常量因子化程度高（约 45 个命名超时/限额，仅 4 个裸字面量）。扣分在：契约镜像三向手抄无生成器（H-05）、手写安全校验器四份已分叉（M-11）、请求栅栏 7 种方言（M-12）、连接身份 3 种定义（M-13）、6 份 public error 形状副本、`check:contract` 不在 CI、vendor 排除后替代 stub 自身不 lint 且只覆盖 6/11 子路径（M-09/L-16）、以及 §7.2 那六条"注释即契约"。

**Overall: 7.0/10**

**这个分数反映的判断**：这是一个**工程质量显著高于行业平均、安全基线经过真实对抗性测试、但门禁的判别力集中在"形状"而非"行为"**的项目。它的强项（Electron 安全配置、IPC 信任边界、凭据处理、持久化原子性、工具权限决策链）是真材实料、经得起逐行核对的；它的弱项不是"代码写得差"，而是**几类问题能同时穿过全部门禁**：一个越权能力（H-01）、一次产品核心交互失效（H-02）、一个让"流式"名不副实的语义错误（H-03）、一条静默数据丢失路径（H-04）、以及一个覆盖率仅 41% 的契约镜像层（H-05）。

值得强调的是：本轮**没有发现任何 Critical**，也没有把理论风险夸大为漏洞 —— 事实上我**证伪了**两条 Subagent 报上来的 High（`setWindowOpenHandler` 前缀绕过、`getLastCrash()` 恒为 null），并据此下调了三条（`ToolCallRecord.diff` High→Medium、`SessionStore` 并发写 High→Medium、`shell.openExternal` 一致性 Medium 且明确其安全性应为 Low）。同时我**实测证伪**了任务书暗示的"打包后缺依赖"假设。

---

## 17. 明确回答任务书的 5 个问题

**1. 发现多少 Critical / High / Medium / Low？**

| 级别 | 数量 | 说明 |
|---|---|---|
| **Critical** | **0** | 未发现满足 Critical 定义的问题。项目已登记的对外分发阻塞项（`EXT-01` 第三方资产授权、`asar:false` 完整性）不计入本轮新发现，但已列入 P0-7 |
| **High** | **12** | H-01 ~ H-12（其中 H-05 的实例 M-02、H-11a 已按二次验证结论**下调**到 Medium） |
| **Medium** | **40** | M-01 ~ M-40 |
| **Low** | **33** | L-01 ~ L-33 |
| 额外 | — | 本轮**证伪 2 条** High 级 Subagent 结论、**下调 3 条**、**证伪 1 条**任务书假设（见 §14/§8.3/§13.1） |

**2. 最值得优先解决的 5 个问题**

1. **H-01** — `attachments:upload` 任意本地文件读取 + 外传。唯一同时（a）违反 `CLAUDE.md` 明文进程边界不变量、（b）不需要"被攻陷的 Renderer"以外的第二个条件的问题。（先上黑名单即可立即降险，再迁到 Main 签发 handle。）
2. **H-02** — 消息列表不跟随底部 + 回答无法复制。产品最核心交互与最高频操作同时失效，且用户**得不到任何提示**。
3. **H-04** — 退出时 renderer 防抖持久化从不 flush。最高频的静默数据丢失路径，且工程其余部分对持久化异常谨慎 —— 反差说明这是遗漏而非取舍。
4. **H-03** — 流式渲染实为防抖，"流式"核心卖点在常态 token 率下不成立。改动量最小（1 个工具 + 1 个组件），收益立竿见影。
5. **H-05** — 契约镜像覆盖率 41%、15 个事件成员非 strict、唯一跨仓门禁不在 CI。这是**元问题**：不修它，后续每一轮契约漂移都只能靠人肉评审发现。

（H-10 流式生命周期无出口、H-11b 持久化可毁数据 紧随其后，若前五项处理完应立即接上。）

**3. 当前项目是否适合继续开发新功能？**

**适合。** 理由：

- 静态门禁真实有效（typecheck / lint / 214 文件单测 / 5 个 CI job 全绿），新增代码会被合理约束。
- 进程边界、IPC 信任边界、凭据处理、工具权限决策链这些"新增功能必须挂靠的地基"质量扎实且经对抗性测试。
- 上述 High 问题**都不是"新功能会踩到"的阻塞**：H-02/H-03 是既有交互缺陷且改动局部；H-01 需要单独立项封堵；H-04/H-05 是横切加固，可与新功能并行。（唯一的例外是**多角色域**：H-07 的"双缓存不收敛"与 H-06 的 Mock/Real 结构分叉意味着在该域继续叠加新功能会放大既有混乱 —— 建议先做 P1-10。）

**4. 是否建议先进行一轮技术债整改？**

**建议做，但只做 P0 那一批（约 7 项），不要开一场大重构。** 理由：

- P0 里有 4 项（H-01/H-02/H-03/H-04）是**用户可感知或安全相关**的，不修就等于带着已知缺陷继续堆功能。
- P0-5 与 P0-4 改动局部、风险低、收益立即（合计约 **S+M** 复杂度）。
- 反过来，把 P1/P2 一起启动（尤其 P1-10 角色域重构、P2-3 依赖归类、P2-11 的 XL 级架构收口）会在缺少真机联调窗口的情况下引入新风险 —— 项目自己的历史（`docs/review/` 里多次"整改批次导致真机复现"）已经证明了这一点。
- 具体建议：**先做 P0-1 ~ P0-6（安全 + 数据 + 核心交互），然后是 P1-1/P1-2/P1-3（门禁判别力）**，这三项做完再开新功能，性价比最高。

**5. 推荐的整改顺序**

```
第 0 步（立即，互不依赖，可并行）
  P0-1 封死附件任意文件读   ── 先上黑名单（S），再评估 handle 方案（L）
  P0-2 退出 flush 持久化     ── M
  P0-3 持久化损坏 fail-closed ── M
  P0-4 真节流流式渲染        ── S（同时修掉保护 bug 的那个断言）
  P0-6 Main lifecycle 兜底   ── S

第 1 步（P0 收尾）
  P0-5 跟随底部 + 回复可复制  ── M（须重跑 perf-gate ②/③）
  P0-7 发布阻塞项收口        ── L（EXT-01 依赖外部事实，可并行推进）

第 2 步（门禁判别力 —— 做完再开新功能）
  P1-2 channel↔handler 对齐测试 ── S
  P1-3 契约锚点 + 事件 strict   ── M
  P1-1 IPC 预算收口（先测试式） ── M
  P1-4 check:contract 进 CI     ── S
  P1-11 类型/lint 门禁加固      ── M

第 3 步（稳定性收口）
  P1-5 SessionStore 写序列化    ── S
  P1-7 流式 watchdog + 乐观取消  ── M
  P1-8 write 校验前移 + diff 出主线程 ── M
  P1-6 REST 栅栏语义修正        ── M
  P1-12 renderer 可观测性接诊断  ── M

第 4 步（性能与体验）
  P1-9 列表记忆化 + 窗口封顶    ── L
  P2-1 压缩 / P2-2 拆 chunk     ── S / M
  P2-7 可访问性修复批           ── M

第 5 步（打包与跨平台）
  P2-3 依赖归类（先写守卫测试）  ── M
  P2-4 Windows 打包进 CI        ── S
  P2-5 dev 形态集成测试         ── M
  P2-6 fixture 跨平台 + 临时目录回收 ── S
  P2-10 测试卫生                ── M

第 6 步（架构，独立立项、按域分批）
  P1-10 角色域双缓存收口        ── L（建议先于多角色域新功能）
  H-06 / P2-11 RealBackend 拆分、契约单一来源、fencing helper、组合根显式化 ── XL
```

**最关键的顺序约束**：**第 2 步（门禁判别力）必须在"开新功能"之前**。H-01/H-05 能被本轮发现，正是因为它们绕过了所有现有门禁；在门禁恢复判别力之前，下一批同类问题同样会被绿线掩盖。

---

## 18. 本轮验证与反证记录（供复核）

### 独立验证为**真实**的 High 级结论

| 结论 | 验证方式 | 结果 |
|---|---|---|
| H-01 附件任意文件读 | 通读 `channels.ts:91` → `upload-service.ts:140-154` → `attachment-policy.ts:44,74` → `real-backend.ts:1363-1365`；确认 `PATH_BLACKLIST_DEFAULTS` 仅被 `tool-service.ts:467`/`tool-executors.ts:32` 引用；确认 `chat:set-endpoint` 无白名单（`channels.ts:25`） | **真实** |
| H-02 不跟随底部 | 穷举 `CyMessageList.vue` 全部 8 处 `atBottom` 赋值点，逐处确认无"内容增长"触发；两处 `items.length` watcher 逐行读过；确认 `overflow-anchor: none`；对照 spec `2026-08-14-phase3-history-drafts-design.md:201` 与 doc 03:213-214 | **真实** |
| H-03 防抖非节流 | 读 `debounce-trailing.ts:15-18` 全文；读 `CyMarkdown.vue:18,25,30`；确认 `debounce-trailing.spec.ts:11-13` 把该语义钉死 | **真实** |
| H-04 退出不 flush | 穷举 `flush` 的 4 处命中（定义 + 2 个调用点）；grep `beforeunload`/`pagehide`/`visibilitychange` 全仓 0 命中；读 `index.ts:461-466` 的 3 步 shutdown | **真实** |
| H-05 契约镜像 | 读 `framework.d.ts` 全文确认 6/11 子路径；读 `ipc-response.ts:95-113` 的 `.strict()` + 无 `diff`；读 `tool.store.ts:77`；读 `tool-policy.ts:11-26` 的黑名单 | **真实**（其实例 M-02 已按数据流修正级别） |
| M-01 renderer 错误无出口 | grep `renderer:js-error` 全仓仅命中 `main.ts` 自身；grep `console-message`/`webContents.on` 在 main 下只有 3 处且均非 console | **真实** |

### 独立**证伪**的 High 级 Subagent 结论

1. **S-02「`setWindowOpenHandler` 的 `startsWith('http:')` 是假 scheme 测试，`http:evil` 等可绕过」→ 证伪。**
   实测 `new URL('http:evil').protocol === 'http:'`（该字符串解析为带凭据的 http URL，凭据为 `evil`），`new URL('http:\\evil')` 同样归一化为 `http://evil/`。按 WHATWG URL 文法，`URL.protocol` 必带尾冒号且 scheme 字符集限于字母数字/`+`/`-`/`.`，**没有任何非 http(s) 的 scheme 会以 `http:` 开头**。因此该前缀测试在 scheme 判定上等价于协议白名单。该点保留为 **M-04（三处调用严格度不一致，Medium，安全性子项为 Low）**，未作为漏洞上报。
2. **S-05「`getLastCrash()` 恒返回 `null`，D7B-05 整个交付物不可达」→ 证伪。**
   `setMarker` 是闭包 `(m) => { crashMarker = m }`，写的是模块变量；`getCrashMarker()`（`main-window.ts:20-24`）读同一变量并一次性清空。`handleRendererGone` 从不读 `deps.marker`，所以"按值捕获导致失效"的推理对**功能**不成立。项目集成测试实测佐证：`tests/integration/renderer-crash.spec.ts:60-64` 断言 reload 后 banner 已呈现（证明确实读到了 marker），随后 `getLastCrash()` 为 `null` 是**刻意的单次消费语义**，注释亦如此说明。剩余真实部分仅为"`marker` 是死参数" → 记为 **M-06（Low）**。

### 独立**证伪**的任务书假设

3. **「`files:` 只含 `out/**` + `electron-builder` ⇒ externalized 依赖（`ws`/`zod`/`diff`）在打包产物中缺失，主进程启动即 MODULE_NOT_FOUND」→ 证伪。**
   `pnpm --filter @cyrene/desktop exec electron-builder --dir` 实测成功；产物 `resources/app/node_modules` **存在**且含 `zod`/`ws`/`diff`/`vue`/`pinia`/`marked`/`dompurify` 等（20.87 MB）。electron-builder 自动复制生产依赖闭包（日志 `• searching for node modules  pm=pnpm`）。**不得据此上报启动失败**；真实产物问题为 M-38（约 16 MB 死重）与 M-39（Windows 打包未进 CI）。

### 实测数据点（可复核）

- `out/main/index.js` 的外部 `require`：`diff`、`ws`、`zod`（+ `electron`/内置模块）；`out/preload/index.js`：仅 `electron`。
- 打包产物 `resources/app/node_modules` 体积 20.87 MB；`resources/app/out` 2.81 MB；`Cyrene.exe` 225,441,792 B。
- `out/renderer/assets/index-*.js` = 1,731,370 B / 44,728 行；`out/renderer/live2d/live2dcubismcore.min.js` = 228,050 B；**`out/` 下 `.map` 文件数 = 0**。
- `%TEMP%\cy-int-ud-*` 累积 **103 个 / 59.65 MB**（最早 2026-08-22，最新为本次失败运行）；本轮**已清理**，未触及仓库。
- 主进程独立启动反证：以 `--inspect=0 --remote-debugging-port=0 apps/desktop` + `CYRENE_TEST_HARNESS=1` + `CYRENE_TEST_APP_DATA=<temp>` 直接启动 `electron.exe`，**12 秒后进程仍在运行** ⇒ 本机集成测试全红系 Playwright↔Electron 握手问题，非产品缺陷。
- 结束时工作区状态：`git status --short` 空、`git ls-files --others --exclude-standard` 空 ⇒ **无任何受版本控制的文件被修改**。

### 本轮未能确认的事项（诚实标注）

- **本机集成测试全红的根因**未定位（已反证非产品缺陷，但未能找出 Playwright/Electron 握手为何失败）。建议在有 CI 的机器上复跑确认集成门禁本身是否失效。
- **Live2D 在 Electron 43 下最小化时是否仍投递 rAF**（`backgroundThrottling: false`）未实测 —— M-37 的结论是"应用**自己没有**任何窗口状态门，也没有测试覆盖任一方向"，而非断言平台行为。
- **对比度比值**由 token 字面量手算（WCAG 2.x 相对亮度），未在渲染后取样；`color-mix()`（`CyToolCard.vue:433`、`CyHistoryViewer.vue:318`）、`opacity` 乘算、`backdrop-filter`（`CySettingsView.vue:161`）与渐变面上的实际合成比值**未验证**。
- **`apps/tmp-ui-walkthrough/` 的截图已过时**（显示文字按钮而代码是 icon-only；设置导航 5 项而代码 7 项），仅在代码可佐证处使用；两处需新截图的视觉主张（range 输入轨道颜色、设置体可否滚动）已在原始 UI 评审中标注为待补。

---

*报告结束。本轮仅新增本文档，未修改任何业务代码、未升级依赖、未改动架构，未运行任何可能改写受控文件的命令（`pnpm package` / `electron-builder --dir` 仅写入已被 `.gitignore` 忽略的 `out/` 与 `dist/`，两者均已核实不影响工作区状态）。*
