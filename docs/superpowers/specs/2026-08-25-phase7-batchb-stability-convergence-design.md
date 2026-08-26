# 阶段 7 批次 B（7B 稳定性收敛）—— 设计文档（spec）

**日期：** 2026-08-25
**批次：** 阶段 7 批次 B（7B 稳定性收敛）
**父文档：** doc 10 §10.1、doc 16 §10（任务清单 + 验收门槛）
**前置：** 阶段 3~6 Demo 功能完成（✅）；阶段 7 批次 A（安全收敛）已真实联调通过（2026-08-22，`docs/review/2026-08-22-阶段7批次A-真实联调验收.md`）。

---

## 0. 结论（TL;DR）

7B = **稳定性收敛批次**，覆盖四个面：

1. **Renderer 崩溃恢复**（纯新增）：主进程监听 `render-process-gone`（2 参回调——真实 WebContents 签名）+ `child-process-gone`（GPU，main() 内），崩溃时留痕 + 持久化 crash marker → 自动 reload + 审计；reload 后新 Renderer 经 `getLastCrash` 读 marker 显示提示条。
2. **网络中断回归 + 新能力**：断线浏览历史（既有）+ **草稿断线自动持久化**（新增）+ mock 断线模拟（新增）+ mock/real 回归集。
3. **缓存损坏统一层**（架构收口）：抽取 `createCorruptIsolation` 骨架（隔离备份/重建/审计计数/单测模板），各持久化 store 采用但**各自声明 fail-open 或 fail-closed 语义**。
4. **GPU 上下文恢复**（核对 + 进程级兜底）：Live2D 渲染层链路完整（阶段 5 批次 C），7B 补 Electron **GPU 进程崩溃**(`child-process-gone` type==='GPU') 兜底。

**临时附件 / 录音文件磁盘清理 → 7D**（与 D-08 / F-11 同属「清理/保留策略收口」，本批不做）。

**三态**：本批 = 代码批，Mock 驱动，**三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后）。

---

## 1. 范围

### 1.1 本批范围（7B）

| 面 | 内容 | 类型 |
|---|---|---|
| **A. Renderer 崩溃恢复** | `webContents.on('render-process-gone')`（2 参回调——真实 WebContents 签名）→ 留痕 + crash marker + 自动 reload + 审计 `renderer:crash`；进程级 `app.on('child-process-gone')`（GPU，main() 内注册——对 A 面的进程级兜底，落点面 D） | **纯新增** |
| **B. 网络中断回归 + 新能力** | 断线浏览历史（既有 offlineView，补回归）+ 草稿断线自动持久化（新增）+ mock 断线模拟 `CYRENE_MOCK_DISCONNECT_AFTER_MS` + real/mock 回归集 | **回归 + 新增** |
| **C. 缓存损坏统一层** | `createCorruptIsolation` 骨架（隔离备份/重建/审计计数/单测模板）；settings/credentials/session-store/tool-history 采用，各自声明 fail-open/fail-closed | **架构收口** |
| **D. GPU 上下文恢复** | Live2D 渲染层链路核对（阶段5批次C已完整）；+ Electron 进程级 GPU crash（`child-process-gone` type==='GPU'）兜底 + `enableHardwareAcceleration` 评估 | **核对 + 进程级新增** |

### 1.2 不在范围（7B 不做）

- **性能基线**（200 条混合/100 多分段/500 历史资源/内存增长/Live2D CPU-GPU 下降）→ **7C**。
- **临时附件/录音文件磁盘清理** → **7D**。
- **D-08 资源缓存清理 / F-11 审批历史保留策略正式确认** → **7D**。
- **Blocker/Critical 集中修复** → **7D**。
- **拆掉重做的免损恢复 / 断线期间本地发消息队列** → 不做（用户拍板：崩溃=检测+提示+安全 reload；网络=断线浏览+草稿，不改发送状态机）。
- **Renderer 全局错误兜底（window.onerror / unhandledrejection / Vue errorHandler）** → 本批**只做审计+崩溃留痕，不做 UI 级 error boundary**。崩溃提示与全局错误是两回事：崩溃是进程没了，错误是 JS 异常。7B 聚焦进程退出（崩溃），JS 异常兜底（errorHandler）保留为观察项——本批调研后**弱化**（不展开 UI error boundary，避免摊大）。

---

## 2. 用户拍板决策点（记录进决策记录）

| # | 决策点 | 用户拍板 | 落点 |
|---|---|---|---|
| D7B-01 | 临时附件/录音文件磁盘清理归属 | **→ 7D**（与 D-08/F-11 同属清理/保留策略收口） | 本批不做 |
| D7B-02 | Renderer 崩溃恢复深度 | **检测 + 提示 + 安全失败 reload**（不做免损恢复） | §4A |
| D7B-03 | 缓存损坏统一层形态 | **统一骨架 + 语义可配**（隔离备份/重建/审计计数/单测模板；各 store 声明 fail-open/fail-closed） | §4C |
| D7B-04 | 网络回归新能力方向 | **断线浏览历史 + 草稿自动保存**（重连后 replay 同步；不改发送状态机） | §4B |
| D7B-05 | 崩溃提示呈现通道 | Main 检测 → 持久化 crash marker（Module 内存 lastCrash）→ reload 后新 Renderer 经 `getLastCrash` invoke 读取显示提示条 | §4A |
| D7B-06 | 崩溃 reload 目标 | `webContents.reload()`（重载当前页，不走 devOrigin 判定回流） | §4A |
| D7B-07 | 崩溃自动性 | **自动 reload + reload 后读 marker 提示**；中断 generation 按既有 in-flight 语义置 interrupted，不自动续写 | §4A |
| D7B-08 | 崩溃留痕 | **audit 区分**：renderer 崩溃 `renderer:crash`、GPU 崩溃 `gpu:crash` + logger（不共用 `'renderer:crash'`——契约 H-1 解耦） | §4A |

---

## 3. 现状与缺口（Explore 摸底 + 主会话独立核实）

### 3.1 Renderer 崩溃（面 A）
- **主进程零崩溃兜底**：grep `render-process-gone` / `child-process-gone` / `unresponsive` / `did-fail-load` / `web-contents-created` / `'crash'` 全 0 命中（`index.ts`、`windows/main-window.ts`、`app/lifecycle.ts` 均无）。
- **无 auto-reload** 逻辑。
- **Renderer 零全局错误兜底**：grep `window.onerror` / `window.addEventListener('error'` / `unhandledrejection` / `app.config.errorHandler` / `onErrorCaptured` 全 0 命中。
- `dialog.showErrorBox` 现成先例只服务启动期 fatal（`index.ts:48-52` `createFatalShutdown`）。
- **安放点**：`windows/main-window.ts:81-101`（setWindowOpenHandler + will-navigate + before-input-event 钩子群）；进程级在 `index.ts:109`（second-instance）/`:337/:391`（before-quit）/`:425-426`（activate/window-all-closed）。

### 3.2 网络中断（面 B）
- **重连状态机完整**（`transport/real-backend.ts`）：`RECONNECT_BASE_DELAY_MS=1000`/`RECONNECT_MAX_DELAY_MS=30000`/`RECONNECT_MAX_ATTEMPTS=6`（`:95-97`）；`scheduleReconnect()`（`:596-622`）指数退避，**超限（>6 次）→ `setState({status:'error', lastError})`**（`:601-609`）。
- **重连超限停在 `error`，无自动降级为离线只读、无专门手动「重新连接」按钮**——仅 `CyConnectionPanel.vue:62-69` `toggleConnect()`（connected 时 disconnect，否则 connect）。
- **mock-backend 无断线模拟**：`mock-backend.ts:483-497` 只有 connect/disconnect/getConnectionState，无 status:'error'、无 reconnecting、无 scheduleReconnect、无 env 桥。**7B 需加 `CYRENE_MOCK_DISCONNECT_AFTER_MS` env 或 `simulateDisconnect()` 注入**。
- **离线视图完整**：`conversation.store.ts:29` offlineView、`:258-263` setOfflineCache、`:266-281` activateLocal、bootstrap disconnected 分支水合。
- **draft 断线不自动持久化**（**面 B 新增注入点**）：`draft.store.ts:30-45` persistNow 仅在 saveDraft/clear/flush 触发，无断线路径 → 7B 在连接离开 connected 路径补 `flush()`。

### 3.3 缓存损坏（面 C）
- **settings**：`settings-service.ts:35-57` `load()` → `.corrupt` 隔离 + 回默认（**fail-open**，不阻塞启动）。
- **credentials**：`credential-store.ts:56-72` readFile，`:78` getStatus catch→unavailable，`:79` version 不匹配 → unavailable；`:102/:125` setCredential/clearCredential → `createEmptyFile()` 整文件重建，但 **version 不匹配 throw `UNSUPPORTED_VERSION`（fail-closed）**（`:103/:126`）。
- **session-store**：`session-store.ts:52-99` `load()` → 整文件损坏 rename `.corrupt-<ts>` + 重建空；条目级 safeParse 失败丢条目不污染（**整文件隔离 + 条目级 fail-open**）。
- **tool-history**：`tool-history.ts:34-36` 单行 JSON.parse 失败 → `logger.warn('history:broken-line')` + continue（**断行跳过**）。
- **user-data-dirs**：`user-data-dirs.ts` `assertSafeLeaf()` → 目录损坏（文件/symlink）抛 `UserDataDirError`（**fail-closed 拒启**，`index.ts:422` 启动 fatal）。
- **结论**：各存储损坏语义**异构**（fail-open vs fail-closed vs 条目级 vs 整文件级）——正是「统一骨架 + 语义可配」的依据。

### 3.4 GPU 上下文恢复（面 D）
- **Live2D 渲染层链路完整**（阶段 5 批次 C）：
  - `adapter.ts:468-507` `initialize` → 创建 WebGL1 context + 订阅 `webglcontextlost`（gpuLost=true）+ getExtension `WEBGL_lose_context`。
  - `adapter.ts:517-527` `createModel` → gpuLost 抛 Live2DGpuLostError；`:524` context lost + restoreLostContext 失败 → 抛。
  - `adapter.ts:637-648` `update()` → gpuLost || isContextLost(gl) 抛。
  - `adapter.ts:673-682` `restoreLostContext(gl)` → restoreContext + 轮询 ≤1.5s。
  - `controller.ts:209-233` `tick()` → GPU-lost → failed → emit device_lost → fallback（静态头像）。
  - `controller.ts:239-264` `reset(modelId?)` → rebuild。
  - `live2d.store.ts:81/190-239` `rebuildGuard` 防重入 + `rebuildAfterLost()`（reset + fallback 兜底）。
- **缺 Electron 进程级 GPU crash 兜底**：`app.on('child-process-gone', (e) => e.type==='GPU')`、`enableHardwareAcceleration` 开关评估——当前 0 命中。

### 3.5 IPC / preload 现成模式（面 A 崩溃提示复用）
- `PushChannels`（`shared/contracts/ipc.ts:74-78`）现有 6 键：`event`/`state`/`replay`/`error`/`toolEvent`/`diagnosticsDevEvent`。
- preload 订阅形态统一「注册返回取消函数」：`desktop-api.ts:393-401` onToolEvent、`:452-460` onDiagnosticsDevEvent。
- `createIpcHandler<TReq,TRes>(requestSchema, responseSchema, fn)`（`ipc/executor.ts:22-27`）双端 zod。
- `isTrustedSender` 模块内私有未导出（`ipc/registry.ts:27`）；`isTrustedSenderFor` 已导出。

---

## 4. 设计

### 4A. Renderer 崩溃恢复

**原则**：崩溃是进程级异常，必须在 **Main** 检测与处置。Renderer 已崩，无法可靠自 reload——reload 由 Main 执行。**Renderer 已死，无法接收崩溃 push**（安全 H-2 修正）——崩溃提示改为「Main 持久化 crash marker + reload 后新 Renderer 经 invoke 读取」。

**4A.1 主进程崩溃监听（新增）**

**架构**：崩溃监听放在 `windows/main-window.ts`，但该模块**不反向依赖** diagnostics——把 `logger`/`audit`/`onRendererGone` 经 `MainWindowOpts` 注入（与现有 `isDevMode` 注入同模式，`main-window.ts:25-28` 已有 `MainWindowOpts` 接口）。

**MainWindowOpts 扩展**：

```ts
export interface MainWindowOpts {
  isDevMode?: () => boolean                              // 既有（D7A-04）
  logger?: Logger                                        // D7B-08：崩溃留痕日志（index.ts 注入 diagnostics.logger）
  audit?: (event: Omit<AuditEvent, 'ts'>) => void        // D7B-08：崩溃审计（index.ts 注入 audit 包装）
  onRendererGone?: (details: { reason: string; exitCode: number }) => void  // D7B-05：崩溃 marker 持久化回调（index.ts 注入）
}
```
**注意**：`MainWindowOpts` 经 `index.ts:417`（`ensureMainWindow`）+ `index.ts:109`（second-instance `focusOrDefer`）+ `index.ts:425`（activate `focusOrDefer`）多个创建点。**安全 MED-2 修正**：`focusOrDefer()` 在 second-instance/activate 路径不带 opts → `opts?.logger`/`opts?.audit` 为 undefined。**修法**：把 `logger`/`audit`/`onRendererGone` 提升为模块级注入的常量 sink（`main-window.ts` 从一处读取，所有创建路径共享），而非放 `MainWindowOpts`。下述代码按**模块级注入**示意（`@inject` 为模块级 `let`），实现时落地为模块作用域变量 + 一个 setter。

在 `windows/main-window.ts:101`（before-input-event 之后）新增：

```ts
// D7B-05/D7B-07：Renderer 崩溃——检测 + 持久化 marker + 自动 reload + 审计。
// 崩溃是进程级：Main 检测与处置；Renderer 已崩，reload 由 Main 执行，且 killed renderer 收不到 push（安全 H-2）。
// logger/audit/onRendererGone 为模块级注入 sink（安全 MED-2：所有窗口创建路径共享，非 per-opts）。
// 注意：win.webContents（WebContents 类）的 render-process-gone 回调是 2 参（_ev, details）——details 是第 2 参（Electron 43 electron.d.ts:17304；3 参属 App 接口，H-1 定位偏差已修正）。
win.webContents.on('render-process-gone', (_ev, details) => {
  // details.reason 枚举：clean-exit | abnormal-exit | killed | crashed | oom | launch-failed | integrity-failure | memory-eviction
  if (details.reason === 'clean-exit') return  // 正常关窗退出，不处理
  // ① 留痕（审计 + 日志）——非 clean-exit 全走崩溃路径
  crashLog.warn('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  crashAudit({ type: 'renderer:crash', summary: `渲染进程异常：${details.reason} (exit ${details.exitCode})` })
  // ② 持久化 crash marker（D7B-05 修正：renderer 已死收不到 push——改由 reload 后新页面读取）
  crashMarker = { reason: details.reason, exitCode: details.exitCode, ts: Date.now() }
  // ③ 自动 reload（D7B-06/D7B-07：reload 当前页；reload 后新 renderer 经 getLastCrash 读 marker 显示提示）
  setTimeout(() => {
    if (!win.isDestroyed() && win.webContents) win.webContents.reload()
  }, 300)
})
```

**注意**：`win.webContents`（`WebContents` 类）的 `render-process-gone` 回调为 **2 参** `(_ev, details)`——`details` 是第 2 参（Electron 43 `electron.d.ts:17304`；3 参 `(event, webContents, details)` 属 `App` 接口 `electron.d.ts:700`，非 WebContents 事件）。**`clean-exit` 是唯一正常退出**，其余 `abnormal-exit`/`killed`/`crashed`/`oom`/`launch-failed`/`integrity-failure`/`memory-eviction` 全走崩溃路径。

**`crashMarker` 持久化**：Main 侧模块级 `let crashMarker: { reason; exitCode; ts } | null = null`；崩溃时写入；reload 后 Renderer 经 `getLastCrash`（新增 invoke）读取；`getLastCrash` 读一次后**清空 marker**（一次性，防 reload 后每次启动都提示）。

**4A.2 进程级兜底（child-process-gone，GPU/utility）**（面 D 落点）

**安全 MED-1 修正**：`child-process-gone` 必须注册在 `main()` **内部**、`diagnostics`/`audit` 定义**之后**（模块作用域访问不到 `audit`/`diagnostics`——它们是 `main()` 局部变量 `index.ts:129/:131`）。**不放**在 second-instance（`index.ts:109`，模块作用域前的 app.on 组）。

```ts
// 面 D：进程级 child-process-gone——覆盖 GPU 进程崩溃。注册在 main() 内、audit/diagnostics 定义之后。
// child-process-gone 的 type 枚举：Utility | Zygote | 'Sandbox helper' | GPU | 'Pepper Plugin' | 'Pepper Plugin Broker' | Unknown（无 Renderer——渲染进程崩溃走 render-process-gone）。
app.on('child-process-gone', (_ev, details) => {
  if (details.type === 'GPU') {
    diagnostics.logger.warn('gpu-process-gone', { reason: details.reason, exitCode: details.exitCode })
    audit({ type: 'gpu:crash', summary: `GPU 进程异常：${details.reason} (exit ${details.exitCode})` })  // 契约 H-1：GPU 用 gpu:crash 独立 type，勿复用 renderer:crash
    // GPU 崩溃不自动 reload——Renderer 崩溃由 render-process-gone 处理；GPU 崩溃由 Live2D 层 recover（间接经 webglcontextlost）。
  }
})
```

**注意**：`child-process-gone` 的 `type` 枚举**无 `'Renderer'`**（该事件不含渲染子进程；渲染进程崩溃只走 `render-process-gone`）。本批**只对 GPU 进程崩溃留痕不自动 reload**，避免双触发 reload。`diagnostics`/`audit` **作用域**约束即上文 MED-1（child-process-gone 用它们必须在 `main()` 内注册），不作模块级 `app.on`。

**4A.3 崩溃提示 UI（Renderer）—— reload 后读取 marker**

新增一个全局提示条组件（复用断线横幅的呈现风格），启动时经 `getLastCrash` 查询 marker：

```ts
// renderer main.ts（App.vue 或专门的 store 内）
// D7B-05 修正：不再是 push 订阅（renderer 崩溃时收不到）；改为 bootstrap 时经 invoke 读 marker。
const lastCrash = await api.getLastCrash()   // 新增 invoke；返回 { reason, exitCode } | null；读后清空
if (lastCrash) showCrashBanner('页面已重启，进行中的回复可能中断')
```

**决策（D7B-07）**：**自动 reload + reload 后提示条**（marker 读取出）。中断 generation 按既有 in-flight 语义置 interrupted（`message.store.ts:455-475` handleConnectionStateChange 已在断线/error 时执行），**不自动续写**。

**决策（D7B-06）**：reload 用 `webContents.reload()`（重载当前页），不走 devOrigin 判定回流。

**4A.4 审计 schema / getLastCrash invoke**

- ~~新增 `PushChannels.rendererCrash: 'renderer:crash'`~~：**改为不发送**（renderer 已死收不到——安全 H-2），仅作为契约占位保留（若实现确认无需则删除）。**实际走 invoke `IpcChannels.diagnosticsLastCrash`**（见 §5）。
- 新增载荷 schema `RendererCrashEventSchema`（strict + `z.ZodType<RendererCrashEvent>` 注解 + `reason` z.enum 闭合枚举 + `exitCode` number.int()——契约 M-1 修正）——对齐 DiagnosticsDevEvent 的元数据纪律（**零正文**）。
- 新增 preload `getLastCrash(): Promise<RendererCrashEvent | null>`（读 crash marker——onDiagnosticsDevEvent 先例的 invoke 方向，非订阅）。
- 新增 `index.d.ts` 类型 + `RendererCrashEvent` 契约类型（`shared/contracts/diagnostics.ts`）。

### 4B. 网络中断回归 + 新能力

**4B.1 草稿断线自动持久化（新增）**

`message.store.ts:455-475` `handleConnectionStateChange` 处理 `reconnecting/error/disconnected` 时，在清理 local-* 之前补 `draftStore.flush(cid)`：

```ts
// message.store.ts 新增 import（可行性 M-1：当前未导入 useDraftStore——无循环依赖）
import { useDraftStore } from './draft.store'

// handleConnectionStateChange 开头补（H-3 修正：flush 必传 conversationId——签名是 flush(conversationId)，无 force 重载）：
// D7B-04：断线即刻落盘草稿（防断线丢失；draftStore.persistNow fail-open 保内存态）
// currentId 断线时保留（只在 activate/create/remove 清空）；guard 覆盖「从未激活任何会话」这一种情况
const cid = useConversationStore().currentId
if (cid) void useDraftStore().flush(cid)
```

**注意（H-3 修正）**：`draftStore.flush()` / `persistNow({force:true})` 签名**不存在**。`draft.store.ts:54` `persistNow(conversationId: string)` 与 `:77` `flush(conversationId: string)` 都**强制需要 `conversationId`**。**断线时 `currentId` 保留**（`conversation.store.ts` 的 `currentId` 只在 activate/create/remove 中赋值/清空，断线路径不触及）——guard 只需覆盖 `currentId === undefined`（从未激活）这一种情况。

**注意**：`draft` 持久化需 `getActiveConversationId()` 有值（Main 侧 setActiveConversation 已跟踪）；断线时若 activity 已清，需 guard——即 `cid` 为 undefined 则不落盘。

**4B.2 mock 断线模拟（新增）**

`mock-backend.ts` 新增（**可行性 M-2 修正**：mock 需支持 error→connected 恢复 + 新定时器进 clearTimers + 选项改名）：
- `constructor options.disconnectAfterMs?: number` —— 连接后 N ms 自动转 `status:'error'`（模拟断网超限）。**命名 `disconnectAfterMs`**（非 `disable`，有歧义）。
- 或 env 桥 `CYRENE_MOCK_DISCONNECT_AFTER_MS`（走既有 `parseMock*Env` 模式，`index.ts:154-184` + `:200` 传入 MockBackend；**useMock 门控**——真实模式不注入）。
- **状态语义修正**：`disconnectAfterMs` 到期后置 `connected=false` + 记 mock 态，使 `getConnectionState()` 返回 `{status:'error', lastError:'mock-disconnect', serverUrl}`。**`connected` 与 `error` 态互斥**——不能同时为真。
- **error→connected 恢复**：新增 `reconnect()`（或手动 `connect()`）置 `connected=true` + 发 `{status:'connected'}`——支撑 §4B.3「重连→成功」回归（mock 现有状态机无 `reconnecting`，error 直接回 connected 即可）。
- **新定时器登记**：`setTimeout` 必须进 `clearTimers()`（`mock-backend.ts:950-956`），否则 `dispose()` 不清理、测试悬挂。

**4B.3 回归集（新增 + 钉住既有）**

- **real**：mock 断线后 → connectionStore 置 error 态 → messageStore 清 local-* + in-flight interrupted → 补草稿 flush → reconnect 后 replay 去重恢复。
- **mock**：连接→断线（error 态）→ `connect()` 重连→成功闭环回归。
- **边界**：重连超限后停 error 态 + 手动重连（CyConnectionPanel toggle 在 error 态调用 connect()）恢复。

**注意**：不新增「离线发消息队列」——用户拍板 D7B-04 明确不改发送状态机。

### 4C. 缓存损坏统一层（架构收口）

**原则（D7B-03）**：统一**骨架**（隔离备份/重建/审计计数/单测模板），各 store 采用但**各自声明 fail-open / fail-closed 语义**——绝不拉平语义（凭据必须 fail-closed、settings 必须 fail-open）。

**4C.1 新增 `createCorruptIsolation` 骨架**

```ts
// main/persistence/corrupt-isolation.ts
import type { Logger } from '../diagnostics/logger'   // 契约 M-3：直接复用真实 Logger 类型（(code, fields?)，勿自定义同形异型接口）

export interface CorruptIsolationOpts {
  logger: Logger                       // 复用真实 Logger；warn(code, fields: Record<string,string|number|boolean>)
  countDiagnostic(code: string): void
}
export interface CorruptIsolation {
  /** 损坏隔离：备份现场 + 返回备份路径（语义/重建由调用方声明）。
   *  安全 MED-3：safeRoot 必须传入，rename 前对 file 做 realpath 包含性断言——勿丢弃现有 openSafeFile 的 safeRoot 约束。 */
  isolate(file: string, tag: string, safeRoot?: string): Promise<string>  // 返回 .corrupt-<tag>-<ts> 备份路径
  /** 条目级损坏：丢条目不污染（fail-open 指针）。只对「条目级 safeParse 失败丢件」的 store 适用 */
  dropInvalid(code: string): void
}
export function createCorruptIsolation(deps: CorruptIsolationOpts): CorruptIsolation {
  // isolate: 若 safeRoot 未传/含 escape → 抛；否则 rename(file, file+'.corrupt-'+tag+'-'+nowIso()) + countDiagnostic('persistence:corrupt-isolated')
  // dropInvalid: countDiagnostic(code)
}
```

**4C.2 各 store 采用但语义保留**（**可行性 M-3 修正**：四 store 异构，命名/计数参数化，勿硬编码统一 `.corrupt-<tag>-<ts>`）

| store | 语义 | 采用方式 |
|---|---|---|
| settings | fail-open（隔离 + 回默认） | `isolate(file,'settings',safeRoot)`——**备份名迁移**：现用 `.corrupt` → 改 `.corrupt-settings-<ts>`，**同步更新 `settings-service.spec.ts:64/65` 断言为 `.corrupt-settings` 前缀**（契约 M-4）；settings 无 countDiagnostic，**需补注入**（index.ts 装配处） |
| credentials | fail-closed（version 不匹配 throw） | **无 rename**——损坏现走 `createEmptyFile()` 整文件重建（`credential-store.ts:102/:125`），**并非「按 key 隔离」**；`isolate()` 对 credentials 是**新增隔离备份行为**（此前不备份只重建）→ **需单独确认语义**：是否改为「备份损坏文件 + 重建」；version 不匹配仍 throw（不归 isolate 管） |
| session-store | 整文件隔离 + 条目级丢 | `isolate(file,'session',safeRoot)` + `dropInvalid('persistence:corrupt-isolated')`——备份名 `.corrupt-session-<ts>`（现 `.corrupt-<ts>`，`session-store.spec.ts:115` 断言 `startsWith('message-cache-v1.json.corrupt-')` 兼容） |
| tool-history | 断行跳过 | **不套 `dropInvalid()`**——`readAuditEvents` 是读目录纯函数（参数仅 `logger?`），「断行跳过」是读路径内建行为，`dropInvalid` 需注入 countDiagnostic（该模块无）+ 结构性不匹配（无文件可 isolate）→ **tool-history 保持现状**，不纳入统一层 |

**注意**：credentials 的 `UNSUPPORTED_VERSION` 不能isolate 后重建——version 不是损坏是升级失败，必须 fail-closed 提示。**统一层只做「通用隔离/计数」，不接管语义决策**。

**`.corrupt-*` 清理策略（安全 MED-4 补）**：隔离副本 `.corrupt-<tag>-<ts>`（尤其 message-cache 含聊天正文）落在磁盘且**从不清理**（`clearAll()` 只删主文件不删 `.corrupt-*`；启动重建也不动旧备份），随损坏累积无界增长。**修法**：统一层为 `.corrupt-*` 加**有界保留**——下次成功 `load()` 时先清同 tag 的旧 `.corrupt-*`（只留最新一份），或按数量/mtime 清理；并在 doc 01/07 注明 `.corrupt` 副本**不纳入任何导出与传输**（`collectLogFiles`/`collectAuditLines` 只扫 logs/audit 目录，已确认不泄进诊断包）。本批落实「只留最新一份」的简单版；完整清理策略（与 D-08 资源缓存清理协同）可 defer 7D 记录。

**4C.3 单测模板 + 回归集**

新增 `tests/unit/corrupt-isolation.spec.ts`（骨架单测：isolate 正常隔离 + **safeRoot 负例**（传安全根外路径应拒绝）+ dropInvalid 计数）+ 各 store 补「损坏不崩溃」测试钉住（settings/credentials/session-store 已有部分，7B 统一回归）。

### 4D. GPU 上下文恢复

**4D.1 核对 Live2D 渲染层（不重写）**
阶段 5 批次 C 已完整（§3.4）。7B 只核对。`adapter.ts:674` 的「canvas 变更使 restoreLostContext 失效」是**有意的守卫**（旧 context 属旧 canvas 不可 restore——走 rebuild），**非开放风险**，不列为待复验观察项（可行性 L-4）。**GPU 崩溃经 webglcontextlost 间接显现**——Main 侧 `child-process-gone`（GPU）与 Live2D 层 `webglcontextlost` 有因果链：GPU 进程崩溃 → Chromium 重启 → 各 Renderer WebGL context 置 lost → `webglcontextlost` 触发 → Live2D `restoreLostContext`/`rebuild`（阶段 5 批次 C 已实现）。**结论正确**：Live2D 兜住的是 webglcontextlost 这个**症状**，Main 侧仅作早期留痕/审计。

**4D.2 进程级 GPU crash 兜底（新增）**
见 §4A.2 —— `app.on('child-process-gone')` type==='GPU' → 审计 `gpu:crash` + 留痕，不自动 reload（GPU 由 Live2D 层 recover 间接承接）。

**注意**：`enableHardwareAcceleration` 开关**评估不落地**——阶段 5 已定 hardwareAcceleration 启用（Live2D 需要），强制关会破坏 Live2D。7B 只记录评估结论，不改变现有值。

---

## 5. 契约 / schema / 通道

### 5.1 新增 PushChannels
| 键 | 值 | 说明 |
|---|---|---|
| `rendererCrash` | `'renderer:crash'` | Renderer 崩溃推送（D7B-05）——**注**：7B 崩溃提示改为「reload 后读 marker」，该 push 通道**不实际发送**（renderer 已死），作为**契约占位 + 审计 type 解耦参照**保留；实际流程走 `getLastCrash` invoke。若实现确认无需 push 则删除该通道（见 §5.2 重审） |

### 5.2 新增 schema / invoke
- `RendererCrashEventSchema`（**契约 M-1 修正**：加 `z.ZodType<RendererCrashEvent>` 注解 + `reason` 用 `z.enum` 闭合枚举 + `exitCode` 用 `.int()`）：
  ```ts
  export const RendererCrashEventSchema: z.ZodType<RendererCrashEvent> = z.object({
    reason: z.enum(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']),
    exitCode: z.number().int(),
  }).strict()
  ```
  零正文纪律对齐 `DiagnosticsDevEventSchema`（strict 未知键即失效）。
- **新增 invoke `IpcChannels.diagnosticsLastCrash: 'diagnostics:last-crash'`**——Renderer bootstrap 时读取 crash marker（`getLastCrash(): Promise<RendererCrashEvent | null>`），读一次后 Main 清空 marker（一次性）。响应 schema = `RendererCrashEventSchema.nullable()`。
- **`rendererCrash` push 通道裁决（回应 §5.1「见 §5.2 重审」）**：**保留** `PushChannels.rendererCrash: 'renderer:crash'` 作为常量，但 7B **不发送、不做 preload 订阅方法**（renderer 已死收不到）。通道常量保留仅为契约完整性（与 audit type `renderer:crash` 解耦参照），不作为实际数据通路。若实现时确认该通道无任何消费方，可 `git` 删除——以 Task 1 实现为准。

### 5.3 新增 preload 方法
- `getLastCrash(): Promise<RendererCrashEvent | null>`——读 crash marker（reload 后新页面 Bootstrap 调用）。
- ~~`onRendererCrash`~~：**移除**（renderer 崩溃时收不到 push——安全 H-2）；若保留 `renderer:crash` push 通道仅为契约占位，则 preload 无对应订阅方法。

### 5.4 白名单
- ipc-security 白名单断言（desktopApi 方法数）：73→**74**（+1 `getLastCrash` invoke 方法；**不含** `onRendererCrash`——已移除）。`renderer:crash` 若保留为 PushChannels 值则不入 IpcChannels invoke 枚举（先例 `chat:error`）；`diagnostics:last-crash` 入 IpcChannels invoke 枚举。

---

## 6. Task 分解（subagent 执行用）

### Task 1: 契约层（crash schema + getLastCrash invoke + preload）
**Files**: `shared/contracts/ipc.ts`（+diagnosticsLastCrash in invoke）+ `shared/schemas/ipc-response.ts`（+RendererCrashEventSchema：z.ZodType + reason enum + int）、`shared/contracts/diagnostics.ts`（+RendererCrashEvent 类型）、`preload/index.d.ts`、`preload/desktop-api.ts`（+getLastCrash）、`tests/unit/renderer-crash-contracts.spec.ts`
**TDD**：先写失败测试（schema/invoke/preload 未存在），实现后绿。**不含 onRendererCrash**（已移除——安全 H-2）。

### Task 2: 主进程崩溃监听（render-process-gone + reload + 审计 + crash marker）
**Files**: `main/windows/main-window.ts`（+render-process-gone **2 参回调** + 模块级 logger/audit/onRendererGone sink + crashMarker）、`main/index.ts`（+child-process-gone **main() 内注册** + getLastCrash handler + ensureMainWindow 装配模块级 sink）、`tests/unit/renderer-crash-handler.spec.ts`
**TDD**：崩溃钩子触发 → audit `renderer:crash` + crashMarker 写入 + reload；`clean-exit` 不处理；**2 参回调**（details 正确读取）。

### Task 3: 崩溃提示 UI（reload 后读 marker）
**Files**: `renderer/src/main.ts`（+bootstrap 时 getLastCrash）、`renderer/src/components/CyRendererCrashBanner.vue`（新）、`tests/unit/cy-renderer-crash-banner.spec.ts`
**TDD**：bootstrap 调 getLastCrash → 返回 marker 则显示「页面已重启」+ onUnmount 清理；getLastCrash 返回 null 不显示。

### Task 4: 网络——草稿断线自动持久化 + mock 断线模拟
**Files**: `renderer/src/stores/draft.store.ts`（flush 已存在，断线触发）、`main/transport/mock-backend.ts`（+disconnectAfterMs + error→connected 恢复 + clearTimers 登记）、`renderer/src/stores/message.store.ts`（+useDraftStore import + handleConnectionStateChange 补 flush(cid)）、`tests/unit/draft-persist.spec.ts`、`tests/unit/mock-disconnect.spec.ts`
**TDD**：断线 → 草稿 flush(cid) 被调；mock 断线 → error 态；mock connect() 恢复→connected。

### Task 5: 缓存损坏统一层
**Files**: `main/persistence/corrupt-isolation.ts`（新，isolate 带 safeRoot + Logger 同构）、`main/settings/settings-service.ts`（isolate，备份名迁移 .corrupt-settings + 补 countDiagnostic）、`main/credentials/credential-store.ts`（**决策单列**：是否从「重建」改「备份+重建」）、`main/persistence/session-store.ts`（isolate+dropInvalid）、`tests/unit/corrupt-isolation.spec.ts`、`tests/unit/settings-service.spec.ts`（更新断言）
**TDD**：骨架单测（含 safRoot 负例）+ 各 store 损坏不崩溃。

### Task 6: GPU 进程级兜底 + 集成门禁
**Files**: `main/index.ts`（+child-process-gone GPU，main() 内）、`tests/integration/renderer-crash.spec.ts`、`tests/integration/renderer-crash-banner.spec.ts`、`tests/unit/gpu-process.spec.ts`
**TDD**：ChildProcessGone GPU → audit `gpu:crash`，不 reload；集成崩溃 marker → reload 后 banner 呈现。

### Task 7: 集成 + 全量门禁
**Files**: 集成测试（崩溃/断线/损坏）+ ipc-security 扩展（白名单 73→74 + getLastCrash 断言）+ typecheck/lint/build/test:integration + check:contract + verify:sensitive
**TDD**：全量门禁收敛。

### Task 8: 文档同步
**Files**: doc 01（崩溃/网络/损坏）、doc 04/07（安全面）、doc 10 §10（7B 状态）、doc 16 §10（7B 状态 + 进度表）、doc 11（设置页崩溃提示）、doc 12、doc 13（cross-review）、doc 17（mock 断线 env）、README、CLAUDE.md
**交付**：7B 状态注记 + 决策记录 + 门禁计数。

---

## 7. 验收标准（doc 16 §10 验收门槛映照）

| doc 16 验收 | 7B 落点 |
|---|---|
| 网络中断 | 断线浏览历史 + 草稿断线自动持久化 + replay 恢复（回归集） |
| Renderer 崩溃 | 崩溃检测 + 提示 + reload + 审计 |
| 缓存损坏 | 统一层 + 各 store 损坏不崩溃（单测钉住） |
| GPU 上下文恢复 | Live2D 渲染层核对（阶段5批次C）+ GPU 进程级兜底 |
| 主链路异常可恢复或安全失败 | 崩溃 reload + 断线可达离线只读 |

---

## 8. 已知限制 / 接受档

- **Renderer 全局错误兜底（errorHandler/error boundary）**：本批**不做 UI 级 error boundary**（只做进程崩溃）。JS 异常兜底保留为观察项——若 7B 实测 renderer JS 异常多，7C/D 再评估。
- **崩溃二次触发**：`render-process-gone` 在 reload 后若再崩，会再触发一次 reload。本批**不做崩溃风暴抑制**（每次崩溃 reload 一次；若连续崩，用户可到连接面板手动处置）。防无限 reload 由 Main 侧「reload 后检查 webContents 是否存活 + crashMarker 一次性清空」兜底。
- **getLastCrash 一次性**：`getLastCrash` 读一次后清空 marker——防 reload 后每次启动都提示（除非再次崩溃）。崩溃 marker 为内存态（模块级变量），进程重启即失，不做持久化（避免事故后永远提示）。
- **GPU 崩溃不自动 reload**：GPU 崩溃留痕不 reload（Live2D 层经 webglcontextlost 间接 recover）；若 GPU 反复崩导致 Live2D 不可用，7C 性能批再评估。
- **崩溃提示非实时 push**：崩溃提示是 reload 后由新 Renderer 经 `getLastCrash` 读取显示，**非崩溃瞬间的实时 banner**（renderer 已死收不到 push——安全 H-2 定案）。

---

## 9. 文档同步清单（Task 8 核验）

doc 01（崩溃/网络/损坏）/04（安全面）/06（**状态管理与本地存储——7B 的损坏统一层 + 草稿断线持久化 + live2d GPU lost 全落其领域**，一致性 MED 补）/07（安全面 + doc 07 §17 发布安全门槛**必须核对**崩溃面/GPU 面/损坏隔离条目）/10 §10（7B 状态）/11（全局崩溃提示——注记仅全局错误提示，**不改设置页结构**）/12/13（cross-review）/16 §10（7B 状态 + 进度表）/17（mock 断线 env `CYRENE_MOCK_DISCONNECT_AFTER_MS`）+ README + CLAUDE.md 状态段 + 决策记录 + spec §5.1（若新增规则）+ 安全发布清单核对（doc 07 §17 **加**崩溃/GPU/损坏面——非「若有」，必核）。

**三态声明**：本批 = 代码批，Mock 驱动，**三态 = 已开发、未联调**；真实 Windows Electron 联调为批次后。

---

## 10. 参考

- Explore 摸底报告（`a0e6fee44bf275fc8`）+ 主会话独立核实。
- 阶段 7 批次 A spec/plan（`docs/superpowers/specs|plans/2026-08-22-phase7-batcha-security-convergence-*`）。
- 阶段 5 批次 C spec（`docs/superpowers/specs/2026-08-18-phase5-live2d-batchc-closure-design.md`）——GPU 链路。
- doc 16 §10、doc 10 §10.1、`docs/review/2026-08-22-阶段7批次A-决策记录.md` §8。
