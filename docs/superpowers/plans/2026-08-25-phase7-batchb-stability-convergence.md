# 阶段 7 批次 B（7B 稳定性收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实 7B 稳定性收敛四面——Renderer 崩溃恢复（检测+marker+reload+审计）、网络断线草稿/ mock 断线模拟、缓存损坏统一层、GPU 进程级兜底。

**Architecture:** 主进程崩溃监听（render-process-gone 2 参回调 + child-process-gone main() 内注册）→ crashMarker 持久化 → reload 后 Renderer 经 getLastCrash invoke 读取显示提示；草稿断线 flush(cid)+mock disconnectAfterMs；createCorruptIsolation 骨架（isolate 带 safeRoot + Logger 同构）各 store 语义保留；child-process-gone GPU 审计 gpu:crash 不 reload。

**Tech Stack:** Electron 43.3.0 / Vue 3 / TypeScript / Vitest（单元 + Electron 集成）/ zod / pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-25-phase7-batchb-stability-convergence-design.md`（386 行，2 轮 review 通过——plan 从 spec 论证）

## Global Constraints

- **三态**：本批 = 代码批，Mock 驱动，**三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后）。
- **render-process-gone 回调是 2 参** `(_ev, details)`——`win.webContents`（`WebContents` 类）的真实签名为 2 参（Electron 43 electron.d.ts:17304）；3 参 `(event, webContents, details)` 属 `interface App`（electron.d.ts:700），非 WebContents 事件。`child-process-gone` 回调也是 2 参 `(_ev, details)`。**本批按真实 2 参实现**（Task 2 已核；early spec/plan 的「3 参」为 H-1 定位偏差——本文档后续已一并修正）。
- **audit type 解耦**：renderer 崩溃 `renderer:crash`、GPU 崩溃 **`gpu:crash`**（勿共用 `'renderer:crash'`——契约 H-1）。
- **崩溃提示非实时 push**：Renderer 已死收不到 push——崩溃提示 = crashMarker + reload 后 `getLastCrash` invoke 读取（一次性清空）。
- **正文零泄露**：崩溃载荷 `{reason, exitCode}` 仅元数据；草稿正文写 drafts-v1.json 是合法持久化（非日志/非诊断导出）；`.corrupt-*` 备份不纳入导出/传输——**行为半：`isolate()` 须实现 `pruneCorrupt` 有界保留**（HIGH-1，spec 安全 MED-4「只留最新一份」）+ **文档半：doc 01/07 注明 `.corrupt` 不纳入导出**。
- **凭据 fail-closed 不拉平**：credentials 的 UNSUPPORTED_VERSION throw 保留，`isolate()` 不接管语义决策。
- **isTrustedSender 不导出**：崩溃走 invoke `diagnostics:last-crash`（createIpcHandler 双端），不走裸 push（无需导出 registry.ts:27）。
- 既有约定的 ZodType 注解 + `.strict()`、preload `on*` 返回 `() => void`、审计 fail-open（C1）、`ipcChannels.ts:24` 链式注释同步、mock env 走 useMock 门控（**CYRENE_MOCK_DISCONNECT_AFTER_MS——Task 4 已接线，useMock 门控**）。
- **D7B-01**：临时附件/录音文件磁盘清理 → 7D（本批不做）。**D7B-02**：崩溃 = 检测+提示+安全 reload。**D7B-03**：缓存损坏 = 统一骨架 + 语义可配。**D7B-04**：网络 = 断线浏览历史 + 草稿自动保存（不改发送状态机）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `shared/contracts/diagnostics.ts` | +RendererCrashEvent 类型 + DIAGNOSTICS_* 常量 |
| `shared/contracts/ipc.ts` | +IpcChannels.diagnosticsLastCrash invoke；PushChannels.rendererCrash 占位 |
| `shared/schemas/ipc-response.ts` | +RendererCrashEventSchema（z.ZodType + reason enum + int + strict） |
| `preload/index.d.ts` / `desktop-api.ts` | +getLastCrash |
| `main/windows/main-window.ts` | +render-process-gone 监听 + 模块级 sink + crashMarker |
| `main/index.ts` | +child-process-gone（main 内）+getLastCrash handler+装配 sink |
| `main/persistence/corrupt-isolation.ts` | 新：createCorruptIsolation 骨架 |
| `main/settings/settings-service.ts` | isolate 采用（备份名迁移 + 补 countDiagnostic） |
| `main/credentials/credential-store.ts` | 决策单列：是否备份+重建 |
| `main/persistence/session-store.ts` | isolate+dropInvalid |
| `renderer/src/stores/draft.store.ts` | flush 已存在（断线触发） |
| `renderer/src/stores/message.store.ts` | +useDraftStore import + handleConnectionStateChange flush(cid) |
| `main/transport/mock-backend.ts` | +disconnectAfterMs + error→connected + clearTimers |
| `renderer/src/components/CyRendererCrashBanner.vue` | 新：崩溃提示条（onMounted 自读 getLastCrash）；App.vue 挂载 |
| `renderer/src/App.vue` | +渲染 CyRendererCrashBanner（全局） |

---

### Task 1: 契约层（RendererCrashEvent schema + getLastCrash invoke + preload）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/diagnostics.ts`（+RendererCrashEvent 类型）
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（+IpcChannels.diagnosticsLastCrash；PushChannels.rendererCrash 占位）
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（+RendererCrashEventSchema）
- Modify: `apps/desktop/src/preload/index.d.ts`（+getLastCrash）、`apps/desktop/src/preload/desktop-api.ts`（+getLastCrash）
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`（+getLastCrash——**H1 修正：DesktopApiLike 手写窄接口缺该方法致 Task 3 vue-tsc 失败**）
- Test: `apps/desktop/tests/unit/renderer-crash-contracts.spec.ts`

**Interfaces:**
- Produces（Task 2/3 消费）:
  ```ts
  // shared/contracts/diagnostics.ts
  export type RendererCrashReason = 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure' | 'memory-eviction'
  export interface RendererCrashEvent { reason: RendererCrashReason; exitCode: number }
  ```
- IpcChannels 新键：`diagnosticsLastCrash: 'diagnostics:last-crash'`
- PushChannels 占位：`rendererCrash: 'renderer:crash'`（不发送、无 preload 订阅方法）
- schema（shared/schemas/ipc-response.ts）：
  ```ts
  export const RendererCrashEventSchema: z.ZodType<RendererCrashEvent> = z.object({
    reason: z.enum(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']),
    exitCode: z.number().int(),
  }).strict()
  ```
- preload：`getLastCrash(): Promise<RendererCrashEvent | null>`（invoke IpcChannels.diagnosticsLastCrash；响应 = RendererCrashEventSchema.nullable()）

- [ ] **Step 1: 写失败测试**

`tests/unit/renderer-crash-contracts.spec.ts`（node 环境）：

```ts
// tests/unit/renderer-crash-contracts.spec.ts（node）
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RendererCrashEventSchema } from '../../src/shared/schemas/ipc-response'
import { IpcChannels, PushChannels } from '../../src/shared/contracts/ipc'
import type { RendererCrashEvent } from '../../src/shared/contracts/diagnostics'

describe('RendererCrashEventSchema（strict + reason 闭合枚举 + exitCode int）', () => {
  const base: RendererCrashEvent = { reason: 'crashed', exitCode: 1 }
  it('合法条目', () => {
    expect(RendererCrashEventSchema.safeParse(base).success).toBe(true)
    expect(RendererCrashEventSchema.safeParse({ ...base, reason: 'oom' }).success).toBe(true)
  })
  it('未知 reason 拒（闭合枚举）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, reason: 'garbage' }).success).toBe(false)
  })
  it('exitCode 非整数拒（.int()）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, exitCode: 1.5 }).success).toBe(false)
  })
  it('未知键拒（strict）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, content: 'x' }).success).toBe(false)
  })
})

describe('IpcChannels.diagnosticsLastCrash（invoke）+ PushChannels.rendererCrash 占位', () => {
  it('invoke 键值 + push 占位', () => {
    expect(IpcChannels.diagnosticsLastCrash).toBe('diagnostics:last-crash')
    expect(PushChannels.rendererCrash).toBe('renderer:crash')
  })
  it('renderer:crash 不入 IpcChannels invoke 枚举（纯 push 占位）', () => {
    expect(Object.values(IpcChannels)).not.toContain('renderer:crash')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/renderer-crash-contracts.spec.ts`
Expected: FAIL——`RendererCrashEventSchema`/`diagnosticsLastCrash` 不存在（module exports 缺失）。

- [ ] **Step 3: 实现**

**3a. `shared/contracts/diagnostics.ts`** 追加（文件尾）：
```ts
export type RendererCrashReason = 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure' | 'memory-eviction'
export interface RendererCrashEvent { reason: RendererCrashReason; exitCode: number }
```

**3b. `shared/contracts/ipc.ts`** IpcChannels 追加（尾随注释）：
```ts
  diagnosticsLastCrash: 'diagnostics:last-crash',    // 阶段 7 批次 B：读取最近 Renderer 崩溃 marker（invoke，一次性——读后清空）
```
PushChannels 追加（占位——不发送、无 preload 订阅方法）：
```ts
  rendererCrash: 'renderer:crash',   // 阶段 7 批次 B：Renderer 崩溃推送占位（不实际发送——Render 已死收不到；实际走 getLastCrash invoke）
```

**3c. `shared/schemas/ipc-response.ts`** 追加（沿用既有镜像范式 + z.ZodType 注解 + strict）：
```ts
export const RendererCrashEventSchema: z.ZodType<RendererCrashEvent> = z.object({
  reason: z.enum(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']),
  exitCode: z.number().int(),
}).strict()
```

**3d. `preload/desktop-api.ts`** 追加（invoke 方向，非订阅——用 invoke + unwrap；参考 diagnosticsState :435-437 的 invoke 模式）：
```ts
async function getLastCrash(): Promise<RendererCrashEvent | null> {
  return unwrap(await invoke<RendererCrashEvent | null>(IpcChannels.diagnosticsLastCrash), RendererCrashEventSchema.nullable())
}
```
（`desktopApi` 对象 `:533-620` 装配处 + `index.d.ts` 类型加 `getLastCrash(): Promise<RendererCrashEvent | null>`。）

**3e. `renderer/src/stores/desktop-api.types.ts`**（H1 修正——`DesktopApiLike` 手写窄接口，非 `typeof desktopApi`；`api.getLastCrash()` 在 banner 组件调用需该 type，否则 vue-tsc 失败）：
```ts
// 在 DesktopApiLike 内（对齐 onDiagnosticsDevEvent 位置）加：
getLastCrash(): Promise<RendererCrashEvent | null>
// 顶部 import type { RendererCrashEvent } from '@shared/contracts'（若未导入）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/renderer-crash-contracts.spec.ts`
Expected: PASS（双 spec）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/diagnostics.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/tests/unit/renderer-crash-contracts.spec.ts
git commit -m "feat(阶段7批次B): Task1 崩溃契约层——RendererCrashEvent 类型 + schema（reason 枚举/int/strict）+ diagnosticsLastCrash invoke + rendererCrash 占位 + getLastCrash preload + DesktopApiLike 类型（TDD）"
```

---

### Task 2: 主进程崩溃监听（render-process-gone 2 参 + crashMarker + 审计 + reload）

**Files:**
- Modify: `apps/desktop/src/main/windows/main-window.ts`（+render-process-gone 2 参监听 + 模块级 logger/audit sink + crashMarker + getCrashMarker）
- Modify: `apps/desktop/src/main/index.ts`（+child-process-gone main() 内调 handleChildProcessGone + 装配 setCrashSink）
- Modify: `apps/desktop/src/main/ipc/diagnostics-handlers.ts`（+getLastCrash handler，直 import getCrashMarker——准确性 MED-1 + re-review N1 定案：免 handlers.ts 线程化）
- Test: `apps/desktop/tests/unit/renderer-crash-handler.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `IpcChannels.diagnosticsLastCrash`、`RendererCrashEvent`、`PushChannels.rendererCrash`
- Produces: `main-window.ts` 模块级 `setCrashSink({ logger, audit })`（**无 onRendererGone**——LOW-2 死成员移除）+ `getCrashMarker()`；`index.ts` 的 `handleChildProcessGone`（迁 Task 6 抽函数）；diagnostics-handlers 的 getLastCrash handler

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/renderer-crash-handler.spec.ts（node——注入 fake webContents 测崩溃逻辑）
import { describe, expect, it, vi } from 'vitest'
// 测崩溃回调逻辑：对 createMainWindow 的 render-process-gone 监听，用注入的 fake win.webContents 触发。
// 注：main-window.ts 依赖 electron 真实对象，单测经注入 fake（构造 win 时传 fake webContents）。
// 具体实现：createMainWindow 签名不变，但崩溃监听读模块级 crashSink（logger/audit——无 onRendererGone）与 crashMarker。
```

（单测聚焦：`clean-exit` 不触发 audit；`crashed` 触发 audit + marker 写入 + reload 调用；2 参回调正确读 details。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/renderer-crash-handler.spec.ts`
Expected: FAIL——崩溃监听未存在。

- [ ] **Step 3: 实现**

**3a. `main/windows/main-window.ts`** 模块级注入 sink（安全 MED-2：所有窗口创建路径共享，非 per-opts；**LOW-2 去 onRendererGone 死成员**）：
```ts
// —— 阶段 7 批次 B（D7B-05/08）：崩溃留痕 sink + crashMarker——模块级注入（安全 MED-2：second-instance/activate focusOrDefer 不带 opts，
//    per-opts 会丢——提升为模块级变量，所有创建路径共享）——
let crashSink: { logger?: Logger; audit?: (e: Omit<AuditEvent, 'ts'>) => void } = {}
export function setCrashSink(sink: typeof crashSink): void { crashSink = sink }
let crashMarker: { reason: string; exitCode: number; ts: number } | null = null
export function getCrashMarker(): { reason: string; exitCode: number } | null { const m = crashMarker; crashMarker = null; return m ? { reason: m.reason, exitCode: m.exitCode } : null }  // 一次性读后清
```

**3b. `main/windows/main-window.ts`** 崩溃监听（before-input-event 之后）：
```ts
// D7B-05/D7B-07：Renderer 崩溃——检测 + 持久化 marker + 自动 reload + 审计。
// 注意：win.webContents（WebContents 类）的 render-process-gone 回调是 2 参（_ev, details）——details 是第 2 参（Electron 43 electron.d.ts:17304；3 参属 App 接口，H-1 定位偏差已修正）。
win.webContents.on('render-process-gone', (_ev, details) => {
  if (details.reason === 'clean-exit') return  // 正常关窗退出，不处理
  crashSink.logger?.warn('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
  crashSink.audit?.({ type: 'renderer:crash', summary: `渲染进程异常：${details.reason} (exit ${details.exitCode})` })
  crashMarker = { reason: details.reason, exitCode: details.exitCode, ts: Date.now() }  // D7B-05 修正：renderer 已死收不到 push——marker 供 reload 后 getLastCrash 读
  setTimeout(() => { if (!win.isDestroyed() && win.webContents) win.webContents.reload() }, 300)  // D7B-06/07
})
```

**3c. `main/index.ts`** child-process-gone（**main() 内注册**——安全 MED-1，audit/diagnostics 为 main() 局部；**LOW-3 职责归属：本 Task 2 只做 child-process-gone 注册回调，抽函数 `handleChildProcessGone` 供 Task 6 单测**）+ **getLastCrash handler 落 `main/ipc/diagnostics-handlers.ts`**（准确性 MED-1：index.ts 未 import singular `registerHandler`/`createIpcHandler`/`z`——handler 并入该已 import schema + createIpcHandler 的文件，index.ts 经 `registerHandlers` deps 注入）：
```ts
// main() 内部、diagnostics(129)/audit(131) 定义之后：
app.on('child-process-gone', (_ev, details) => handleChildProcessGone(details, { logger: diagnostics.logger, audit }))
// handleChildProcessGone 抽出（供 Task 6 gpu-process.spec 单测）：
export function handleChildProcessGone(details: { type: string; reason: string; exitCode: number }, deps: { logger: Logger; audit: (e: Omit<AuditEvent,'ts'>)=>void }): void {
  if (details.type === 'GPU') {
    deps.logger.warn('gpu-process-gone', { reason: details.reason, exitCode: details.exitCode })
    deps.audit({ type: 'gpu:crash', summary: `GPU 进程异常：${details.reason} (exit ${details.exitCode})` })  // 契约 H-1 解耦
  }
}
// getLastCrash handler：在 main/ipc/diagnostics-handlers.ts 内（re-review R1 修正：**diagnostics-handlers 直接 import getCrashMarker**——最简，免 handlers.ts 线程化摇摆）：
//   import { getCrashMarker } from '../windows/main-window'
//   registerHandler(IpcChannels.diagnosticsLastCrash, createIpcHandler(z.undefined(), RendererCrashEventSchema.nullable(), () => getCrashMarker()))
//   （diagnostics-handlers.ts 已 import z/createIpcHandler/registerHandler——无需动 handlers.ts/index.ts 的 registerHandlers deps）
// setCrashSink({ logger: diagnostics.logger, audit }) 在装配时调用（main-window 模块级 sink——无 onRendererGone，crashMarker 内部写；实际 getCrashMarker 由 main-window 导出）。
```

**注意**：crashMarker 的写入在 main-window.ts（render-process-gone 监听内），getCrashMarker 也在 main-window.ts（读后清）。index.ts/getLastCrash handler 只调 getCrashMarker()。`setCrashSink` 只存 logger/audit（**无 onRendererGone**——死成员，LOW-2）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/renderer-crash-handler.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/windows/main-window.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/diagnostics-handlers.ts apps/desktop/tests/unit/renderer-crash-handler.spec.ts
git commit -m "feat(阶段7批次B): Task2 主进程崩溃监听——render-process-gone 2 参 + crashMarker + 审计 + reload；child-process-gone handleChildProcessGone（抽函数）+ getLastCrash handler 落 diagnostics-handlers（直 import getCrashMarker）（TDD）"
```

---

### Task 3: 崩溃提示 UI（reload 后读 marker）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyRendererCrashBanner.vue`
- Modify: `apps/desktop/src/renderer/src/App.vue`（挂载 banner，全局）
- Test: `apps/desktop/tests/unit/cy-renderer-crash-banner.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `getLastCrash()`（preload）、`RendererCrashEvent` 类型

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/cy-renderer-crash-banner.spec.ts（// @vitest-environment happy-dom——准确性 MED-2：banner 组件渲染需 DOM）
// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CyRendererCrashBanner from '../../src/renderer/src/components/CyRendererCrashBanner.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'

// 注入 mock api.getLastCrash——先例 cy-diagnostics-pane.spec.ts:11/80（setDesktopApi 注入 + cast）
function setupApi(lastCrash: { reason: string; exitCode: number } | null): void {
  setDesktopApi({ getLastCrash: vi.fn(async () => lastCrash) } as unknown as Parameters<typeof setDesktopApi>[0])
}
beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

describe('CyRendererCrashBanner', () => {
  it('getLastCrash 返回 marker → 显示「页面已重启」', async () => {
    setupApi({ reason: 'crashed', exitCode: 1 })
    const wrapper = mount(CyRendererCrashBanner)
    await vi.waitFor(() => { expect(wrapper.find('.cy-crash-banner').exists()).toBe(true) })
    expect(wrapper.text()).toContain('页面已重启')
  })
  it('getLastCrash 返回 null → 不显示 banner', async () => {
    setupApi(null)
    const wrapper = mount(CyRendererCrashBanner)
    await vi.waitFor(() => { expect(wrapper.find('.cy-crash-banner').exists()).toBe(false) })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/cy-renderer-crash-banner.spec.ts`
Expected: FAIL——组件未存在。

- [ ] **Step 3: 实现**

**3a. `CyRendererCrashBanner.vue`**（新组件，复用断线横幅的呈现风格；onMounted 调 getLastCrash——**无 onUnmount 清理**：getLastCrash 是 invoke 一次性读，非订阅、无监听器注册，无需清理）：
```vue
<template>
  <div v-if="crash" class="cy-crash-banner" role="alert">
    <span>页面已重启，进行中的回复可能中断</span>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../stores/desktop-api'
const crash = ref<{ reason: string; exitCode: number } | null>(null)
onMounted(async () => {
  // D7B-05 修正：renderer 崩溃时收不到 push——改为 bootstrap 经 getLastCrash 读 marker（读后 Main 清空）
  try { crash.value = await api.getLastCrash() } catch { /* fail-open：读失败不显示 */ }
})
</script>
<style scoped>
.cy-crash-banner { position: sticky; top: 0; z-index: 50; background: #3a2a18; color: #f0c674; padding: 6px 12px; font-size: 13px; }
</style>
```

**3b. `renderer/src/main.ts`** 不动——banner 组件 onMounted 自读（本 plan 选组件自读，main.ts 不加 bootstrap 读点）。

**3c. `App.vue`** 挂载 banner：`<script setup>` 补 `import CyRendererCrashBanner from './components/CyRendererCrashBanner.vue'`（LOW-4 注记——易漏）+ `<template>` 顶层加 `<CyRendererCrashBanner />`（全局，不随 view 切换）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/cy-renderer-crash-banner.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/CyRendererCrashBanner.vue apps/desktop/src/renderer/src/App.vue apps/desktop/tests/unit/cy-renderer-crash-banner.spec.ts
git commit -m "feat(阶段7批次B): Task3 崩溃提示 UI——CyRendererCrashBanner reload 后 getLastCrash 读 marker（TDD）"
```

---

### Task 4: 网络——草稿断线自动持久化 + mock 断线模拟

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`（+useDraftStore import + handleConnectionStateChange 补 flush(cid)）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（+disconnectAfterMs + error→connected 恢复 + clearTimers 登记 + parseMockDisconnectAfterMsEnv）
- Modify: `apps/desktop/src/main/index.ts`（**MED-1/M5 修正：env 桥接线——`parseMockDisconnectAfterMsEnv` + useMock 门控传入 MockBackend**）
- Test: `apps/desktop/tests/unit/draft-persist.spec.ts`、`apps/desktop/tests/unit/mock-disconnect.spec.ts`

**Interfaces:**
- Consumes: `draft.store.ts` 的 `flush(conversationId)`；`conversation.store.ts` 的 `currentId`
- Produces: `mock-backend` 的 `disconnectAfterMs` 选项 + error→connected 恢复

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/draft-persist.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { useDraftStore } from '../../src/renderer/src/stores/draft.store'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'

describe('断线草稿自动持久化', () => {
  it('handleConnectionStateChange 断线 → 调 draftStore.flush(cid)', () => {
    // stub draftStore.flush（vi.fn）+ conversationStore.currentId = 'c1'
    // 触发 messageStore.handleConnectionStateChange({ status: 'error' })
    // 断言 flush 被调 + 参数 'c1'
  })
  it('断线且 currentId undefined → 不调 flush', () => {
    // stub → currentId = undefined → handleConnectionStateChange({ status: 'error' })
    // 断言 flush 未被调
  })
})
```

```ts
// tests/unit/mock-disconnect.spec.ts
import { describe, expect, it, vi } from 'vitest'

describe('mock-backend 断线模拟', () => {
  it('disconnectAfterMs 到期 → error 态 + 手动 connect 恢复 connected', async () => {
    // new MockBackend({ disconnectAfterMs: 10, ...deps }); connect()
    // 等 > 10ms → getConnectionState() 返回 { status: 'error', lastError: 'mock-disconnect' }
    // connect() 再次 → { status: 'connected' }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/draft-persist.spec.ts tests/unit/mock-disconnect.spec.ts`
Expected: FAIL——flush 未接 + disconnectAfterMs 未实现。

- [ ] **Step 3: 实现**

**3a. `message.store.ts`** 新增 useDraftStore import + handleConnectionStateChange 补 flush：
```ts
// 新增 import（可行性 M-1：无循环依赖——draft.store 只依赖 desktop-api 与契约）
import { useDraftStore } from './draft.store'
// handleConnectionStateChange 开头（清理 local-* 之前）补：
const cid = useConversationStore().currentId
if (cid) void useDraftStore().flush(cid)  // H-3 修正：flush 必传 conversationId；断线时 currentId 保留
```
（`useConversationStore` 需已导入；若未导入则加 import。）

**3b. `mock-backend.ts`** 新增 connect/disconnect 的状态机 + disconnectAfterMs + error→connected + parseMockDisconnectAfterMsEnv：
```ts
// 构造 options 加 disconnectAfterMs?: number
private disconnectTimer?: ReturnType<typeof setTimeout>
connect(): this.connected = true; this.onConnectionStateChange?.({ status: 'connected' }); if (this.disconnectAfterMs) { this.disconnectTimer = setTimeout(() => this.simulateDisconnect(), this.disconnectAfterMs) }
private simulateDisconnect(): this.connected = false; this.onConnectionStateChange?.({ status: 'error', lastError: 'mock-disconnect' })
getConnectionState(): { status: this.connected ? (this.errored ? 'error' : 'connected') : 'disconnected', ... }
// 手动 reconnect：connect() 重置 errored=false + 发 connected
clearTimers() 加清 disconnectTimer（防 dispose 悬挂）
// env 桥（MED-1/M5 修正）：exports parseMockDisconnectAfterMsEnv（走既有 parseMock*Env 模式，如 parseMockHistoryCountEnv）
export function parseMockDisconnectAfterMsEnv(v: string | undefined): number | undefined {
  if (!v) return undefined; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined
}
```
（实现细节：加私有 `errored` 布尔；`connect()` 成功置 errored=false；`simulateDisconnect()` 置 errored=true + connected=false。`getConnectionState` 返回 `{ status: errored ? 'error' : connected ? 'connected' : 'disconnected', lastError: errored ? 'mock-disconnect' : undefined, serverUrl }`。）

**3c. `index.ts`** env 桥接线（useMock 门控——真实模式不注入）：
```ts
// 装配处（同其它 parseMockXxxEnv，index.ts:154-184 区）：
const mockDisconnectAfter = parseMockDisconnectAfterMsEnv(process.env.CYRENE_MOCK_DISCONNECT_AFTER_MS)
// MockBackend 构造：useMock ? { disconnectAfterMs: mockDisconnectAfter, ... } : undefined（真实模式 undefined）
```
（`parseMockDisconnectAfterMsEnv` 从 mock-backend import；仿 `parseMockToolAllowRootEnv`（useMock ? … : undefined）门控——真实模式不注入 env。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/draft-persist.spec.ts tests/unit/mock-disconnect.spec.ts`
Expected: PASS（双 spec）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/draft-persist.spec.ts apps/desktop/tests/unit/mock-disconnect.spec.ts
git commit -m "feat(阶段7批次B): Task4 网络——草稿断线自动持久化 flush(cid) + mock disconnectAfterMs/error→connected 恢复 + CYRENE_MOCK_DISCONNECT_AFTER_MS env 桥（useMock 门控）（TDD）"
```

---

### Task 5: 缓存损坏统一层

**Files:**
- Create: `apps/desktop/src/main/persistence/corrupt-isolation.ts`
- Modify: `apps/desktop/src/main/settings/settings-service.ts`（isolate 采用 + 备份名迁移 + 补 countDiagnostic）
- Modify: `apps/desktop/src/main/credentials/credential-store.ts`（**决策单列**：是否备份+重建）
- Modify: `apps/desktop/src/main/persistence/session-store.ts`（isolate+dropInvalid，**移除既有 countDiagnostic 防双计数**——准确性 MED-3）
- Modify: `apps/desktop/src/main/index.ts`（**MED-2/M2 修正：SettingsService 装配补 countDiagnostic 注入**）
- Test: `apps/desktop/tests/unit/corrupt-isolation.spec.ts`、`apps/desktop/tests/unit/settings-service.spec.ts`（更新断言）

**Interfaces:**
- Produces: `createCorruptIsolation(deps)` 返回 `{ isolate(file, tag, safeRoot?), dropInvalid(code) }`
- Consumes: settings/credentials/session-store 采用

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/corrupt-isolation.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCorruptIsolation } from '../../src/main/persistence/corrupt-isolation'

function makeDeps() {
  return { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, countDiagnostic: vi.fn() }
}

describe('createCorruptIsolation 骨架', () => {
  it('isolate 正常隔离 → .corrupt-<tag>-<ts> 备份 + countDiagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-')); const f = join(dir, 'x.json'); writeFileSync(f, 'bad')
    const iso = createCorruptIsolation(makeDeps())
    const dest = await iso.isolate(f, 'settings', dir)
    expect(dest).toContain(`x.json.corrupt-settings-`); expect(existsSync(dest)).toBe(true); expect(existsSync(f)).toBe(false)
    expect(iso.depsCount()).toBe(1)  // 见注：deps.countDiagnostic 被调 1 次（persistence:corrupt-isolated）
  })
  it('isolate 带 safeRoot 负例——传安全根外路径应拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-')); const iso = createCorruptIsolation(makeDeps())
    await expect(iso.isolate('/etc/passwd', 'x', dir)).rejects.toThrow()
  })
  it('dropInvalid 计数', () => {
    const d = makeDeps(); const iso = createCorruptIsolation(d)
    iso.dropInvalid('cache:drop-invalid')
    expect(d.countDiagnostic).toHaveBeenCalledWith('cache:drop-invalid')
  })
  it('pruneCorrupt 只留最新一份（HIGH-1）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-')); const f = join(dir, 'x.json')
    writeFileSync(f + '.corrupt-settings-aaa', 'a'); writeFileSync(f + '.corrupt-settings-bbb', 'b'); writeFileSync(f + '.corrupt-settings-ccc', 'c')
    const iso = createCorruptIsolation(makeDeps())
    await iso.pruneCorrupt(f, 'settings')
    const left = readdirSync(dir).filter((n) => n.includes('.corrupt-settings-'))
    expect(left).toEqual(['x.json.corrupt-settings-ccc'])  // 只留最新（字典序最大）
  })
})
```
（注：`depsCount()` 为测试辅助——`makeDeps` 返回的 `countDiagnostic` mock，经 `vi.mocked(d.countDiagnostic).mock.calls.length` 断言；实现时用 `expect(vi.mocked(deps.countDiagnostic).mock.calls.length).toBe(1)` 替代。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/corrupt-isolation.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

**3a. `main/persistence/corrupt-isolation.ts`**（新骨架 + HIGH-1 修正——`.corrupt-*` 有界保留「只留最新一份」）：
```ts
import { rename, readdir, unlink } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import type { Logger } from '../diagnostics/logger'  // 契约 M-3：复用真实 Logger

export interface CorruptIsolationOpts {
  logger: Logger
  countDiagnostic(code: string): void
}
export interface CorruptIsolation {
  isolate(file: string, tag: string, safeRoot?: string): Promise<string>
  dropInvalid(code: string): void
  /** HIGH-1（安全 MED-4 修法）：有界保留——下次成功 load() 时清同 tag 旧 `.corrupt-*`（只留最新一份）。deleteOld=true 时调用 */
  pruneCorrupt(file: string, tag: string): Promise<void>
}
function nowIso(): string { return new Date().toISOString().replace(/[:.]/g, '-') }
async function assertContained(file: string, safeRoot: string): Promise<void> {
  const real = await realpath(file); const rel = real.startsWith(safeRoot) ? real.slice(safeRoot.length) : real
  if (rel.startsWith('..') || rel.includes('..') || !real.startsWith(safeRoot)) throw new Error(`isolate 目标逃逸安全根: ${file}`)
}
export function createCorruptIsolation(deps: CorruptIsolationOpts): CorruptIsolation {
  return {
    async isolate(file, tag, safeRoot) {
      if (safeRoot) await assertContained(file, safeRoot)  // 安全 MED-3：safeRoot 必传则校验
      const dest = `${file}.corrupt-${tag}-${nowIso()}`
      await rename(file, dest).catch(() => {})  // 隔离保留现场，不污染后续写入
      deps.countDiagnostic('persistence:corrupt-isolated')
      return dest
    },
    dropInvalid(code) { deps.countDiagnostic(code) },
    async pruneCorrupt(file, tag) {
      // HIGH-1 修法：清同 tag 旧 `.corrupt-<tag>-<ts>`，只留最新一份（本次 isolate 的 dest 除外）
      const dir = file.slice(0, file.lastIndexOf('/'))  // 同目录；Windows 用 '\\' 亦兼容（lastIndexOf 双分隔符）
      const prefix = `${file.slice(file.lastIndexOf('/') + 1)}.corrupt-${tag}-`
      try {
        const entries = await readdir(dir)
        const targets = entries.filter((n) => n.startsWith(prefix)).sort()  // ts 字典序 ≈ 时间序
        for (const n of targets.slice(0, -1)) await unlink(`${dir}/${n}`).catch(() => {})  // 留最新
      } catch { /* 目录不存在：no-op */ }
    }
  }
}
```

**3b. `settings-service.ts`** 采用 isolate（备份名迁移 + 补 countDiagnostic + pruneCorrupt）：
```ts
// deps 加 countDiagnostic（MED-2/M2：SettingsServiceDeps 加字段；index.ts:266 new SettingsService 装配处同步传——Task 5 Files 已列 index.ts）
// load() 成功路径末尾：await isolation.pruneCorrupt(this.file, 'settings')  // HIGH-1 有界保留
// load() catch 分支替换：await isolation.isolate(this.file, 'settings', this.deps.safeRoot) → 回 DEFAULT_SETTINGS
// 备份名从 .corrupt → .corrupt-settings-<ts>；同步 settings-service.spec.ts 全部 4 处 .corrupt 断言：
//   :64/:65/:74（existsSync/readFileSync 断言 .corrupt 存在）→ 改 .corrupt-settings 前缀匹配；
//   :93（非 corrupt 路径 .corrupt 不存在）→ 改 .corrupt-settings 对应断言（MED-1 完整性：非只 64/65）
//   :66 logger.warn('settings:corrupt-isolated',…) 断言保留（isolate 化后该 warn 由骨架/调用方承担，需复验调用点）
```

**3c. `credentials/credential-store.ts`**——**决策单列**：是否从「重建 createEmptyFile」改为「备份损坏文件 + 重建」。若改，在 catch 分支 `await isolation.isolate(file, 'credentials', safeRoot)` 后重建（**version 不匹配仍 throw** 不归 isolate 管）。若不改，保持现状（不纳入统一层）——**以 Task 实现时确认 + 记录**。

**3d. `session-store.ts`** 采用 isolate+dropInvalid（**准确性 MED-3：移除既有 countDiagnostic 防双计数**）：
```ts
// readFile catch 分支：await isolation.isolate(file, 'session', safeRoot)（备份名 .corrupt-session-<ts>）
//   移除原有的 deps.countDiagnostic('persistence:corrupt-isolated')（:109）——isolate 内部已计数，防双计数
// load() 成功路径末尾：await isolation.pruneCorrupt(file, 'session')  // HIGH-1 有界保留
// 条目级 safeParse 失败：dropInvalid('draft:drop-invalid' / 'cache:drop-invalid' / ...)
```

**注意**：tool-history **不套统一层**（读目录纯函数，断行跳过内建——spec §4C.2）。credentials 的决策（改/不改）作为 Task 5 的一个**实现注记**记录，跟随 spec 的「需单独确认语义」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/corrupt-isolation.spec.ts tests/unit/settings-service.spec.ts`
Expected: PASS（含 settings 断言更新后）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/persistence/corrupt-isolation.ts apps/desktop/src/main/settings/settings-service.ts apps/desktop/src/main/credentials/credential-store.ts apps/desktop/src/main/persistence/session-store.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/corrupt-isolation.spec.ts apps/desktop/tests/unit/settings-service.spec.ts
git commit -m "feat(阶段7批次B): Task5 缓存损坏统一层——createCorruptIsolation 骨架（isolate 带 safeRoot/Logger 同构 + pruneCorrupt 有界保留）+ settings/session-store 采用 + index.ts 装配 countDiagnostic，语义各自保留（TDD）"
```

---

### Task 6: GPU 进程级兜底 + 集成门禁

**Files:**
- Modify: `apps/desktop/src/main/index.ts`（+child-process-gone GPU，main() 内）
- Test: `apps/desktop/tests/integration/renderer-crash.spec.ts`、`apps/desktop/tests/integration/renderer-crash-banner.spec.ts`、`apps/desktop/tests/unit/gpu-process.spec.ts`

**Interfaces:**
- Consumes: Task 1/2 的 crash schema + getLastCrash；audit

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/gpu-process.spec.ts
import { describe, expect, it, vi } from 'vitest'
// handleChildProcessGone 已在 Task 2 从 index.ts 抽出（export function handleChildProcessGone(details, deps: { logger; audit })——见 Task 2 3c）。
// 本 Task 只消费它：测试注入 deps { logger, audit }（GPU 分支不 reload——reload 归 render-process-gone，故 deps 无 reload）。
import { handleChildProcessGone } from '../../src/main/index'

function makeDeps() {
  return { logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), flush: vi.fn(), close: vi.fn() }, audit: vi.fn() }
}
describe('child-process-gone GPU 兜底', () => {
  it('type==="GPU" → audit "gpu:crash" + 不 reload', () => {
    const deps = makeDeps()
    handleChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, deps)
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'gpu:crash' }))
  })
  it('type 非 GPU → 不处理', () => {
    const deps = makeDeps()
    handleChildProcessGone({ type: 'Utility', reason: 'crashed', exitCode: 1 }, deps)
    expect(deps.audit).not.toHaveBeenCalled()
  })
})
```
（注：`handleChildProcessGone` 由 Task 2 抽出（`index.ts` 导出），**本 Task 6 只消费它**——LOW-3 职责归属：Task 2 抽出逻辑，Task 6 补测试。deps 无 `reload`——GPU 分支不 reload（reload 归 render-process-gone）。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/gpu-process.spec.ts`
Expected: FAIL——child-process-gone GPU 分支未实现。

- [ ] **Step 3: 实现**

`child-process-gone` 的 `handleChildProcessGone` 函数已由 **Task 2** 从 index.ts 抽出（`app.on('child-process-gone', (_e, d) => handleChildProcessGone(d, { logger: diagnostics.logger, audit }))`——Task 2 3c）。**本 Task 6 只补消费 + 测试**（gpu-process.spec 注入 deps 测 handleChildProcessGone；集成测试触发渲染崩溃路径）。无重复实现。

**3a. `tests/integration/renderer-crash.spec.ts`**——集成崩溃（M4 补真实测试代码；launchApp 恒 mock；用 `webContents.forcefullyCrashRenderer()` 触发）：
```ts
// tests/integration/renderer-crash.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'
let app: ElectronApplication; let page: Page; let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })
describe('Renderer 崩溃 → crashMarker + reload 后 getLastCrash', () => {
  it('崩溃后 getLastCrash 返回 marker（reload 后新页面读）', async () => {
    // 触发渲染进程崩溃（reload 后新 renderer 读 marker）
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer() })
    // 等待 reload 完成 + 新页面就绪
    await expect.poll(async () => await page.evaluate(() => typeof window.desktopApi.getLastCrash === 'function')).toBe(true)
    const crash = await page.evaluate(() => window.desktopApi.getLastCrash())
    expect(crash).toBeTruthy()  // marker 存在（读后清空）
    expect(await page.evaluate(() => window.desktopApi.getLastCrash())).toBeNull()  // 一次性：二次读为 null
  })
})
```

**3b. `tests/integration/renderer-crash-banner.spec.ts`**——集成 banner（reload 后呈现）：
```ts
// tests/integration/renderer-crash-banner.spec.ts（同 3a 启动：launchApp + forcefullyCrashRenderer 触发）
describe('Renderer 崩溃 → reload 后 banner 呈现', () => {
  it('崩溃 reload 后 crash banner 可见', async () => {
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer() })
    await expect.poll(async () => await page.locator('.cy-crash-banner').count()).toBeGreaterThan(0)
    expect(await page.locator('.cy-crash-banner').textContent()).toContain('页面已重启')
  })
})
```
（注：`getLastCrash` 一次性读后清空 → 集成断言「第一次返回 marker、第二次 null」须在 reload 后新 renderer 完成 bootstrap 后再查；banner 断言同理。若 `forcefullyCrashRenderer` 在 mock 环境有副作用，用 `page.evaluate(() => window.desktopApi.getLastCrash())` 兜底验证 marker 路径。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/gpu-process.spec.ts tests/integration/renderer-crash.spec.ts tests/integration/renderer-crash-banner.spec.ts`
Expected: PASS（真实 Electron 集成用 xvfb）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/tests/unit/gpu-process.spec.ts apps/desktop/tests/integration/renderer-crash.spec.ts apps/desktop/tests/integration/renderer-crash-banner.spec.ts
git commit -m "feat(阶段7批次B): Task6 GPU 进程级兜底 + 崩溃集成门禁（gpu:crash 审计/renderer-crash 集成/banner 集成）（TDD）"
```

---

### Task 7: 集成 + 全量门禁

**Files:**
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`（白名单 73→74 + getLastCrash 断言 + renderer:crash 纯 push 断言）
- 跑全量：单测 + 集成 + typecheck/lint/build + check:contract + verify:sensitive

**Interfaces:**
- Consumes: Task 1~6 全部

- [ ] **Step 1: ipc-security 扩展**

`ipc-security.spec.ts`（**L3 修正：surface.keys 精确 `toEqual` 数组 :25-37 也要插入 `'getLastCrash'`——否则全量匹配必失败**）：
- 白名单 73→74（+getLastCrash）；**`:25-37` toEqual 数组按字母序插入 `'getLastCrash'`**（放在 `'getEndpoint'` 与 `'getMessageContext'` 之间）。
- 链式注释 `:24` 尾部追加「7B 加 getLastCrash → 74 键」。
- 仿 `:42-58` 加两条纯 push/invoke 断言 + `typeof window.desktopApi.getLastCrash === 'function'`：
  - `diagnostics:last-crash` 纯 invoke：`expect(PushChannels).not.toContain`（它不是 push——不入 PushChannels）+ `Object.values(IpcChannels)` 含 `'diagnostics:last-crash'` + `typeof window.desktopApi.getLastCrash === 'function'`。
  - `renderer:crash` 纯 push 占位：`expect(PushChannels.rendererCrash).toBe('renderer:crash')` + `Object.values(IpcChannels)` 不含 `'renderer:crash'`（无 preload 订阅方法）。

- [ ] **Step 2: 全量门禁**

Run（批次收口）：
```bash
pnpm -F @cyrene/desktop test        # 单测（含新增 renderer-crash/draft-persist/mock-disconnect/corrupt-isolation/gpu-process）
pnpm -F @cyrene/desktop test:integration   # 集成（xvfb）
pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop verify:sensitive
```
Expected: 单测（新增 ~22 用例——**N4 修正**：renderer-crash-contracts 6 / handler 4 / banner 2 / draft-persist 2 / mock-disconnect 2 / corrupt-isolation 4（isolate+负例+dropInvalid+pruneCorrupt）/ gpu-process 2，合计 22）+ 集成（新增 ~8）+ typecheck/lint/build 全 0 + check:contract（WS 35/35 + REST 16/16）+ verify:sensitive exit 0。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/tests/integration/ipc-security.spec.ts
git commit -m "feat(阶段7批次B): Task7 集成门禁——ipc-security 白名单 73→74 + getLastCrash 纯 invoke 断言 + 全量回归绿"
```

---

### Task 8: 文档同步

**Files:**
- Modify: `docs/01`（崩溃/网络/损坏）、`docs/04`（安全面）、`docs/06`（损坏统一层/草稿断线/live2d GPU lost）、`docs/07`（安全面 + doc 07 §17 崩溃/GPU/损坏条目）、`docs/10` §10（7B 状态）、`docs/11`（全局崩溃提示——注记不改设置页）、`docs/12`、`docs/13`（cross-review）、`docs/16` §10（7B 状态 + 进度表）、`docs/17`（mock 断线 env）、README、CLAUDE.md
- Create: `docs/review/2026-08-25-阶段7批次B-决策记录.md`、`docs/review/2026-08-25-阶段7批次B-验收.md`（验收 subagent 后）

**Interfaces:**
- Consumes: 全部实现 + 门禁计数

- [ ] **Step 1: 文档更新**

各 doc 补 7B 状态注记 + 决策记录（D7B-01~08/09 + 用户拍板 + review 记录 + 门禁计数）+ CLAUDE.md 状态段（7B 落盘 + 三态=已开发、未联调）+ README。

- [ ] **Step 2: 提交**

```bash
git add docs/ README.md CLAUDE.md
git commit -m "docs(阶段7批次B): 文档同步——7B 状态注记 + 决策记录 + 门禁计数（三态=已开发、未联调）"
```

---

## 验收标准（对应 spec §7）

| doc 16 验收 | 7B 落点 | 验证 |
|---|---|---|
| 网络中断 | 断线浏览历史 + 草稿断线 flush(cid) + mock 断线 error→connected | Task 4 单测 + 集成 |
| Renderer 崩溃 | 崩溃检测 + getLastCrash 读 marker + reload + 审计 renderer:crash | Task 2/3/6 单测 + 集成 |
| 缓存损坏 | createCorruptIsolation 骨架 + 各 store 损坏不崩溃 | Task 5 单测（含 safeRoot 负例） |
| GPU 上下文恢复 | Live2D 渲染层核对 + GPU 进程级 gpu:crash | Task 6 单测 + 集成 |
| 主链路异常可恢复或安全失败 | 崩溃 reload + 断线可达离线只读 | Task 2/3 集成 |

## 三态与已知限制

- **三态 = 已开发、未联调**（真实 Windows Electron 联调为批次后）。
- 已知限制：崩溃二次触发不做什么风暴抑制（每次崩溃 reload 一次）；getLastCrash 一次性（读后清空）；GPU 崩溃不自动 reload（Live2D 层 recover）；崩溃提示非实时 push（reload 后读 marker）。

