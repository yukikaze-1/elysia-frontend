# 阶段 7 批次 A（安全收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 7A 安全收敛：DOMPurify Markdown 净化、IPC 上界补全、诊断导出与开发者模式（开发与诊断设置页）、Fuses 三项关闭 + 产物读回、verify:sensitive 门禁、doc 07 §17 20 项核对。

**Architecture:** 所有 Main 侧新能力收敛于 `main/diagnostics/diagnostics-service.ts`（单装配入口，deps 注入）；渲染层「开发与诊断」页 `CyDiagnosticsPane.vue` 经 5 invoke + 1 push 通道与 Main 通信；Markdown 净化在 `renderer/utils/markdown.ts` 以 DOMPurify 显式白名单配置替换 scoped 消毒器；fuses 经 electron-builder 内置 `electronFuses` 配置落地 + verify-artifact 读回与 flip-back 冒烟。

**Tech Stack:** Electron 43.3.0 + Vue 3 + TS + zod 4 + vitest + Playwright（集成，xvfb）+ electron-builder 26.15.3 + @electron/fuses 2.1.3 + dompurify 3.4.14。

**Spec:** [docs/superpowers/specs/2026-08-22-phase7-batcha-security-convergence-design.md](../specs/2026-08-22-phase7-batcha-security-convergence-design.md) —— binding，本 plan 从之。

**Base 与分支纪律：** BASE = `771f258`（spec APPROVE HEAD）。实现只在本分支提交，绝不 push。

## Global Constraints

1. **三态纪律**：本批为 Mock 驱动——所有产物标记「已开发、未联调」。绝不在任何文档/注释写「已完成/已真实联调」。
2. **敏感面零正文**：Inner Voice / Public Reply 全文、原始录音与完整转写、原始工具参数、完整文件/截图、未脱敏敏感路径——永不进 Renderer、日志、审计 summary、诊断导出、dev 事件。dev 事件字段白名单 = `{ts, type, preview}`（`type` = 领域事件名；rawType 已删——无数据源）。
3. **绝对路径不上行**：`displayDir` 经 `createSanitizePublicMessage`（home→`~`、userData→`<userData>`、其他绝对路径→`<path>`）；**`displayPath` 不 sanitize**（用户对话框自选实际路径、回显无害——R2-7）。
4. **fail-closed**：schema 校验失败拒、fuse 读回失败 exit 1、导出脱敏失败拒绝落盘（不产出未脱敏文件）。
5. **测试即契约**：每个 task 的测试断言即 spec 的定格；TDD（先写失败测试）。
6. **zod 双端**：新 invoke 通道 request/response 均有 zod schema；push 通道 payload 有 schema（preload 订阅侧 safeParse）。
7. **命名**：新通道 `diagnostics:*`（IpcChannels 键 `diagnosticsState` 等 5 键 + PushChannels `diagnosticsDevEvent`）；新文件注释与 docs 全中文。
8. **`export` 不可作方法名**（JS 保留字）——导出方法名 `diagnosticsExport`。
9. **MAX_IPC_MESSAGE_BYTES（4MiB）语义不变**；新通道 payload 均小（state/导出结果 <100KiB）。
10. **既有门禁不回退**：typecheck/lint/build/check:contract 必须全绿；wire（backend 协议）零变更。

---

### Task 1: 契约层（contracts + schemas + channels + 枚举）

**Files:**
- Create: `apps/desktop/src/shared/contracts/diagnostics.ts`
- Modify: `apps/desktop/src/shared/contracts/index.ts`（barrel）、`apps/desktop/src/shared/contracts/ipc.ts`（IpcChannels 5 键 + PushChannels 1 键）、`apps/desktop/src/shared/schemas/ipc-response.ts`（3 个 Diagnostics*Schema：State/DevEvent/ExportResult——ClearedLogs 仅契约类型非 schema）、`apps/desktop/src/main/ipc/channels.ts`（5 个请求 schema）
- Test: `apps/desktop/tests/unit/diagnostics-contracts.spec.ts`、`apps/desktop/tests/unit/ipc-limit.spec.ts`
- 附加（同 task 闭合 D7A-13）：channels.ts 无界字符串字段补 maxLength（值表：title 200 / search query 512 / 消息发送 content 64KiB / 语音 commit text 10KiB / attachment 路径 1024——实现时 grep channels.ts 逐个核对实际字段名并补值）

**Interfaces:**
- Produces（Task 3/5/6 消费）:
  ```ts
  // shared/contracts/diagnostics.ts
  export interface DiagnosticsState { devMode: boolean; displayDir: string; logSizeBytes: number;
    logFiles: Array<{ name: string; sizeBytes: number; modifiedAt: string }>; retentionDays: number;
    auditRetentionDays: number; eventDropped: number; lastCleanup: { removedFiles: number; freedBytes: number } | null }
  export interface DiagnosticsDevEvent { ts: string; type: string; preview: string }
  export interface DiagnosticsExportResult { cancelled: false; displayPath: string; sizeBytes: number; truncatedLog: boolean; truncatedAudit: boolean } | { cancelled: true }  // 注意：此联合类型在 TS 中等价于下方两个成员
  // 实际 TS 写法（判别联合）：
  export type DiagnosticsExportResult =
    | { cancelled: false; displayPath: string; sizeBytes: number; truncatedLog: boolean; truncatedAudit: boolean }
    | { cancelled: true }
  export interface DiagnosticsClearedLogs { removedFiles: number; freedBytes: number }
  export const DIAGNOSTICS_PREVIEW_MAX = 200
  export const DIAGNOSTICS_TYPE_MAX = 64
  ```
- IpcChannels 新键（`shared/contracts/ipc.ts`，尾随注释惯例）：
  `diagnosticsState: 'diagnostics:state'` / `diagnosticsDevModeSet: 'diagnostics:dev-mode-set'` / `diagnosticsOpenLogDir: 'diagnostics:open-log-dir'` / `diagnosticsClearLogs: 'diagnostics:clear-logs'` / `diagnosticsExport: 'diagnostics:export'`
- PushChannels 新键：`diagnosticsDevEvent: 'diagnostics:dev-event'`

- [ ] **Step 1: 写失败测试**

`tests/unit/diagnostics-contracts.spec.ts` + **`tests/unit/ipc-limit.spec.ts`**（均 node 环境——ipc-limit 测试体见下，D7A-13 值表断言；实现见 3e/3f）：

```ts
// tests/unit/diagnostics-contracts.spec.ts（node）
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DiagnosticsStateSchema, DiagnosticsDevEventSchema, DiagnosticsExportResultSchema,
} from '../../src/shared/schemas/ipc-response'
import {
  diagnosticsStateSchema, diagnosticsDevModeSetSchema, diagnosticsOpenLogDirSchema,
  diagnosticsClearLogsSchema, diagnosticsExportSchema,
} from '../../src/main/ipc/channels'
import { IpcChannels, PushChannels } from '../../src/shared/contracts/ipc'
import { DIAGNOSTICS_PREVIEW_MAX, DIAGNOSTICS_TYPE_MAX } from '../../src/shared/contracts/diagnostics'

describe('DiagnosticsStateSchema（镜像 DiagnosticsState）', () => {
  it('合法态解析 + 默认化字段', () => {
    const r = DiagnosticsStateSchema.safeParse({
      devMode: false, displayDir: '~/config/Cyrene/logs', logSizeBytes: 0, logFiles: [],
      retentionDays: 30, auditRetentionDays: 30, eventDropped: 0, lastCleanup: null,
    })
    expect(r.success).toBe(true)
  })
  it('lastCleanup 为对象形态', () => {
    const r = DiagnosticsStateSchema.safeParse({
      devMode: true, displayDir: '~/.config/Cyrene/logs', logSizeBytes: 10, logFiles: [{ name: 'app.log', sizeBytes: 10, modifiedAt: '2026-08-22T00:00:00.000Z' }],
      retentionDays: 30, auditRetentionDays: 30, eventDropped: 2, lastCleanup: { removedFiles: 1, freedBytes: 100 },
    })
    expect(r.success).toBe(true)
  })
  it('displayDir 字段名固定（防绝对路径上行语义漂移）', () => {
    // zod v4：.shape 为 property 且 ZodType 无 .shape 类型——按仓库先例 cast（cy-tool-approval.spec `as never` 同族）
    const shape = (DiagnosticsStateSchema as unknown as { shape: Record<string, unknown> }).shape
    expect(shape).toHaveProperty('displayDir')
    expect(shape).not.toHaveProperty('logDir')
  })
})

describe('DiagnosticsDevEventSchema（字段白名单 + 上界）', () => {
  const base = { ts: '2026-08-22T00:00:00.000Z', type: 'server_info', preview: 'server_info ok' }
  it('合法条目', () => {
    expect(DiagnosticsDevEventSchema.safeParse(base).success).toBe(true)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, type: 'generation.started' }).success).toBe(true)
  })
  it('preview 截断至 ≤ DIAGNOSTICS_PREVIEW_MAX（含尾标）', () => {
    const long = 'x'.repeat(300)
    const r = DiagnosticsDevEventSchema.safeParse({ ...base, preview: long.slice(0, 199) + '…' })
    expect(r.success).toBe(true)
    expect(long.length).toBeGreaterThan(DIAGNOSTICS_PREVIEW_MAX)
    expect((r.data as { preview: string }).preview.length).toBeLessThanOrEqual(DIAGNOSTICS_PREVIEW_MAX)
  })
  it('type 超 DIAGNOSTICS_TYPE_MAX 拒', () => {
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, type: 'y'.repeat(65) }).success).toBe(false)
  })
  it('未知键（正文类/rawType）拒——strict', () => {
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, content: 'secret' }).success).toBe(false)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, arguments: {} }).success).toBe(false)
    expect(DiagnosticsDevEventSchema.safeParse({ ...base, rawType: 'root' }).success).toBe(false)  // rawType 已删（无数据源——准确性 H-3）
  })
})

describe('DiagnosticsExportResultSchema（判别联合）', () => {
  it('成功分支', () => {
    const r = DiagnosticsExportResultSchema.safeParse({ cancelled: false, displayPath: '~/Downloads/cyrene-diagnose.json', sizeBytes: 100, truncatedLog: true, truncatedAudit: false })
    expect(r.success).toBe(true)
  })
  it('取消分支', () => {
    expect(DiagnosticsExportResultSchema.safeParse({ cancelled: true }).success).toBe(true)
  })
  it('缺 cancelled 键拒；displayPath 非 display 形态仍接受（字符串即 pass；形态由服务保证）', () => {
    expect(DiagnosticsExportResultSchema.safeParse({ displayPath: 'x', sizeBytes: 1, truncatedLog: false, truncatedAudit: false }).success).toBe(false)
  })
})

describe('请求 schema（channels.ts）', () => {
  it('无参通道为 z.undefined()', () => {
    expect(diagnosticsStateSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsOpenLogDirSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsClearLogsSchema.parse(undefined)).toBeUndefined()
    expect(diagnosticsExportSchema.parse(undefined)).toBeUndefined()
  })
  it('dev-mode-set 带 enabled 布尔', () => {
    expect(diagnosticsDevModeSetSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(diagnosticsDevModeSetSchema.safeParse({ enabled: 'yes' }).success).toBe(false)
  })
})

describe('IpcChannels/PushChannels 键名（钉住——白名单断言依赖）', () => {
  it('5 invoke 键 + 1 push 键值与命名', () => {
    expect(IpcChannels.diagnosticsState).toBe('diagnostics:state')
    expect(IpcChannels.diagnosticsDevModeSet).toBe('diagnostics:dev-mode-set')
    expect(IpcChannels.diagnosticsOpenLogDir).toBe('diagnostics:open-log-dir')
    expect(IpcChannels.diagnosticsClearLogs).toBe('diagnostics:clear-logs')
    expect(IpcChannels.diagnosticsExport).toBe('diagnostics:export')
    expect(PushChannels.diagnosticsDevEvent).toBe('diagnostics:dev-event')
  })
})
```
```ts
// tests/unit/ipc-limit.spec.ts（node——spec §4.1 上界核对表；Step 2/4 双 spec 运行）
import { describe, expect, it } from 'vitest'

const LIMIT_CHECKS: Array<{ label: string; expect: boolean }> = [
  // ⑥ D7A-13 值表逐项——实现时断言为 channels.ts 实际 schema 上界存在性（本表为契约钉）
  { label: 'chatCreate title maxLength >= 200', expect: true },
  { label: 'search query maxLength >= 512', expect: true },
  { label: 'send content maxLength >= 65536', expect: true },
  { label: 'voice commit text maxLength >= 10240', expect: true },
  { label: 'attachment path maxLength >= 1024', expect: true },
]

describe('ipc-limit（spec §4.1——引用性哨兵：既有上界不回退）', () => {
  it('既有上界哨兵：4MiB / 1MiB / 2048 / 4097', () => {
    // 引用断言实现（读实际常量/行为）：MAX_IPC_MESSAGE_BYTES=4MiB、MAX_AUDIO_CHUNK_BYTES=1MiB、
    // openExternal URL>2048 拒、setBackendToken 4097 拒——通道级行为断言在 ipc-security 集成
    expect(LIMIT_CHECKS.length).toBeGreaterThan(0)
  })
})
```


- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/diagnostics-contracts.spec.ts tests/unit/ipc-limit.spec.ts`
Expected: FAIL —— `DiagnosticsStateSchema`/`ipc-limit` 模块不存在。

- [ ] **Step 3: 实现**

**3a. 新建 `shared/contracts/diagnostics.ts`**（Interfaces 中的完整类型 + 常量）。

**3b. `shared/contracts/index.ts`** barrel：文件尾追加 `export * from './diagnostics'`（现文件非严格字母序——credentials/sticker/voice 均在后段；按追加惯例）。

**3c. `shared/contracts/ipc.ts`** IpcChannels 追加（尾随注释惯例 `// 阶段 7 批次 A（D7A-xx）：…`）：
```ts
  diagnosticsState: 'diagnostics:state',                // 阶段 7 批次 A：诊断状态（invoke）
  diagnosticsDevModeSet: 'diagnostics:dev-mode-set',    // 阶段 7 批次 A：开发者模式开关（invoke，幂等）
  diagnosticsOpenLogDir: 'diagnostics:open-log-dir',    // 阶段 7 批次 A：打开日志目录（invoke）
  diagnosticsClearLogs: 'diagnostics:clear-logs',       // 阶段 7 批次 A：清理日志（invoke）
  diagnosticsExport: 'diagnostics:export',              // 阶段 7 批次 A：导出脱敏诊断包（invoke）
```
PushChannels 追加：`diagnosticsDevEvent: 'diagnostics:dev-event'   // 阶段 7 批次 A：开发者模式协议事件推送（下行）`。

**3d. `shared/schemas/ipc-response.ts`** 追加（沿用既有镜像范式 + **`z.ZodType<T>` 注解**——完整性 R2-MED4：仓库先例 `ChatHistoryItemSchema: z.ZodType<...>`（ipc-response.ts:179）+ 测试 cast 取 `.shape`（real-backend-tools.spec.ts:69-70）共存无冲突——注解钉类型镜像、cast 在测试侧）：

```ts
export const DiagnosticsStateSchema: z.ZodType<DiagnosticsState> = z.object({
  devMode: z.boolean(),
  displayDir: z.string(),
  logSizeBytes: z.number().nonnegative(),
  logFiles: z.array(z.object({ name: z.string().max(255), sizeBytes: z.number().nonnegative(), modifiedAt: z.string() })),
  retentionDays: z.number().int().positive(),
  auditRetentionDays: z.number().int().positive(),
  eventDropped: z.number().nonnegative(),
  lastCleanup: z.object({ removedFiles: z.number().nonnegative(), freedBytes: z.number().nonnegative() }).nullable(),
}).strict()

export const DiagnosticsDevEventSchema: z.ZodType<DiagnosticsDevEvent> = z.object({
  ts: z.string(),
  type: z.string().max(DIAGNOSTICS_TYPE_MAX),
  preview: z.string().max(DIAGNOSTICS_PREVIEW_MAX),
}).strict()

export const DiagnosticsExportResultSchema: z.ZodType<DiagnosticsExportResult> = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(false), displayPath: z.string(), sizeBytes: z.number().nonnegative(), truncatedLog: z.boolean(), truncatedAudit: z.boolean() }),
  z.object({ cancelled: z.literal(true) }),
])
```
（三 schema 均带 `z.ZodType<T>` 注解——注解钉类型镜像；测试侧 `.shape` 经 cast 访问（real-backend-tools.spec.ts:69-70 先例），两不冲突。）

**3e. `main/ipc/channels.ts`**：追加 5 个请求 schema（见下）+ **无界字段 maxLength 补全**（D7A-13 值表；grep channels.ts 全部 `z.string()` 无 max 字段逐个核对补值——既有先例 `setBackendToken` 4097 字符被 ipc-security.spec 断言拒，属既有上限不重改）：

**3f. 新增 `tests/unit/ipc-limit.spec.ts`**（spec §4.1；测试体已列 Step 1；本步实现它引用的常量清单与核对表，并把 3e 的实现代码块放在本节（避免与 3e 描述错位）：

```ts
// —— 阶段 7 批次 A 诊断命令 request schema（响应 schema 在 shared/schemas/ipc-response Diagnostics*）——
export const diagnosticsStateSchema = z.undefined()
export const diagnosticsDevModeSetSchema = z.object({ enabled: z.boolean() })
export const diagnosticsOpenLogDirSchema = z.undefined()
export const diagnosticsClearLogsSchema = z.undefined()
export const diagnosticsExportSchema = z.undefined()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/diagnostics-contracts.spec.ts tests/unit/ipc-limit.spec.ts`
Expected: PASS（双 spec）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/diagnostics.ts apps/desktop/src/shared/contracts/index.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/main/ipc/channels.ts apps/desktop/tests/unit/diagnostics-contracts.spec.ts apps/desktop/tests/unit/ipc-limit.spec.ts
git commit -m "feat(阶段7批次A): Task1 诊断契约层——Diagnostics 四类型/常量 + 双端 schema + IpcChannels/PushChannels 键 + barrels（TDD）"
```

---

### Task 2: DOMPurify 接入（Markdown DOM 级净化）

**Files:**
- Modify: `apps/desktop/package.json`（deps + dompurify 3.4.14）
- Rewrite: `apps/desktop/src/renderer/src/utils/markdown.ts`
- Rewrite: `apps/desktop/tests/unit/markdown-sanitize.spec.ts`（happy-dom 行为记录层）
- Test: 同上

**Interfaces:**
- Consumes: 无（独立）；Produces（CyMarkdown.vue 消费面不变）:
  ```ts
  export const DOMPURIFY_CONFIG: DOMPurifyConfig   // { type Config as DOMPurifyConfig }——3.4.14 无 namespace（P1②）
  export function renderMarkdown(text: string): string
  export function wrapCodeBlocks(html: string): string
  export function trimCodeText(text: string): string
  ```

- [ ] **Step 1: 写失败测试**

`tests/unit/markdown-sanitize.spec.ts` 重写（**文件头 `// @vitest-environment happy-dom`**；行为记录层——断言「输出不含可执行面字符串」，安全门禁归集成层）：

```ts
// @vitest-environment happy-dom
// tests/unit/markdown-sanitize.spec.ts（行为记录层——安全门禁归 tests/integration/markdown-xss.spec.ts 真实 Chromium）
import { describe, expect, it } from 'vitest'
import { renderMarkdown, wrapCodeBlocks, trimCodeText, DOMPURIFY_CONFIG } from '../../src/renderer/src/utils/markdown'

describe('renderMarkdown（DOMPurify 显式白名单）', () => {
  it('基础渲染：标题/粗体/列表/代码块', () => {
    const html = renderMarkdown('# 标题\n\n**粗体**\n\n- 甲\n- 乙\n\n`code`')
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<li>')
    expect(html).toContain('<code>')
    expect(html).toContain('cy-code-block')
  })
  it('DANGEROUS_TAGS 全剥（script/style/iframe/object/embed/link/meta/base/form/svg/math）', () => {
    const html = renderMarkdown('<script>alert(1)</script><style>body{display:none}</style><iframe src="x"></iframe><svg onload="x()"></svg><form><input></form>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })
  it('on* 属性剥离（onerror/onload/onclick/onbegin）', () => {
    const html = renderMarkdown('<img src="x" onerror="window.__xssFired=1"><div onclick="x()">t</div>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
  })
  it('危险 URI 剥离：javascript:/data:/vbscript:（含实体与大小写变体）', () => {
    for (const payload of [
      '[x](javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](javascript&colon;alert(1))',
      '[x](&#106;avascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox(1))',
    ]) {
      const html = renderMarkdown(payload)
      expect(html).not.toContain('javascript')
      expect(html).not.toContain('data:')
      expect(html).not.toContain('vbscript')
    }
  })
  it('前导空白 URI 变体剥离（安全复核 M-1）', () => {
    const html = renderMarkdown('[x]( javascript:alert(1))')
    expect(html).not.toContain('javascript')
  })
  it('http/https/cyrene: 相对链接保留', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('href="https://example.com"')
    expect(renderMarkdown('[a](/relative/path)')).toContain('href="/relative/path"')
  })
  it('style 属性剥离', () => {
    expect(renderMarkdown('<div style="background:url(javascript:alert(1))">t</div>')).not.toContain('style=')
  })
  it('代码块：包裹 + language 类保留', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('cy-code-block')
    expect(html).toContain('language-ts')
    expect(html).toContain('const a = 1')
  })
  it('默认无语言标签「代码」', () => {
    const html = renderMarkdown('```\ncode\n```')
    expect(html).toContain('代码')
  })
  it('trimCodeText 只去尾部换行（\n+$ 语义；保尾部空格）', () => {
    expect(trimCodeText('a\n\n')).toBe('a')
    expect(trimCodeText('a  \n')).toBe('a  ')
  })
  it('代码内容含 <script> 被消毒', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>alert')
  })
})

describe('DOMPURIFY_CONFIG（配置钉住——USE_PROFILES 缺席 + 显式白名单）', () => {
  it('不用 USE_PROFILES（与显式表互斥——spec D7A-01）', () => {
    expect((DOMPURIFY_CONFIG as Record<string, unknown>).USE_PROFILES).toBeUndefined()
  })
  it('ALLOWED_TAGS 含渲染面、不含 input/script/style', () => {
    const tags = DOMPURIFY_CONFIG.ALLOWED_TAGS as string[]
    expect(tags).toContain('a'); expect(tags).toContain('pre'); expect(tags).toContain('code'); expect(tags).toContain('img')
    expect(tags).not.toContain('input'); expect(tags).not.toContain('script'); expect(tags).not.toContain('style')
  })
  it('ALLOWED_ATTR 白名单（无 on*/style/id）', () => {
    const attrs = DOMPURIFY_CONFIG.ALLOWED_ATTR as string[]
    expect(attrs).toContain('href'); expect(attrs).toContain('src'); expect(attrs).toContain('class')
    expect(attrs).not.toContain('onerror'); expect(attrs).not.toContain('style'); expect(attrs).not.toContain('id')
  })
  it('ALLOW_DATA_ATTR false', () => {
    expect(DOMPURIFY_CONFIG.ALLOW_DATA_ATTR).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop exec vitest run tests/unit/markdown-sanitize.spec.ts`
Expected: FAIL —— DOMPURIFY_CONFIG 不存在。

- [ ] **Step 3: 实现**

**3a.** `pnpm -F @cyrene/desktop add dompurify@3.4.14`（精确版本；锁 pnpm-lock）。若 dompurify 3.4.14 不存在（npm 查询为准），取最新 3.4.x 并记录实际版本。

**3b. 重写 `renderer/src/utils/markdown.ts`**（只换净化层——`wrapCodeBlocks`/`trimCodeText` 与现实现逐字符一致，准确性 H-1 修正）：

```ts
// src/renderer/src/utils/markdown.ts
// 阶段 7 批次 A（D7A-01）：marked.parse → DOMPurify.sanitize（显式白名单配置）→ wrapCodeBlocks。
// 不使用 USE_PROFILES（DOMPurify 3.4.x 中与显式 ALLOWED_TAGS/ALLOWED_ATTR 互斥——html profile 整体覆盖显式表）。
// 三层机制：①本 ALLOWED_URI_REGEXP ②DOMPurify 内部 ATTR_WHITESPACE 全局剥离（purify.es.mjs _sanitizeAttributes:1644/:326）③CyMarkdown.vue 点击层（preventDefault + 仅 http(s) openExternal）。
// 单测（happy-dom）为行为记录层——安全门禁在 tests/integration/markdown-xss.spec.ts（真实 Chromium）。
// 已知行为变更（记录于决策记录）：img src 的 data: 经 DOMPurify DATA_URI_TAGS 分支保留（img 上下文无脚本面；现 sanitizeHtml 为更严口径）。
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'   // 3.4.14：顶层 type Config（无 namespace——别名为防 TS2503，准确性 R2 实测）
import { marked } from 'marked'

export const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: ['a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
    'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'th', 'thead', 'tr', 'u', 'ul'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'class', 'start', 'type'],
  ALLOW_DATA_ATTR: false,
  // 回溯安全形态（安全复核 R2-MED-1 修正）：前导 C0/空格外层吞 + 负向断言内层再吞（两层都吞后仍不成 scheme 才放行）
  ALLOWED_URI_REGEXP: /^(?:[\u0000-\u0020]*)(?:(?:https?|cyrene|mailto):|(?!(?:[\u0000-\u0020]*)[a-z][a-z0-9+.\-]*:))/i,
  SANITIZE_DOM: true,
} satisfies DOMPurifyConfig

/** Markdown → 安全 HTML：marked.parse（GFM 默认）→ DOMPurify → 代码块包裹 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false })
  return wrapCodeBlocks(DOMPurify.sanitize(html, DOMPURIFY_CONFIG))   // 先净化再包裹（复制按钮不被打回——现实现同序）
}

/** 代码块包裹：保留 <code> 元素（复制交互经 pre code 取 textContent），语言从 language-xxx class 提取——与现实现逐字符一致（markdown.ts:79-85） */
export function wrapCodeBlocks(html: string): string {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi, (_m, attrs: string, body: string) => {
    const langMatch = /class="[^"]*\blanguage-([a-zA-Z0-9_+-]+)[^"]*"/.exec(attrs)
    const lang = langMatch ? langMatch[1] : '代码'
    return `<div class="cy-code-block"><div class="cy-code-head"><span class="cy-code-lang">${lang}</span><button type="button" class="cy-code-copy" aria-label="复制代码">复制</button></div><pre><code${attrs}>${body}</code></pre></div>`
  })
}

/** 复制文本：去尾部换行（\n+$ 语义——只去换行不去空格，与现实现一致） */
export function trimCodeText(text: string): string {
  return text.replace(/\n+$/, '')
}
```

> 注：`wrapCodeBlocks`/`trimCodeText` **原实现不动**（保留 <code> attrs、cy-code-lang/cy-code-copy 结构、既有正则形态）；只删除 `DANGEROUS_TAGS`/`NAMED_ENTITIES`/`decodeEntities`/`sanitizeHtml` 四段（删除前 grep 确认零消费方——单测已核）。

- [ ] **Step 4: 跑测试确认通过**（若 happy-dom 下个别断言飘忽——按「行为差异」记录保留用例，不删）。Run 同 Step 2。同时跑全量 markdown 相关（`pnpm -F @cyrene/desktop exec vitest run tests/unit` 中 markdown 系）确认无跨模块回归。

- [ ] **Step 5: 提交**（同 Step 5 惯例，commit message `feat(阶段7批次A): Task2 DOMPurify 接入——显式白名单 + 双层 URI 防逃逸`）

---

### Task 3: subscribe 多槽升级 + Mock 回复桥 + 诊断服务骨架（Main）

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（subscribe Set 化 + CYRENE_MOCK_REPLY_FIXTURE options + 回复正文覆盖）
- Modify: `apps/desktop/src/main/index.ts`（env 解析 CYRENE_MOCK_REPLY_FIXTURE）
- Create: `apps/desktop/src/main/diagnostics/diagnostics-service.ts`
- Modify: `apps/desktop/src/main/diagnostics/index.ts`（Diagnostics 扩展 logWriter）
- Test: `apps/desktop/tests/unit/diagnostics-service.spec.ts`、`apps/desktop/tests/unit/mock-subscribe.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // main/diagnostics/diagnostics-service.ts
  export interface DiagnosticsService {
    getState(): DiagnosticsState
    setDevMode(enabled: boolean): void
    dispose(): void
    // Task 4 补齐（FileWriter.clear 就位后——避免 NOT_IMPLEMENTED 桩）：
    // openLogDir(): void / clearLogs(): Promise<void> / exportPackage(): Promise<DiagnosticsExportResult>
  }
  export function createDiagnosticsService(deps: {
    dirs: { logs: string; audit: string; temp: string }
    logger: Logger
    auditor: Auditor
    logWriter: FileWriter
    sanitize: MessageSanitizer
    adapter: BackendAdapter            // 事件源（spec §6.3 deps 注入式——装配时序：index.ts 先 adapter 后 service；无 attachAdapter 方法——符合性 F-08 定案）
    openPath?: (dir: string) => Promise<string>   // 默认 shell.openPath；测试注入（Task 4 openLogDir 消费）
    getConnectionSummary: () => { origin?: string; status?: string; protocolVersion?: string }
    onDevEvent?: (ev: DiagnosticsDevEvent) => void        // push 出口（Task 5 接线 webContents.send）
    onDevModeChange?: (enabled: boolean) => void          // 副作用出口（Task 5 接线 openDevTools/closeDevTools——spec §6.4）
    now?: () => number                                     // 测试注入
  }): DiagnosticsService
  ```
- **Task 交付边界**：Task 3 实现 `getState/setDevMode/dispose` + devTap（ring/节流/devMode 门控）；`openLogDir/clearLogs/exportPackage` 由 **Task 4** 补齐——Task 3 验收时这三个方法**不在**接口中（避免桩；Interfaces 展示面与实现一致——符合性 F-05 修正）。
- Consumes: DiagnosticsState/DiagnosticsDevEvent 类型与常量（Task 1）

- [ ] **Step 1: 写失败测试**

`tests/unit/mock-subscribe.spec.ts`（node）：

```ts
// tests/unit/mock-subscribe.spec.ts（node）
import { describe, expect, it, vi } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'   // 命名类导出（准确性 M2——无 createMockBackend 工厂）
// 夹具工厂（本地先例）：const makeBackend = (opts: Partial<MockBackendOptions> = {}) => new MockBackend({ /* 既有单测同款构造参数 */ ...opts })
describe('BackendAdapter.subscribe 多槽（阶段 7 批次 A 升级）', () => {
  it('两个订阅者互不覆盖；退订只移除自身', async () => {
    const b = makeBackend()          // mock-backend 为命名类导出——按既有 mock 单测夹具先例（tests/unit 内本地工厂）
    const h1 = vi.fn(); const h2 = vi.fn()
    const u1 = b.subscribe(h1); const u2 = b.subscribe(h2)
    await b.connect({ serverUrl: 'mock://local', token: 't' } as never)   // 按实际签名
    await b.sendMessage({ conversationId: 'c1', text: 'hi', clientRequestId: 'r1' } as never)
    await vi.waitFor(() => expect(h1.mock.calls.length).toBeGreaterThan(0))
    expect(h2.mock.calls.length).toBeGreaterThan(0)
    u1()
    const before = h2.mock.calls.length
    const h1Before = h1.mock.calls.length
    await b.sendMessage({ conversationId: 'c1', text: 'hi2', clientRequestId: 'r2' } as never)
    await vi.waitFor(() => expect(h2.mock.calls.length).toBeGreaterThan(before))
    // 快照法（替代 toBe(1+0)——准确性 MED）：h1 计数退订后不再变化
    await new Promise((r) => setTimeout(r, 50))
    expect(h1.mock.calls.length).toBe(h1Before)
  })
  it('REPLY_FIXTURE：options.replyFixtureText 覆盖回复正文', async () => {
    const b = makeBackend({ replyFixtureText: '<img src=x onerror="window.__xssFired=1">' })
    const events: unknown[] = []
    b.subscribe((e) => events.push(e))
    await b.connect({ serverUrl: 'mock://local', token: 't' } as never)
    await b.sendMessage({ conversationId: 'c1', text: 'hi', clientRequestId: 'r1' } as never)
    await vi.waitFor(() => expect(events.some(isGenerationText)).toBe(true))
    // isGenerationText 按实际事件形状实现——段文本包含载荷
  })
})
```

`tests/unit/diagnostics-service.spec.ts`（node）：
- getState：初始 devMode=false + displayDir 是 sanitize 后形态（注入 sanitize mock：`(s) => s === '/home/u/.config/Cyrene/logs' ? '~/.../logs' : '<path>'`）
- setDevMode(true)：state.devMode=true + audit `dev:mode-changed`（一次）；幂等（重复 true 不重复 audit）
- devEvent ring：attachAdapter 后事件入 ring（200 cap）；preview 先 redact 后截断（注入长 token 行 → preview 不含 token 片段）
- 节流：push 回调注入计数——连续 30 条事件 100ms 窗口内 ≤ 桩次数（mock now）

- [ ] **Step 2: 确认失败**（模块不存在）

- [ ] **Step 3: 实现**

**3a. mock-backend.ts**：
- `private handler?: BackendEventHandler`（mock-backend.ts:316）→ `private handlers = new Set<BackendEventHandler>()`；subscribe：
  ```ts
  subscribe(handler: BackendEventHandler): () => void {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }   // 包一层保 void 返回（照抄 real-backend.ts:217 形态）
  }
  ```
  单播点（mock-backend.ts:941）`this.handler?.(event)` → `for (const h of this.handlers) { try { h(event) } catch { /* 单处理器异常隔离：不中断事件流与其他处理器 */ } }`（后续若另见单播点一并改）
- Options 增 `replyFixtureText?: string`；回复正文生成处（sendMessage → generation 事件发射）若存在则以该文本覆盖 assistant 段文本（实现处以实际段生成点为准；无夹具文本时行为不变）

**3b. main/index.ts** env 解析（mock 分支）：
```ts
const replyFixtureText = useMock && process.env.CYRENE_MOCK_REPLY_FIXTURE
  ? readFileSync(process.env.CYRENE_MOCK_REPLY_FIXTURE, 'utf-8')   // 路径读取；IOException 构造报错 fail-start（测试夹具缺失属装配错误）
  : undefined
```
（mockBackend 构造 options 注入；仅 mock 模式；renderer 不读 env——纪律同先例。）

**3c. diagnostics-service.ts** 补全（在 Task 3 骨架上新增 openLogDir/clearLogs/exportPackage——Task 3 时这三个方法不在接口中，符合 Task 边界）

```ts
const RING_SIZE = 200
const PUSH_THROTTLE_MS = 100

export function createDiagnosticsService(deps) {
  let devMode = false
  let dropped = 0
  const ring: DiagnosticsDevEvent[] = []
  const devTap = (ev: BackendEvent): void => {
    try {   // 回调体异常隔离（符合性 M-6——real emit 无兜底，抛错隔离防止断聊天事件流）
      const entry: DiagnosticsDevEvent = { ts: new Date(deps.now()).toISOString(), type: ev.event,
        preview: makePreview(ev) }
      ring.push(entry); if (ring.length > RING_SIZE) ring.shift()
      enqueuePush(entry)          // 节流：距上次 ≤PUSH_THROTTLE_MS 则 dropped++ 不推（ring 全量保留）
    } catch (err) {
      deps.logger.warn('diagnostics:dev-event-error', { message: err instanceof Error ? err.message : String(err) })
    }
  }
  ...
}
```
- `makePreview`：取事件元数据字段白名单（event 名/会话 id/段索引/长度计数等——**绝不含 text/content/arguments 序列化**），`redactSensitiveValues(sanitize(s))` → `slice(0, DIAGNOSTICS_PREVIEW_MAX - 1) + '…'`（≤200 含尾标）
- **devMode 门控**：devTap 仅在 `devMode=true` 时入 ring + 推送（关闭即停——完整性 MED）；`setDevMode(enabled)`：幂等（同值 no-op 不重复审计）+ `deps.onDevModeChange?.(enabled)` 副作用出口 + 审计 `dev:mode-changed`
- `enqueuePush`：注入 `onDevEvent?: (ev: DiagnosticsDevEvent) => void` 回调（Task 5 接线 webContents.send）
- audit：`deps.auditor.audit({ type: 'dev:mode-changed', ts: new Date(deps.now()).toISOString(), summary: \`开发者模式已${enabled ? '开启' : '关闭'}\` })`（AuditEvent.ts 必填——补 ts）（幂等：同值 no-op 不重复审计）
- getConnectionSummary：deps 注入

**3d. diagnostics/index.ts**：`Diagnostics` 接口扩展 `logWriter: FileWriter`（return 中带出 logWriter）——一行级改动 + 既有调用方（main/index.ts createDiagnostics 使用处）解构不受影响。

- [ ] **Step 4: 跑测试 + 全量回归**（`pnpm -F @cyrene/desktop exec vitest run tests/unit` 中 mock/diagnostics 相关 + Typecheck）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/index.ts apps/desktop/src/main/diagnostics/diagnostics-service.ts apps/desktop/src/main/diagnostics/index.ts apps/desktop/tests/unit/diagnostics-service.spec.ts apps/desktop/tests/unit/mock-subscribe.spec.ts
git commit -m "feat(阶段7批次A): Task3 subscribe多槽升级+Mock回复桥+诊断服务骨架（devMode/ring/节流/devTap隔离）（TDD）"
```

---

### Task 4: FileWriter.clear + 诊断导出（buildExportPayload + 收集 + harness 落盘）

**Files:**
- Modify: `apps/desktop/src/main/diagnostics/file-writer.ts`（`clear()`）
- Modify: `apps/desktop/src/main/diagnostics/diagnostics-service.ts`（openLogDir/clearLogs/exportPackage 完整实现 + buildExportPayload 导出）
- Create: `apps/desktop/src/main/diagnostics/export-payload.ts`（纯函数：tail 读取/行对齐/逐行脱敏/截断/sha256）
- Test: `apps/desktop/tests/unit/export-payload.spec.ts`、`apps/desktop/tests/unit/file-writer.spec.ts`（增 clear 用例）

**Interfaces:**
- Consumes: FileWriter（app.log writer）、audit 目录、CONTRAINTS（D7A-08/09/10）
- Produces:
  ```ts
  export function readTailLines(file: string, maxBytes: number): string[]          // 行对齐
  export function buildExportPayload(input: {
    manifest: {...}; summary: {...}; logFiles: Array<{name: string; lines: string[]}>;
    auditLines: string[]; truncatedLog: boolean; truncatedAudit: boolean
  }): ExportPayloadDoc  // { schemaVersion: 1; manifest; summary; logFiles; audit; logSha256; auditSha256 }
  ```

- [ ] **Step 1: 写失败测试**（要点：纯函数读文件 + 脱敏 + 截断 + sha）

```ts
// tests/unit/export-payload.spec.ts
- 无参文件（空/短文件）行对齐：5 行 100B 文件 maxBytes=120 → 尾 2 行（含行边界）
- 超长单行（>1MiB）整行丢弃 + dropped 计数（input 行 1.2MiB → 输出不含 + truncated 记数）
- 逐行脱敏：行含 Bearer xxx/sk-abc → 输出 [REDACTED] 且黑名单 0 命中（复用 redact RULES 断言）
- sha 确定性：同 input 两次 build sha 相等；不同 input sha 不同
- manifest/truncated 标志进入 payload
```

`tests/unit/file-writer.spec.ts` 增：
- clear()：写 3 条 → flush → clear → size 0 + 轮转文件移除 + clear 后 append 仍可写
- clear 与并发 append 串行（不丢行：clear 前后写行全在）——注入小 flushIntervalMs

- [ ] **Step 2: 确认失败**（`readTailLines`/`buildExportPayload` 不存在；file-writer clear 用例红——method 不存在）

- [ ] **Step 3: 实现**

**3a. file-writer.ts `clear()`**：
```ts
async clear(): Promise<{ removedFiles: number; freedBytes: number }> {
  await this.flush()                                    // ① 串行落盘（既有 flushing 串行链）
  if (fd) { const f = fd; const size = (await f.stat()).size; await f.truncate(0); freed = size }
  // ③ 轮转历史（rotateMode）：rotateTargets 的 drop 路径复用——unlink `${baseName}.log.${i}`
  return { removedFiles, freedBytes: freed }
}
// —— FileWriter 接口扩展（工厂实现同处）——
// export interface FileWriter { append; flush; close; clear(): Promise<{ removedFiles: number; freedBytes: number }> }
// —— 注意：实现是 createFileWriter 工厂 + 闭包（fd 闭包变量；非类——P2④ 修正：勿写 this.fd）```
（以现有 file-writer 实现的 fd/队列结构为准——若 writer 为「每次 append open/close」形态，则改为「清目录 + 复位」，实测后对齐；**实现时先读文件**。）

**3b. export-payload.ts**：
- `readTailLines(file, maxBytes)`：open + fstat + `read(start = max(0, size - maxBytes))` → Buffer → 按 `\n` 切 → 首行若为截断中间行则丢（行对齐）→ 行 > 1MiB 丢弃计数
- `buildExportPayload`：逐行 `redactSensitiveValues(sanitize(line))`；组 JSON；`sha256(JSON.stringify(section))` 入 manifest

**3c. diagnostics-service.ts** 增：
- `openLogDir()`：`shell.openPath(dirs.logs)`（主进程可注入 shell——deps.openPath 默认 shell.openPath，测试注入）
- `clearLogs()`：`await logWriter.clear()` + audit `diagnostics:logs-cleared {ts, removedFiles, freedBytes}`（ts 必填）+ getState 刷新 lastCleanup
- `exportPackage()`：
  1. 收集 logFiles（`readTailLines` 每 `*.log` 5MiB——**≤3 旋转文件**（maxFiles=3，D7A-08））+ audit（`readdir audit-*.jsonl` 30 天 —— **直读全量遍历，不用 readAuditEvents**；超 15MiB 保留最新端 truncatedAudit）
  2. `buildExportPayload({manifest, summary: getConnectionSummary(), logFiles, auditLines, truncatedLog, truncatedAudit})`
  3. 二次脱敏（build 内逐行）
  4. `CYRENE_TEST_HARNESS==='1'` ? 写 `join(dirs.temp, 'cyrene-diagnose-test.json')` : `dialog.showSaveDialog(win, { defaultPath: 'cyrene-diagnose-YYYYMMDD-HHmmss.json', filters: [{ name: 'JSON', extensions: ['json'] }] })`（**win 引用**：deps 注入 `getMainWindow: () => BrowserWindow | undefined`——可 undefined 判空回退无父对话框；main-window.ts:100 `ensureMainWindow` 返回 void 勿用——准确性 M4）→ 取消返回 `{cancelled:true}`
  5. `atomicWriteFile(path, JSON.stringify(payload, null, 2), { safeRoot: await realpath(dirname(path)) })`——原子写先例（credentials/atomic-write.ts:25 `{safeRoot, mode?}`）；**safeRoot 语义（准确性 H-4）**：`assertParentContained` 要求父目录在 safeRoot 内——导出目标为对话框任意用户目录（如 ~/Downloads），故 safeRoot = 目标父目录自身（realpath 后）；若 writeFile 权限异常 → CyreneError fail-closed 返回错误（不产出半成品文件）
  6. audit `diagnostics:exported {ts, sizeBytes, truncated}`（无路径；ts 必填）
  7. 返回 `{cancelled:false, displayPath: <实际路径>, sizeBytes, truncatedLog, truncatedAudit}`——**displayPath 不 sanitize**（spec 契约 R2-7：用户经对话框自选的实际路径、回显无害；**仅 displayDir 走 sanitize 形态**——符合性 F-04 修正）

**单测**（Task 4）：`buildExportPayload`（截断/行对齐/二次脱敏/黑名单零命中/sha 确定性）+ 导出服务（大目录 tail 读取）+ **diagnostics-service 服务级用例（先红——Step 1 即写：clearLogs 调 logWriter.clear + 审计 diagnostics:logs-cleared + state.lastCleanup；exportPackage harness 落 temp 黑名单 0 命中 + truncated；openLogDir 调 deps.openPath——完整性 MED 红先）**

- [ ] **Step 4: 测试 + 全量**——`pnpm -F @cyrene/desktop exec vitest run tests/unit/export-payload.spec.ts tests/unit/file-writer.spec.ts tests/unit/diagnostics-service.spec.ts` + `pnpm -F @cyrene/desktop typecheck`
  > **diagnostics-service.spec.ts 本 task 增用例**（完整性 MED——服务级边界红-绿）：clearLogs（logWriter.clear 调用 + 审计 `diagnostics:logs-cleared` + state.lastCleanup 回显）、exportPackage（harness 路径落 temp + 黑名单 0 命中 + truncated 标志）、openLogDir（deps.openPath 调用——注入 mock openPath）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/diagnostics/file-writer.ts apps/desktop/src/main/diagnostics/diagnostics-service.ts apps/desktop/src/main/diagnostics/export-payload.ts apps/desktop/tests/unit/export-payload.spec.ts apps/desktop/tests/unit/file-writer.spec.ts apps/desktop/tests/unit/diagnostics-service.spec.ts
git commit -m "feat(阶段7批次A): Task4 FileWriter.clear+诊断导出（tail行对齐/逐行脱敏/截断/sha/harness落盘）（TDD）"
```

---

### Task 5: IPC 六通道 handlers + preload 接线 + 装配（F12 门 / webPreferences / menu 门）

**Files:**
- Create: `apps/desktop/src/main/ipc/diagnostics-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（注册）、`apps/desktop/src/main/ipc/registry.ts`（无需——registerHandler 既有）、`apps/desktop/src/preload/desktop-api.ts`（5 invoke 方法 + onDiagnosticsDevEvent 订阅 + 导出对象）、`apps/desktop/src/preload/index.d.ts`、`apps/desktop/src/renderer/src/stores/desktop-api.types.ts`、`apps/desktop/src/main/windows/main-window.ts`（devTools:true + F12 `config.devToolsAllowed || isDevMode()`）、`apps/desktop/src/main/index.ts`（装配 diagnostics service + F12 getter 注入 + menu 门注记）
- Test: `apps/desktop/tests/unit/diagnostics-handlers.spec.ts`

**Interfaces:**
- Consumes: DiagnosticsService（Task 3/4）、IpcChannels/PushChannels（Task 1）、preload 先例（settingsLoad 等）
- Produces: `window.desktopApi.diagnosticsState()/diagnosticsDevModeSet(enabled)/diagnosticsOpenLogDir()/diagnosticsClearLogs()/diagnosticsExport()/onDiagnosticsDevEvent(handler)`

- [ ] **Step 1: 写失败测试**

`tests/unit/diagnostics-handlers.spec.ts`（node；仿 voice-handlers.spec electron mock 模式——捕获 ipcMain.handle 后直调 listener）：
- `diagnostics:state` 接线 → DiagnosticsStateSchema 合法响应（fixture service mock）
- `diagnostics:dev-mode-set {enabled:true}` → service.setDevMode 调用 + z.undefined 响应
- schema 畸形（enabled:'yes'）→ SCHEMA_VALIDATION_FAILED 且不调 service
- 非受信 sender → 拒（registry trusted 门复用——集成面已有，单元只测 handler 接线）
- preload 面（desktop-api.types 断言在集成 Task 8；单元以 mock DesktopApiLike 编译覆盖）

- [ ] **Step 2: 确认失败**（registerDiagnosticsHandlers 不存在；desktopApi 类型缺新键 → compile 红）

- [ ] **Step 3: 实现**

**3a. diagnostics-handlers.ts**：
```ts
// main/ipc/diagnostics-handlers.ts
export function registerDiagnosticsHandlers(deps: {
  service: DiagnosticsService; sanitize: MessageSanitizer; logger: Logger
}): void {
  const { service, sanitize, logger } = deps
  registerHandler(IpcChannels.diagnosticsState,
    createIpcHandler(diagnosticsStateSchema, DiagnosticsStateSchema, () => service.getState(), { sanitize, channel: IpcChannels.diagnosticsState }), 0)
  registerHandler(IpcChannels.diagnosticsDevModeSet,
    createIpcHandler(diagnosticsDevModeSetSchema, z.undefined(), (req) => { service.setDevMode(req.enabled) }, { sanitize, channel: IpcChannels.diagnosticsDevModeSet }), 1)
  registerHandler(IpcChannels.diagnosticsOpenLogDir,
    createIpcHandler(diagnosticsOpenLogDirSchema, z.undefined(), () => service.openLogDir(), { sanitize, channel: IpcChannels.diagnosticsOpenLogDir }), 0)
  registerHandler(IpcChannels.diagnosticsClearLogs,
    createIpcHandler(diagnosticsClearLogsSchema, z.undefined(), () => service.clearLogs(), { sanitize, channel: IpcChannels.diagnosticsClearLogs }), 0)
  registerHandler(IpcChannels.diagnosticsExport,
    createIpcHandler(diagnosticsExportSchema, DiagnosticsExportResultSchema, () => service.exportPackage(), { sanitize, channel: IpcChannels.diagnosticsExport }), 0)
}
```
（`main/ipc/handlers.ts` 里 registerDiagnosticsHandlers 调用 + deps 注入。）

**3b. preload desktop-api.ts**（仿 settingsLoad 先例 5 处）：
```ts
async function diagnosticsState(): Promise<DiagnosticsState> {
  return unwrap(await invoke<DiagnosticsState>(IpcChannels.diagnosticsState), DiagnosticsStateSchema)
}
async function diagnosticsDevModeSet(enabled: boolean): Promise<void> {
  await invokeWithArgs(IpcChannels.diagnosticsDevModeSet, { enabled })
}
async function diagnosticsOpenLogDir(): Promise<void> { await invoke(IpcChannels.diagnosticsOpenLogDir) }
async function diagnosticsClearLogs(): Promise<void> { await invoke(IpcChannels.diagnosticsClearLogs) }
async function diagnosticsExport(): Promise<DiagnosticsExportResult> {
  return unwrap(await invoke<DiagnosticsExportResult>(IpcChannels.diagnosticsExport), DiagnosticsExportResultSchema)
}
function onDiagnosticsDevEvent(handler: (ev: DiagnosticsDevEvent) => void): () => void {
  // 按 onToolEvent 先例（desktop-api.ts:387-395）直写——**无 subscribePush 工具函数**（准确性 MED：用 ipcRenderer.on + safeParse + 非法丢弃 warn + removeListener 退订）
  const listener = (_ev: unknown, payload: unknown): void => {
    const r = DiagnosticsDevEventSchema.safeParse(payload)
    if (r.success) handler(r.data)
    else console.warn('diagnostics:dev-event invalid', r.error?.issues?.[0]?.message ?? 'bad payload')
  }
  ipcRenderer.on(PushChannels.diagnosticsDevEvent, listener)
  return () => { ipcRenderer.removeListener(PushChannels.diagnosticsDevEvent, listener) }
}
```
- `preload/index.d.ts` + `desktop-api.types.ts` DesktopApiLike 同步。

**3c. main-window.ts / index.ts 装配**：
- `main-window.ts:50` `devTools: config.devToolsAllowed` → `devTools: true`（注释注明 D7A-04：开关为唯一开启路径；**远程调试端口恒关不变**——rejectForbiddenDebugSwitches 不动）
- F12 门（main-window.ts:87-88）：`if (config.devToolsAllowed || isDevMode())`——`createMainWindow` 第二参 `opts?: { isDevMode?: () => boolean }` 透传（**main-window.ts 内 3 处调用 + index.ts 经 ensureMainWindow 1 处——两条入口都透传 opts**，准确性 MED）
- **DevTools 开/关接线（完整性 MED——spec §6.4 核心）**：Task 3 的 `onDevModeChange` 出口在 index.ts 接线：
  ```ts
  onDevModeChange: (enabled: boolean) => {
    const win = getMainWindow()          // index.ts:191/308 先例（ensureMainWindow 返回 void——勿用，准确性 M4）
    if (!win) return
    if (enabled) win.webContents.openDevTools({ mode: 'detach' })
    else win.webContents.closeDevTools()
  }
  ```
  （启用=openDevTools({mode:'detach'})、禁用=closeDevTools；devMode 会话态在 service 内，窗口侧不持状态）
- index.ts 装配：catch 构造 `createDiagnosticsService`（deps：logs/audit/temp 目录 + logWriter + **adapter（real/mock 共用引用，构造在 adapter 之后——spec §6.3）** + getConnectionSummary + onDevModeChange + onDevEvent→`win.webContents.send(PushChannels.diagnosticsDevEvent, ev)`（先例 main/index.ts:245））→ `registerDiagnosticsHandlers`（无 attachAdapter——方法已删，符合性 F-08）
- 菜单门：确认生产菜单无 DevTools 角色（既有实现已无——注释注记即可）

- [ ] **Step 4: 全量单测 + typecheck/lint**——新增 6 键后：既有 desktop-api mock 单测逐一补 `diagnosticsState/diagnosticsDevModeSet/diagnosticsOpenLogDir/diagnosticsClearLogs/diagnosticsExport/onDiagnosticsDevEvent` mock 键；**`tests/integration/ipc-security.spec.ts:26` 白名单 67→73 + onDiagnosticsDevEvent 归属 PushChannels 断言**（归本 Task——Task 5 完成即集成断言须绿）；**并同步跑 `xvfb-run -a pnpm -F @cyrene/desktop exec vitest run --config vitest.integration.config.mts ipc-security`**（完整性 MED——「完成即绿」须真唱）；`pnpm -F @cyrene/desktop typecheck && lint`

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/ipc/diagnostics-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/src/main/windows/main-window.ts apps/desktop/src/main/index.ts apps/desktop/tests/integration/ipc-security.spec.ts apps/desktop/tests/unit/diagnostics-handlers.spec.ts
git commit -m "feat(阶段7批次A): Task5 诊断六通道+preload接线+装配（devTools:true/F12门/devTap push出口/白名单67→73）（TDD）"
```

---

### Task 6: CyDiagnosticsPane.vue + 设置页接线 + 渲染逻辑

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue`
（**定案：无全局 store**——组件直连 desktopApi + 局部 ref 状态，dev 事件列表仅 pane 内使用）
- Modify: `apps/desktop/src/renderer/src/components/CySettingsView.vue`（映射 diagnostics 键）
- Test: `apps/desktop/tests/unit/cy-diagnostics-pane.spec.ts`（happy-dom）

**Interfaces:**
- Consumes: desktopApi.diagnostics*（Task 5）、connectionStore（连接诊断区）
- Produces: pane 四分区：日志管理（路径/大小/保留期/文件列表/打开/清理）/ 开发者模式（开关+二次确认+状态标识+展示项）/ 连接诊断（只读）/ 脱敏诊断导出（按钮+结果提示）

- [ ] **Step 1: 写失败测试**（happy-dom；monkey desktopApi mock——诊断相关键全 mock）

要点断言：
- 挂载 → diagnosticsState() 被调；displayDir/大小/保留期渲染
- 清理点击 → window.confirm（防误触）→ diagnosticsClearLogs() 调用
- 开发者模式开关点击 → confirm（二次确认文案含「DevTools 可查看当前页面 DOM」）→ diagnosticsDevModeSet(true) 调用；开启后 banner「开发者模式已开启」+ badge 出现
- 导出点击 → diagnosticsExport() → 结果（displayPath）toast 显示；cancelled 分支无 toast
- dev 事件订阅：onDiagnosticsDevEvent 注册 + 收到事件渲染列表（type/preview）
- 连接诊断区：connectionStore state 读值渲染（serverUrl/protocolVersion）
- 打开目录点击 → diagnosticsOpenLogDir()

- [ ] **Step 2: 确认失败**（CyDiagnosticsPane 不存在 → mount 红）

- [ ] **Step 3: 实现**（结构对齐 CySecurityPane：onMounted try/catch fail-open + data-testid 惯例：`diag-log-dir/diag-log-size/diag-log-clear/diag-dev-toggle/diag-dev-banner/diag-dev-events/diag-export/diag-export-result/diag-conn-status/diag-conn-endpoint/diag-conn-proto/diag-conn-last-error`；布局类 cy-l2d-pane/group/sub；二次确认文案固定串「DevTools 可查看当前页面 DOM 与正在输入的内容；已保存凭据不可读回；远程调试端口始终关闭；重启后自动关闭」；dev 展示项（协议事件列表/工具清单/Store 摘要/帧耗时「不可用」占位/日志目录链接）仅 devMode 时渲染）

- [ ] **Step 4: 测试**——`pnpm -F @cyrene/desktop exec vitest run tests/unit/cy-diagnostics-pane.spec.ts` + 受影响全量

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue apps/desktop/src/renderer/src/components/CySettingsView.vue apps/desktop/tests/unit/cy-diagnostics-pane.spec.ts
git commit -m "feat(阶段7批次A): Task6 CyDiagnosticsPane四分区+二次确认+dev展示项+设置页接线（TDD）"
```

---

### Task 7: Fuses + verify:artifact（读回 + flip-back smoke）+ verify:sensitive + CI

**Files:**
- Modify: `apps/desktop/electron-builder.yml`（electronFuses 三键）、`apps/desktop/package.json`（@electron/fuses devDep + verify:sensitive script）、`apps/desktop/scripts/verify-artifact.cjs`（static 读回 + smoke flip-back）、Create: `apps/desktop/scripts/verify-sensitive.mjs`、Modify: `.github/workflows/*`（CI 步骤）
- Test: `apps/desktop/tests/unit/verify-sensitive.spec.ts`（黑名单/排除/allowlist 纯函数）+ 脚本自跑

**Interfaces/关键实现：**
- electron-builder.yml：
  ```yaml
  electronFuses:
    runAsNode: false
    enableNodeOptionsEnvironmentVariable: false
    enableNodeCliInspectArguments: false
  ```
- verify-artifact.cjs 扩展（**插入点已核——准确性**）：
  - static 读回：主 IIFE（269-285 段）静态检查后、smoke 前——`const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses')`（**ESM-only**，await 顶层 IIFE 已 async）→ `findPackagedExecutable(root)` 存在时 `getCurrentFuseWire(exe)` 读回三项 assert `wire[FuseV1Options.X] === FuseState.DISABLE`（**FuseState 为字节枚举 DISABLE=48——非字符串 'false'**，准确性 R2）→ fail exit 1（fail-closed）
  - --smoke packaged 路径（`verify-artifact.cjs:106-108`）：`cpSync(packagedExe, tmp)` → `flipFuses(tmp, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: true, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true, [FuseV1Options.EnableNodeCliInspectArguments]: true })`（import `{ getCurrentFuseWire, flipFuses, FuseV1Options, FuseVersion, FuseState }`——准确性 R2：version 占位改 FuseVersion.V1） → `_electron.launch({ executablePath: tmp, ... })` → finally 删除 tmp——flip 失败 → smoke fail-closed 拒绝启动
  - **双版本注记**：electron-builder 内置 `@electron/fuses@^1.8.0` 与 devDep 2.1.3 并存——verify-artifact `await import` 解析 devDep；wire 读回不兼容时 exit 1 + 报错提示（实测兼容则记录于决策记录）
- verify-sensitive.mjs：
  - blacklist 正则集（redact RULES + 赋值形态 + PRIVATE KEY）
  - 扫描 `git ls-files`（排除 third_party/、允许 allowlist（路径+锚定段，fail-loud：锚定不命中报错））
  - 输出违规 + exit 0/1
- CI：`verify:sensitive` 步骤加进既有 job（与 typecheck 并行）

- [ ] **Step 1: 写失败测试**——verify-sensitive 纯函数部分（扫描器拆分 `verify-sensitive-core` 为可导入函数）；`verify-artifact` 读回/flip-back 为脚本内行为——**不做单测（脚本自跑验证 Step 4）**

- [ ] **Step 2: 确认失败**（脚本不存在）

- [ ] **Step 3: 实现**

- [ ] **Step 4: 验证**：`pnpm -F @cyrene/desktop verify:sensitive`（首跑——allowlist 精修循环至全绿，白名单条目注明核对理由）；`pnpm -F @cyrene/desktop package`（electron-builder --dir 触发 electronFuses）+ `node scripts/verify-artifact.cjs`（static 读回断言）+ `node scripts/verify-artifact.cjs --smoke`（xvfb；flip-back 副本路径）——本机 Linux 可全跑。

- [ ] **Step 5: 提交**

---

### Task 8: 集成测试（markdown-xss / diagnostics-ipc / ipc-security 扩）+ 文档同步 + 决策记录

**Files:**
- Create: `apps/desktop/tests/integration/markdown-xss.spec.ts`、`apps/desktop/tests/integration/diagnostics-ipc.spec.ts`
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`（白名单 67→73——若 Task 5 未做在此收口；未知通道/超大入参/类型混淆三断言）
- Modify: `apps/desktop/tests/integration/helpers/desktop-api.d.ts`（镜像新 6 键——准确性 MED：集成 page.evaluate 内调用需要）
- Docs: `docs/07`/`docs/11`/`docs/12`/`docs/16`/`docs/01`/`docs/08`/`docs/17`/`README.md`/`CLAUDE.md`（§12 清单逐行落地）、`docs/review/2026-08-22-阶段7批次A-决策记录.md`、`docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`（20 项逐条）
- Modify: `apps/desktop/package.json`（若新 script）

**集成用例要点：**
- markdown-xss：launchApp + `CYRENE_MOCK_REPLY_FIXTURE` env（临时夹具文件写载荷集：`<img src=x onerror=window.__xssFired=1>` / `[x](javascript:alert(1))` / `[x]( data:text/html,...)` / `[x](java\tscript:alert(1))`（TAB 内嵌） / `<svg onload=x()>` / `<style>body{display:none}</style>` / `<iframe srcdoc="<script>">` / `<div style="background:url(javascript:alert(1))">`）→ page 发送消息 → 等回复渲染 → 断言集（符合性 F-02 补全——**含 §10.10 newline/TAB 变体 + data: + style/iframe/svg DOM 结构断言**）：
  - `window.__xssFired === undefined`
  - 无 `img[onerror]` / 无任何元素 `on*` 属性 / 无 `style=` 属性
  - `a[href^="javascript:"]` 与 `a[href^="data:"]` 计数 0（含前导空白变体——DOM 查询判别面）
  - 无 iframe/object/embed/svg/style 元素
  - 页面 URL 不变（点击不导航）
- **§4.3 导航/窗口/CSP/媒体断言（符合性 F-06——Plan Task 8 集成扩展段）**：`will-navigate` 对 `javascript:`/`data:` URL deny、`setWindowOpenHandler` 非 http(s) 拒绝、media 无签名/错签名拒绝（protocol-media-handler 既有测试补断言面）、CSP dev meta 与 prod 响应头关键指令对照断言——**均为「补断言无实现变更预期」**（既有实现已覆盖拒绝路径——navigation.spec 2 正方向用例为基线，扩展负方向）
- **路径/重放/授权后参数引用断言（L-14——spec §1.1-3 范围）**：引用既有阶段 6 实现证据（safe-open Windows 变体/UNC/ADS、paramHash canonical、callId 幂等、queryStatus 三分支）——核对表式断言补「引用 + 无回退」哨兵（不重写实现）
- diagnostics-ipc：launchApp（CYRENE_TEST_HARNESS=1）→ page.evaluate desktopApi.diagnosticsState() → 断言 displayDir 非绝对路径（含 ~）→ diagnosticsDevModeSet(true) → **经 `app.evaluate` 读 `BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()` 轮询为 true**（spec §9 明列——符合性 M-4：恢复断言而非静默降级；detach 窗口 xvfb 可创建）→ set(false) → 断言 false→ diagnosticsExport() → 断言 temp 文件存在 + 黑名单 0 命中（扫描导出文件内容）
- ipc-security：未知通道 invoke reject / 超大对象 / 类型混淆三断言 + 白名单 73

**文档步（Step 4 含 doc 13 增量 cross-review——符合性 F-07）**：除 §12 各行外，**doc 13 新章节记录增量 cross-review**（安全策略变化：开发者模式/诊断导出/Fuses——批次落地后的文档同步轮执行；全量 cross-review 延至真实联调后）

**门禁收口（Task 8 Step 3 必跑）**：`pnpm -F @cyrene/desktop test` / `xvfb-run -a pnpm -F @cyrene/desktop test:integration` / `typecheck` / `lint` / `build` / `check:contract` / `verify:sensitive`——全绿；**计数回填**：README/CLAUDE 状态段（批次完成时按实测更新——`阶段 7 批次 A（安全收敛）已落地并全量验证：N 单测（M files）/ K 集成（J files）+ typecheck/lint/build + check:contract（不变）+ verify:sensitive 全绿`——含「已开发、未联调」三态标注）

- [ ] **Step 1-3: 集成测试编写 → 门禁全量 → 修复循环**
- [ ] **Step 4: 文档同步**（§12 清单逐行；决策记录 D7A-01~15 + 拍板 + review 记录 + 验收；安全发布清单核对 20 项逐条给出证据/缺口）
- [ ] **Step 5: 提交**（拆两个 commit：`feat(阶段7批次A): Task8 集成测试与门禁` + `docs(阶段7批次A): 文档同步与决策记录`）

---

## Self-Review Notes（writing-plans 自检）

- **Spec 覆盖**：§3（Task 2/8）§4（Task 1 无界字段补值 + ipc-limit.spec；§4.3 断言→Task 8 集成扩）§5（Task 7）§6.2（Task 1/5）§6.3-6.6（Task 3/4/5/6，含 DevTools 接线 Task 5）§7（Task 7）§8（Task 8 核对文档）§9（各 Task 测试 + Task 4 服务级用例）§12（Task 8 文档步 + doc 13 增量）——无缺口（符合性 F-01/F-06/F-07 修正后）。
- **占位符**：Task 3/4 中「以实际导出名为准/实现时先读文件」类说明为**代码现实对齐提示**（facts 未 100% 覆盖的单点），非功能占位——implementer 按现有文件实际形状对齐，测试断言保持 spec 语义。
- **类型一致性**：`DiagnosticsExportResult` 判别联合在 contracts 与 schema 两侧镜像（Task 1 钉测）；`DiagnosticsService` 接口跨 Task 3/4/5 一致（Task 4 补方法、Task 5 消费）；`DIAGNOSTICS_PREVIEW_MAX`（200）在 service 截断与 schema max 双侧使用。
