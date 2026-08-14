# 阶段3 真实联调前整改 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地阶段3 真实联调前的 5 项前端整改——P0-01 搜索日期自然日契约、D1 webm kind hint 消歧、D2 REST/multipart 跨仓门禁、D3 贴图真实契约测试、D4 删 `localDateToHalfOpenRange` 死代码，使 B-02/B-03 真实联调可准入。

**Architecture:** 改动集中在四层——(1) transport（`real-backend.ts` 日期参数与错误映射）；(2) attachments（`wireKindHint` 纯函数 + `upload-service` 用 hint 生成 `UploadContent.kind`，大小限额仍魔数）+ shared 契约白名单；(3) 门禁（`check-backend-contract.mjs` 增 REST 段，读后端 `rest.py` 与前端 zod schema 比对）；(4) 测试（新增 real-backend-upload/sticker-contract 两个 spec，改 search/history-viewer/attachment-policy/upload-service/attachments-contracts/history-date 六个 spec）。全部单元级 node env，不依赖 Electron。

**Tech Stack:** TypeScript / zod v4 / Vitest / Node（`--experimental-strip-types`）

**Spec:** [docs/superpowers/specs/2026-08-15-phase3-integration-fixes-design.md](../specs/2026-08-15-phase3-integration-fixes-design.md)

## Global Constraints

- 前端仅作本批整改；后端侧三项（贴图搜索白名单 BE-S3-INT-P0-01 / 逐文件 multipart BE-S3-INT-P0-02 / 日期 fail-fast BE-S3-INT-P1-01）不在本 plan 实施。
- 搜索日期参数必须为 `YYYY-MM-DD` 自然日（`date_from`/`date_to` 同值），**不预转 UTC ISO**；timezone 照传 IANA 名；无日期筛选省略两个日期参数。
- `localDateToHalfOpenRange` 及其私有助手 `getTimezoneOffsetMs`/`zonedTimeToUtc` 删除后不得有残留引用；`isoToLocalDate` 保留。
- webm kind hint：仅 `audio/webm` 时 `video→audio`；**大小限额（`sizeLimitFor`）仍用 `sniffKind` 魔数原值**，不用消歧后值。
- `ATTACHMENT_KIND_MIME.audio` 追加 `'audio/webm'`；`tests/unit/attachments-contracts.spec.ts:59` 精确等值断言必须同步。
- 渲染层 `clientPrecheck` 对 audio/webm 将按 audio（20MB）预检、Main 魔数路径仍 video（50MB）——此为已知行为，**不做算法改动**。
- check:contract REST 段：8 个目标模型字段覆盖/必填性/role 枚举子集比对；**防静默通过**（解析模型数<8 或任一模型字段数=0 → exit 1）；后端未挂载跳过（exit 0）。
- 历史查看器失败态：`hasSearched` 仅成功分支置 true（store :90），失败保持 false，不得写「失败也置 true」。
- 测试全部 node env（vitest.config.mts），跑法：`cd apps/desktop && npx vitest run tests/unit/<file>`。
- 提交信息用仓库既有约定（`feat/fix/docs(范围): 中文描述`）。

---

### Task 1: P0-01 日期自然日 + D4 删死代码

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts:46`（移除 import）、`:696-714`（fetchHistoryStream 日期参数）、`:127-132`（mapHttpError）
- Modify: `apps/desktop/src/shared/domain/history-date.ts`（删 :5-28 三函数，留 `isoToLocalDate`）
- Modify: `apps/desktop/tests/unit/history-date.spec.ts`（删 :7-22 describe 块）
- Modify: `apps/desktop/tests/unit/real-backend-search.spec.ts`（:37-58 日期断言 + 标题；新增 DST 与 INVALID_TIMEZONE 用例）

**Interfaces:**
- Consumes: 现有 `ChatHistoryQuery`（`localDate: string` / `timeZone: string`）；现有 `RealBackendOptions.fetchImpl`（不涉及）。
- Produces: `RealBackend.fetchHistoryStream()` 发送 `date_from=<localDate>`/`date_to=<localDate>`（YYYY-MM-DD）；`mapHttpError` 新增 `400 INVALID_TIMEZONE → INVALID_INPUT`；`@shared/domain/history-date` 仅导出 `isoToLocalDate`。

- [ ] **Step 1: 先改 real-backend-search.spec.ts 日期断言 + 标题 + 新增两用例（测试先红）**

`apps/desktop/tests/unit/real-backend-search.spec.ts`：

```ts
  // :37 测试名改：
  it('URL 参数：query/conversationId/date_from 自然日/timezone/category/cursor/limit', async () => {
  // :49-51 断言改（自然日，不再断言 UTC ISO）：
      expect(seen[0]).toContain('date_from=2026-08-14&date_to=2026-08-14')   // 自然日契约（P0-01：连续参数对，杜绝 T 后缀回归；URLSearchParams 保序）
      expect(seen[0]).toContain('timezone=Asia%2FShanghai')
```

并在该 describe 内追加 DST 用例：

```ts
  it('DST 时区（America/New_York）：date_from/date_to 仍为自然日，不随时区变化', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({ onSearch: (u) => seen.push(u) })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-01-15', timeZone: 'America/New_York', category: 'all', limit: 50 })
      expect(seen[0]).toContain('date_from=2026-01-15&date_to=2026-01-15')
      expect(seen[0]).toContain('timezone=America%2FNew_York')
      await backend.disconnect()
    } finally { close() }
  })
```

文件末尾追加 INVALID_TIMEZONE 映射用例（新 describe，独立 server 返回 400）：

```ts
describe('RealBackend 搜索错误映射（P0-01：后端日期/时区 fail-fast）', () => {
  it('400 INVALID_TIMEZONE → INVALID_INPUT（不落 UNKNOWN）', async () => {
    const { createServer } = await import('http')
    const { WebSocketServer } = await import('ws')
    const s = createServer((req, res) => {
      if (req.url?.startsWith('/api/search/messages')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'INVALID_TIMEZONE', message: '未知时区: Bad/Zone' }))
      } else { res.writeHead(404); res.end() }
    })
    const wss = new WebSocketServer({ server: s, path: '/ws' })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
      ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
      ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
    })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as { port: number }).port
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await expect(backend.queryChatHistory({ scope: { type: 'all_conversations' }, localDate: '2026-08-14', timeZone: 'Bad/Zone', category: 'all', limit: 50 }))
        .rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
      await backend.disconnect()
    } finally { wss.close(); s.close() }
  })
})
```

（需在文件头补 `import { CyreneErrorCode } from '../../src/shared/errors'`。）

- [ ] **Step 2: 跑测试确认失败（红）**

Run: `cd apps/desktop && npx vitest run tests/unit/real-backend-search.spec.ts`
Expected: FAIL——自然日断言用例（现实现发 UTC ISO）与 INVALID_TIMEZONE 用例（现映射 UNKNOWN）红；其余用例仍绿。

- [ ] **Step 3: 实现——real-backend.ts 日期自然日 + 移除 import + mapHttpError**

在 `apps/desktop/src/main/transport/real-backend.ts`：

```ts
// ① :46 行删除该 import：
// import { localDateToHalfOpenRange } from '@shared/domain'   ← 删除

// ② :696-714 fetchHistoryStream() 内日期参数段改为：
    if (input.localDate) {
      params['date_from'] = input.localDate   // YYYY-MM-DD 自然日（阶段3 联调前整改 P0-01：不再预转 UTC ISO，后端自转半开区间）
      params['date_to'] = input.localDate
    }
    params['timezone'] = input.timeZone

// ③ mapHttpError（:127-132）补一条：
function mapHttpError(status: number, code: string): CyreneErrorCode {
  if (status === 400 && code === 'CONTRACT_VALIDATION') return CyreneErrorCode.INVALID_INPUT
  if (status === 400 && code === 'INVALID_TIMEZONE') return CyreneErrorCode.INVALID_INPUT   // 阶段3 整改 P0-01：后端日期/时区 fail-fast（BE-S3-INT-P1-01）
  if (status === 401 || status === 403) return CyreneErrorCode.AUTHENTICATION_FAILED
  if (status === 404) return CyreneErrorCode.NOT_FOUND
  return CyreneErrorCode.UNKNOWN
}
```

- [ ] **Step 4: 删 history-date.ts 三函数 + history-date.spec.ts 删块**

`apps/desktop/src/shared/domain/history-date.ts` 整文件替换为（删 `getTimezoneOffsetMs` :5-14、`zonedTimeToUtc` :16-20、`localDateToHalfOpenRange` :22-28，保留头部注释与 `isoToLocalDate`）：

```ts
// src/shared/domain/history-date.ts
// 阶段 3 G4（spec §4.4，D3）：日期时区纯函数（Intl 实现，双端复用）。
// 禁止 naive 本地日期假设（docs/02 §11「避免 UTC 跨日错误」）；无 Electron/无状态依赖。
// 阶段3 联调前整改 P0-01：localDateToHalfOpenRange 及其私有助手已删除（后端按自然日自转），
// 仅保留 isoToLocalDate 供 mock 自然日过滤等本地用途。

/** ISO 时间 → 用户本地自然日标签(YYYY-MM-DD)，供结果日期分组 */
export function isoToLocalDate(iso: string, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = dtf.formatToParts(new Date(iso))
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
```

`apps/desktop/tests/unit/history-date.spec.ts`：删除第 7-22 行「localDateToHalfOpenRange」describe 块（含 import 里该函数），保留「isoToLocalDate」describe 块；import 改为 `import { isoToLocalDate } from '../../src/shared/domain/history-date'`。

- [ ] **Step 5: 跑测试确认通过（绿）**

Run: `cd apps/desktop && npx vitest run tests/unit/real-backend-search.spec.ts tests/unit/history-date.spec.ts`
Expected: 全过。

- [ ] **Step 6: 全局 grep 确认无残留引用**

Run: `cd apps/desktop && grep -rn "localDateToHalfOpenRange" src/ tests/ || echo "无残留"`
Expected: `无残留`（无输出即通过）。

- [ ] **Step 7: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/shared/domain/history-date.ts apps/desktop/tests/unit/history-date.spec.ts apps/desktop/tests/unit/real-backend-search.spec.ts
git commit -m "fix(阶段3 联调前整改 P0-01): 搜索日期按后端自然日契约发送 + INVALID_TIMEZONE 映射 + 删 localDateToHalfOpenRange 死代码"
```

---

### Task 2: D1 WebM kind hint 消歧

**Files:**
- Modify: `apps/desktop/src/main/attachments/attachment-policy.ts`（新增 `wireKindHint`）
- Modify: `apps/desktop/tests/unit/attachment-policy.spec.ts`（新增 wireKindHint 测试）
- Modify: `apps/desktop/src/main/attachments/upload-service.ts:147-159`（两分支 `UploadContent.kind` 用 hint）
- Modify: `apps/desktop/tests/unit/upload-service.spec.ts`（断言 hint 值）
- Modify: `apps/desktop/src/shared/contracts/attachments.ts:79-82`（audio 白名单补 `'audio/webm'`）
- Modify: `apps/desktop/tests/unit/attachments-contracts.spec.ts:59`（等值断言同步）

**Interfaces:**
- Consumes: `sniffKind`（attachment-policy.ts，魔数）；`UploadContent.kind` 类型 `AttachmentKind`。
- Produces: `wireKindHint(kind: AttachmentKind, mediaType: string): AttachmentKind`（attachment-policy.ts 导出）；`upload-service.uploadBatch` 产出 `UploadContent.kind` 为消歧后 hint（大小限额仍 `sniffKind`）。

- [ ] **Step 1: 先写失败测试（attachment-policy.spec.ts 新增 describe）**

在 `apps/desktop/tests/unit/attachment-policy.spec.ts` 末尾追加：

```ts
describe('wireKindHint（webm 魔数无法区分 audio/video，特例回退 MIME）', () => {
  it('audio/webm：video → audio', () => {
    expect(wireKindHint('video', 'audio/webm')).toBe('audio')
  })
  it('video/webm：保持 video', () => {
    expect(wireKindHint('video', 'video/webm')).toBe('video')
  })
  it('非 webm 不受影响（image png / 无 kind 默认）', () => {
    expect(wireKindHint('image', 'image/png')).toBe('image')
    expect(wireKindHint('file', 'audio/webm')).toBe('file')   // 非 video 魔数结果不触发回退
  })
})
```

文件头 import 补：`import { wireKindHint } from '../../src/main/attachments/attachment-policy'`（并入既有 import 语句）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run tests/unit/attachment-policy.spec.ts`
Expected: FAIL（`wireKindHint` is not defined）。

- [ ] **Step 3: 实现 wireKindHint**

`apps/desktop/src/main/attachments/attachment-policy.ts` 在 `sniffKind`（:45）之后追加：

```ts
/** wire kind 提示：webm 魔数无法区分 audio/video，特例回退 MIME（仅 hint；大小限额仍用 sniffKind 魔数，P2-1 防线不变） */
export function wireKindHint(kind: AttachmentKind, mediaType: string): AttachmentKind {
  if (kind === 'video' && mediaType === 'audio/webm') return 'audio'
  return kind
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && npx vitest run tests/unit/attachment-policy.spec.ts`
Expected: PASS。

- [ ] **Step 5: upload-service 两分支改用 wireKindHint 生成 UploadContent.kind**

`apps/desktop/src/main/attachments/upload-service.ts`：

```ts
// ① import 补（并入既有 import { precheckFiles, sniffKind, sizeLimitFor } from './attachment-policy'）：
import { precheckFiles, sniffKind, sizeLimitFor, wireKindHint } from './attachment-policy'

// ② :152-154 path 分支 push 改（kind 变量仍是 sniffKind 原值，仅 push 用 hint；sizeLimitFor(kind) 不变）：
          uploads.push({ name: d.name, mediaType: d.mediaType, size: st.size, kind: wireKindHint(kind, d.mediaType), path: d.path, bytes: new Uint8Array(await this.fs.readFile(d.path)) })

// ③ :157-159 bytes 分支 push 改（同模式）：
          uploads.push({ name: d.name, mediaType: d.mediaType, size: d.size, kind: wireKindHint(kind, d.mediaType), bytes: d.bytes })
```

- [ ] **Step 6: 白名单补 audio/webm + 等值断言同步**

`apps/desktop/src/shared/contracts/attachments.ts` `ATTACHMENT_KIND_MIME`（:79-82）：

```ts
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm'],
```

`apps/desktop/tests/unit/attachments-contracts.spec.ts:59`：

```ts
    expect(ATTACHMENT_KIND_MIME.audio).toEqual(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm'])
```

测试名/注释里的「audio 可播 mp3/wav/ogg/flac/m4a」同步补「/webm」。

- [ ] **Step 7: upload-service.spec.ts 增 hint 断言**

在 `apps/desktop/tests/unit/upload-service.spec.ts` 追加（用 `fakeFs` + 既有构造方式）：

```ts
  it('webm：UploadContent.kind 为 wireKindHint 消歧值（audio/webm→audio；大小限额仍魔数）', async () => {
    const calls: Array<{ kind?: string }> = []
    const uploadAttachments = vi.fn(async (files: Array<{ kind?: string }>) => {
      calls.push(...files)
      return files.map((f, i) => ({ attachmentId: `att_${i}`, kind: f.kind ?? 'file', mime: 'application/octet-stream', size: 1, url: `/api/attachments/${i}`, filename: `f${i}` }))
    })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    // audio/webm：EBML 魔数 → sniffKind='video'，wireKindHint('video','audio/webm')='audio'
    await svc.uploadBatch('u1', [
      { localId: 'l1', name: 'a.webm', size: 4, mediaType: 'audio/webm', source: 'picker', bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]) }
    ])
    expect(calls[0].kind).toBe('audio')
  })
```

（如 `uploadBatch` 对 bytes 分支需过 `sniffKind` 大小复验，4 字节 < 各限额，不会拒。）

- [ ] **Step 8: 跑 Task 2 相关测试**

Run: `cd apps/desktop && npx vitest run tests/unit/attachment-policy.spec.ts tests/unit/attachments-contracts.spec.ts tests/unit/upload-service.spec.ts`
Expected: 全过。

- [ ] **Step 9: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/src/main/attachments/attachment-policy.ts apps/desktop/src/main/attachments/upload-service.ts apps/desktop/src/shared/contracts/attachments.ts apps/desktop/tests/unit/attachment-policy.spec.ts apps/desktop/tests/unit/upload-service.spec.ts apps/desktop/tests/unit/attachments-contracts.spec.ts
git commit -m "feat(阶段3 联调前整改 D1): webm kind hint MIME 特例回退（audio/webm→audio，大小限额仍魔数）+ audio/webm 入播放白名单"
```

---

### Task 3: D2a check:contract 扩展 REST 段

**Files:**
- Modify: `apps/desktop/scripts/check-backend-contract.mjs`（WS 段后新增 REST 段）

**Interfaces:**
- Consumes: `/home/yomu/elysia-agent/frontend_contract/rest.py`（8 个目标模型 + `Role` StrEnum）；前端 `src/main/transport/protocol-v2/rest-schemas.ts` 的 zod schema。
- Produces: 脚本输出追加「REST 段 N/8 通过」；后端未挂载仍 `exit 0`；字段/枚举不符或防静默通过守卫触发 → `exit 1`。

- [ ] **Step 1: 在 check-backend-contract.mjs 末尾（`:146` console.log 之后）追加 REST 段**

在 `apps/desktop/scripts/check-backend-contract.mjs` 末尾追加：

```js
// ── REST 段：rest.py 目标模型 ↔ 前端 rest-schemas.ts（阶段3 联调前整改 spec §4.3.1）——
// 字段名/必填性/role 枚举子集比对；防静默通过（模型数<8 或任一模型字段数=0 → exit 1）。
const REST_TARGET_MODELS = {
  SearchMessageItem: ['RestSearchMessageItemSchema'],
  SearchMessagesResponse: ['RestSearchMessagesResponseSchema'],
  MessageContextResponse: ['RestMessageContextResponseSchema'],
  AttachmentInfo: ['RestAttachmentUploadResponseSchema', 'shape', 'attachments', 'element'],
  AttachmentUploadResponse: ['RestAttachmentUploadResponseSchema'],
  AttachmentSignResponse: ['RestAttachmentSignResponseSchema'],
  StickerEntry: ['RestStickerItemSchema'],
  StickerListResponse: ['RestStickerListResponseSchema']
}
const REST_SCHEMAS = new URL('../src/main/transport/protocol-v2/rest-schemas.ts', import.meta.url)

/** REST 段主体（M2：rest.py 缺失时由外层守卫跳过，不抛 ENOENT） */
async function runRestSection() {
const restSrc = readFileSync(`${BACKEND_DIR}/rest.py`, 'utf8')

/** 按 ^class 边界切模型类体（含 docstring/字段行） */
function sliceClass(src, name) {
  const start = src.indexOf(`class ${name}(`)
  if (start === -1) return ''
  const bodyStart = src.indexOf('\n', start) + 1
  const next = src.indexOf('\nclass ', bodyStart)
  return next === -1 ? src.slice(bodyStart) : src.slice(bodyStart, next)
}
const FIELD_RE = /^\s{4}(\w+):\s*([^=#\n]+?)\s*(?:=([^\n]+))?$/gm

/** 解析模型字段 → { name, annotation, defaultText, required } */
function parseModelFields(cls) {
  const fields = []
  for (const m of cls.matchAll(FIELD_RE)) {
    if (m[1].startsWith('_')) continue
    const defaultText = (m[3] ?? '').trim()
    const fargs = /Field\((.*)\)/s.exec(defaultText)?.[1] ?? ''
    const required = !m[2].trim().startsWith('Optional[') &&
      !/\bdefault\s*=\s*None\b|\bdefault_factory\s*=|\bdefault\s*=\s*""/.test(fargs)
    fields.push({ name: m[1], annotation: m[2].trim(), required })
  }
  return fields
}

/** 前端 zod schema 字段键集合 */
function schemaKeys(schema) {
  const s = schema.shape ?? schema
  return new Set(Object.keys(s))
}

const { RestSearchMessageItemSchema } = await import(REST_SCHEMAS.href)
const restFailures = []
let restChecked = 0

for (const [modelName, path] of Object.entries(REST_TARGET_MODELS)) {
  const cls = sliceClass(restSrc, modelName)
  if (!cls) { restFailures.push(`REST 段：未找到后端模型 ${modelName}`); continue }
  const fields = parseModelFields(cls)
  if (fields.length === 0) { restFailures.push(`REST 段：${modelName} 字段解析为 0（正则失效？）`); continue }
  restChecked += 1
  // 前端 schema 定位：`['RestXxxSchema','shape','attachments','element']` 逐级下钻
  const mod = await import(REST_SCHEMAS.href)
  let schema = mod[path[0]]
  for (let i = 1; i < path.length; i++) schema = schema[path[i]]
  const front = schemaKeys(schema)
  const missing = fields.filter((f) => !front.has(f.name)).map((f) => f.name)
  if (missing.length) restFailures.push(`REST 段：${modelName} 前端缺后端字段 ${missing.join(', ')}`)
  // 必填性：后端必填字段必须存在于前端（前端可更宽松可选）
  const reqMissing = fields.filter((f) => f.required && !front.has(f.name)).map((f) => f.name)
  if (reqMissing.length) restFailures.push(`REST 段：${modelName} 前端缺必填字段 ${reqMissing.join(', ')}`)
}

// role 枚举子集：后端 Role（StrEnum 成员）⊆ 前端 search item role 枚举
const roleCls = sliceClass(restSrc, 'Role')
const roleEnumRe = /^\s{4}(\w+)\s*=\s*"([^"]+)"/gm
const backendRoles = [...roleCls.matchAll(roleEnumRe)].map((m) => m[2])
const searchRole = RestSearchMessageItemSchema.shape.role
const frontRoleInner = searchRole?._def?.innerType ?? searchRole
const frontRoles = frontRoleInner ? (frontRoleInner.options ?? Object.values(frontRoleInner._def?.entries ?? {})) : []
const roleOvershoot = backendRoles.filter((r) => !frontRoles.includes(r))
if (roleOvershoot.length) restFailures.push(`REST 段：role 枚举后端多出前端不识别 ${roleOvershoot.join(', ')}`)

// 防静默通过：模型数 < 8 或任一模型字段数 = 0（已在上层 loop 处理字段数=0）
if (restChecked < Object.keys(REST_TARGET_MODELS).length) {
  restFailures.push(`REST 段：仅解析 ${restChecked}/8 模型，疑似正则失效`)
}

if (restFailures.length) {
  for (const f of restFailures) console.error(`[check-contract] ${f}`)
  process.exit(1)
}
console.log(`[check-contract] REST 段 ${restChecked}/${Object.keys(REST_TARGET_MODELS).length} 模型通过`)
}

if (existsSync(`${BACKEND_DIR}/rest.py`)) await runRestSection()
else console.log('[check-contract] 后端 rest.py 缺失，REST 段跳过')
```

**实现注意：**
- `sliceClass` 的 `src.indexOf('\nclass ', bodyStart)` 找下一个顶层类（列 0），不会误切缩进类。
- `FIELD_RE` 用 `/gm`，`m[3]` 捕获 `= Field(...)` 整段；`Field\((...)\)` 提取实参做必填判定（spec 评审 I2/R3）。
- `RestSearchMessageItemSchema.shape.role` 是 `ZodOptional<ZodEnum>`，`_def.innerType` 解包后 `.options` 取枚举数组（zod v4 已验证）。
- 若 `/home/yomu/elysia-agent` 未挂载，REST 段不执行（脚本在 `:31` 已 `exit 0`）。
- **M1（已知限制）**：`parseModelFields` 按行匹配，**多行 `Field(` 且注解非 `Optional[` 的字段**会把下一行的 `default=` 漏掉而误判必填；当前 8 个目标模型中仅 `signedUrl` 是多行且为 `Optional[`（被注解救回），**无现成误报**。实现时不扩复杂度，仅在 parseModelFields 注释中注明该限制即可。

- [ ] **Step 2: 跑 check:contract 验证（后端挂载时）**

Run: `cd /home/yomu/elysia-frontend && pnpm -F @cyrene/desktop check:contract`
Expected: 输出追加 `[check-contract] REST 段 8/8 模型通过`；无 exit 1。若后端未挂载（跳过），输出不含 REST 段即可。

- [ ] **Step 3: 人工核对输出不回归 WS 段**

Run: 同上命令，确认 `WS v2 type 覆盖: 13/13 通过` 仍出现。
Expected: 13/13 保持。

- [ ] **Step 4: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/scripts/check-backend-contract.mjs
git commit -m "feat(阶段3 联调前整改 D2): check:contract 扩 REST 段（rest.py 8 模型字段/必填/role 枚举 + 防静默通过）"
```

---

### Task 4: D2b 新增 real-backend-upload.spec.ts（FormData 顺序/混合/webm 透传/响应权威/取消）

**Files:**
- Create: `apps/desktop/tests/unit/real-backend-upload.spec.ts`

**Interfaces:**
- Consumes: `RealBackend`（`RealBackendOptions.fetchImpl`、`uploadTimeoutMs`）；`UploadContent`（`kind`/`mediaType`/`size`/`bytes`）。
- Produces: 该 spec 覆盖的 5 条断言（见 spec §4.3.2）。后续任务不依赖其导出。

- [ ] **Step 1: 写 spec 文件**

`apps/desktop/tests/unit/real-backend-upload.spec.ts`：

```ts
// tests/unit/real-backend-upload.spec.ts
// 阶段3 联调前整改 D2（spec §4.3.2）：FormData part 顺序/混合批次/已消歧 kind 透传不串位/响应 kind 权威/取消。
// env=node：fetchImpl 注入捕获 FormData（不真实上传）；connect 用 WS 握手 stub（既有惯例）。
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { describe, expect, it, vi } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import { CyreneErrorCode } from '../../src/shared/errors'
import type { UploadContent } from '../../src/main/transport/backend-adapter'

/** 连接用 WS 握手 stub（返回 200 即可，uploadAttachments 不消费 WS 帧） */
async function connectStub(): Promise<{ port: number; close(): void }> {
  const s = createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server: s, path: '/ws' })
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
    ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as AddressInfo).port, close: () => { wss.close(); s.close() } }
}

function uploadBody(files: Array<{ name: string; mediaType: string; kind?: string }>): UploadContent[] {
  return files.map((f) => ({ name: f.name, mediaType: f.mediaType, size: 4, kind: f.kind, bytes: new Uint8Array([1, 2, 3, 4]) }))
}

describe('RealBackend.uploadAttachments multipart（D2）', () => {
  it('FormData part 顺序 kind/files/kind/files…；混合批次 kind 依次 image/video/file', async () => {
    let form: FormData | undefined
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as FormData
      return new Response(JSON.stringify({ attachments: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.uploadAttachments(uploadBody([
        { name: 'a.png', mediaType: 'image/png', kind: 'image' },
        { name: 'b.mp4', mediaType: 'video/mp4', kind: 'video' },
        { name: 'c.pdf', mediaType: 'application/pdf', kind: 'file' }
      ]))
      expect(form).toBeDefined()
      expect([...form!.entries()].map(([k]) => k)).toEqual(['kind', 'files', 'kind', 'files', 'kind', 'files'])
      expect(form!.getAll('kind')).toEqual(['image', 'video', 'file'])
      expect(form!.getAll('files').map((f) => (f as File).name)).toEqual(['a.png', 'b.mp4', 'c.pdf'])
      await backend.disconnect()
    } finally { close() }
  })

  it('audio/webm + video/webm 已消歧 kind 透传不串位（顺序 audio/video）', async () => {
    let form: FormData | undefined
    const fetchImpl = vi.fn(async (_u, init) => {
      form = init?.body as FormData
      return new Response(JSON.stringify({ attachments: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.uploadAttachments(uploadBody([
        { name: 'voice.webm', mediaType: 'audio/webm', kind: 'audio' },   // upload-service 已产消歧 hint
        { name: 'clip.webm', mediaType: 'video/webm', kind: 'video' }
      ]))
      expect(form!.getAll('kind')).toEqual(['audio', 'video'])
      expect([...form!.entries()].map(([k]) => k)).toEqual(['kind', 'files', 'kind', 'files'])
      await backend.disconnect()
    } finally { close() }
  })

  it('响应 kind 与 hint 不同 → 以响应值为准（AttachmentInfo.kind 权威）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ attachments: [{ attachmentId: 'att_9', kind: 'audio', mime: 'audio/webm', size: 4, url: '/api/attachments/att_9', filename: 'a.webm' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const infos = await backend.uploadAttachments(uploadBody([{ name: 'a.webm', mediaType: 'audio/webm', kind: 'video' }]))
      expect(infos[0]).toMatchObject({ attachmentId: 'att_9', kind: 'audio', mime: 'audio/webm' })
      await backend.disconnect()
    } finally { close() }
  })

  it('取消（signal abort）→ reject INVALID_INPUT 附件上传已取消，无迟到发送', async () => {
    const fetchImpl = vi.fn(async (_u, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const controller = new AbortController()
      const p = backend.uploadAttachments(uploadBody([{ name: 'a.png', mediaType: 'image/png', kind: 'image' }]), { signal: controller.signal })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))   // C1 修正：等 fetch 进入并注册 abort 监听后再 abort（AbortSignal.any 同步先触发会挂起）
      controller.abort()
      await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT, message: '附件上传已取消' })
      await backend.disconnect()
    } finally { close() }
  })
})
```

**实现注意：** `form.getAll('files')` 返回的条目是 Blob/File——node 22 FormData 的 `getAll('files')` 元素有 `.name`（filename 属性）。若 TS 报 `(f as File).name` 类型问题，用 `(f as { name?: string }).name`。

- [ ] **Step 2: 跑测试**

Run: `cd apps/desktop && npx vitest run tests/unit/real-backend-upload.spec.ts`
Expected: 4 条全过。

- [ ] **Step 3: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/tests/unit/real-backend-upload.spec.ts
git commit -m "test(阶段3 联调前整改 D2): real-backend-upload.spec——FormData 顺序/混合批次/webm 透传/响应权威/取消"
```

---

### Task 5: D2b history-viewer.store.spec.ts 失败态断言（hasSearched 保持 false）

**Files:**
- Modify: `apps/desktop/tests/unit/history-viewer.store.spec.ts`（既有「submitQuery 失败」用例补断言）

**Interfaces:**
- Consumes: `useHistoryViewerStore`、`setDesktopApi`、`createPinia`/`setActivePinia`（既有注入方式）。
- Produces: 无新导出。

- [ ] **Step 1: 扩既有失败用例断言**

`apps/desktop/tests/unit/history-viewer.store.spec.ts` 中「submitQuery 失败：保留旧结果 + 写 error（不清空聊天内容）」用例（约 :40-47）追加两条断言：

```ts
  it('submitQuery 失败：保留旧结果 + 写 error（不清空聊天内容）', async () => {
    setDesktopApi({ queryChatHistory: vi.fn(async () => { throw new Error('[HTTP_500] 服务端错误') }) } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('mOld', 'tOld')] })
    await s.submitQuery()
    expect(s.items).toHaveLength(1)          // 旧结果保留
    expect(s.error?.message).toContain('服务端错误')
    expect(s.hasSearched).toBe(false)        // 阶段3 整改 C1：失败不置 hasSearched（防「没有找到相关聊天记录」伪空态）
  })
```

- [ ] **Step 2: 跑测试**

Run: `cd apps/desktop && npx vitest run tests/unit/history-viewer.store.spec.ts`
Expected: 全过（含新断言）。

- [ ] **Step 3: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/tests/unit/history-viewer.store.spec.ts
git commit -m "test(阶段3 联调前整改 D2): 历史查看器搜索失败 hasSearched 保持 false 防伪空态"
```

---

### Task 6: D3 新增 sticker-contract.spec.ts（贴图真实契约）

**Files:**
- Create: `apps/desktop/tests/unit/sticker-contract.spec.ts`

**Interfaces:**
- Consumes: `parseRestSearchMessages`（rest-schemas.ts）、`RestMapper`（rest-mapper.ts，`toChatHistoryItem`）、`chatQueryHistorySchema`（channels.ts）、`ChatHistoryPageSchema`（ipc-response.ts）、`useHistoryViewerStore` + `setDesktopApi` + pinia。
- Produces: 无新导出；验证真实后端 `category=sticker` 响应形状可穿越 Schema→IPC 双 schema→Mapper→Store 并带跳转字段。

- [ ] **Step 1: 写 spec 文件**

`apps/desktop/tests/unit/sticker-contract.spec.ts`：

```ts
// tests/unit/sticker-contract.spec.ts
// 阶段3 联调前整改 D3（spec §4.4）：后端 category=sticker 真实形状响应 → Schema → IPC 双 schema → Mapper → History Store 可展示 + 跳转。
// env=node：fixture 驱动，无后端；store 用 setDesktopApi 注入（既有注入方式）。
import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { parseRestSearchMessages } from '../../src/main/transport/protocol-v2/rest-schemas'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import { chatQueryHistorySchema } from '../../src/main/ipc/channels'
import { ChatHistoryPageSchema } from '../../src/shared/schemas/ipc-response'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'

/** 后端 SearchMessagesResponse 真实形状（无 resource/kind/url；None 可选字段省略——wire_dict 行为） */
const realStickerSearch = {
  items: [
    // 纯贴图消息：snippet 空串、无 responseId/segmentId
    { conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: '2026-08-14T04:00:00.000Z', snippet: '' },
    // 文字+贴图消息：snippet 非空，responseId 有值、segmentId 省略
    { conversationId: 'c2', messageId: 'm2', role: 'assistant', responseId: 'gen-9', timestamp: '2026-08-14T05:00:00.000Z', snippet: '给你发了张表情' }
  ],
  has_more: false
}

describe('D3 贴图真实契约（category=sticker 真实形状）', () => {
  it('真实形状过严格 Schema（.strict 拒多余键，不伪造富化）', () => {
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(2)
      expect(parsed.data.items[0].snippet).toBe('')      // 空 snippet 可过
      expect(parsed.data.items[0].resource).toBeUndefined()  // 类型上无 resource 键
    }
  })

  it('Mapper 产可展示 ChatHistoryItem（空 snippet 缺省；conversationId/messageId 可跳转）', () => {
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const mapper = new RestMapper()
      const page = { items: parsed.data.items.map((i) => mapper.toChatHistoryItem(i)), hasMore: false }
      expect(page.items[0]).toMatchObject({ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user' })
      expect(page.items[0].snippet).toBeUndefined()       // 空 snippet 不写字段（组件显示「（无文本命中）」）
      expect(page.items[1].snippet).toBe('给你发了张表情')
      expect(page.items[1].responseId).toBe('gen-9')
      // IPC 响应方向：ChatHistoryPageSchema 校验通过
      const respOk = ChatHistoryPageSchema.safeParse(page)
      expect(respOk.success).toBe(true)
    }
  })

  it('请求方向：store 构造的 sticker 查询过 chatQueryHistorySchema', () => {
    const query = {
      scope: { type: 'all_conversations' as const },
      timeZone: 'Asia/Shanghai',
      category: 'sticker' as const,
      limit: 20
    }
    const ok = chatQueryHistorySchema.safeParse(query)
    expect(ok.success).toBe(true)
  })

  it('History Store：sticker 搜索页可展示 + jumpTo 返回跳转字段', async () => {
    setActivePinia(createPinia())
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const mapper = new RestMapper()
    const page = { items: parsed.data.items.map((i) => mapper.toChatHistoryItem(i)), hasMore: false }
    setDesktopApi({ queryChatHistory: async () => page } as never)
    const s = useHistoryViewerStore()
    s.openViewer('sticker')
    s.$patch({ category: 'sticker' })
    await s.submitQuery()
    expect(s.hasSearched).toBe(true)
    expect(s.items).toHaveLength(2)
    const hit = s.items[0]
    const jump = s.jumpTo(hit)
    expect(jump).toEqual({ conversationId: 'c1', messageId: 'm1', segmentId: undefined })
  })
})
```

**实现注意：**
- `RestMapper` 是 `rest-mapper.ts` 的具名导出（已核实）；`openViewer('sticker')` 即置 `category='sticker'`（store 实现已核实），`$patch({ category: 'sticker' })` 冗余但无害、可保留可省。
- `setDesktopApi({ queryChatHistory })` 返回类型为 `ChatHistoryPage`；`page` 形状 `{ items, hasMore }` 匹配。
- `submitQuery` 从 store 读 category 与 scope（默认 all），故 scope 无需另设。

- [ ] **Step 2: 跑测试**

Run: `cd apps/desktop && npx vitest run tests/unit/sticker-contract.spec.ts`
Expected: 4 条全过。

- [ ] **Step 3: Commit**

```bash
cd /home/yomu/elysia-frontend
git add apps/desktop/tests/unit/sticker-contract.spec.ts
git commit -m "test(阶段3 联调前整改 D3): sticker-contract.spec——贴图真实契约 Schema→IPC 双 schema→Mapper→Store 可展示+跳转"
```

---

### Task 7: 全量门禁 + 文档更新 + 提交

**Files:**
- Verify: typecheck / lint / 全部单测 / 39 集成 / build / check:contract
- Modify: `docs/review/2026-08-15-阶段3-联调前整改-决策记录.md`（新建，D1~D4 + 验收口径）
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（阶段3 跟踪表补 B-02 通过口径）
- Modify: `README.md` / `CLAUDE.md`（测试数字同步，如变化）

- [ ] **Step 1: 全量门禁**

Run（仓库根 `/home/yomu/elysia-frontend`）：
```bash
pnpm -F @cyrene/desktop typecheck
pnpm -F @cyrene/desktop lint
pnpm -F @cyrene/desktop test
pnpm -F @cyrene/desktop test:integration
pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
```
Expected: 全绿（typecheck/lint/全部单测/39 集成/build/check:contract 含 REST 段）。任一红则修至绿再进下一步。

- [ ] **Step 2: 写决策记录**

创建 `docs/review/2026-08-15-阶段3-联调前整改-决策记录.md`（**新建 dated 文件**，不并入既有 `2026-08-14-阶段3-决策记录.md`——仓库惯例按批次/日期独立记录，M4 确认）。记录：日期、前端/后端基线 SHA、5 项整改概述、D1~D4 决策表（结论+理由，从 spec §5 抄录）、验收口径（纯文本行 + 跳转正常）、已知行为（audio/webm 渲染层 20MB vs Main 50MB、贴图缩略图 P2-3 后续增强）。语言中文。

- [ ] **Step 3: 更新 docs/16 阶段3 跟踪表**

在 `docs/16-Cyrene-前端实施任务清单与进度跟踪.md` 阶段3 相关小节补一句 B-02 通过口径：搜索日期按后端自然日契约；贴图 tab 保留 `category=sticker`；所有分类 tab 搜索结果以「纯文本行 + 「消息」chip」展示、无缩略图（P2-3）不视为缺陷；`image_video` 双子流独立游标合并；「跳回来源消息/分段」正常即通过；贴图发送→搜索命中→跳转闭环纳入 B-02 验收。

- [ ] **Step 4: 测试数字同步**

`README.md` / `CLAUDE.md` 若测试数变化（新增 2 个 spec 文件、若干用例），更新数字；无变化则跳过并注明。

- [ ] **Step 5: 全量门禁复跑 + Commit**

```bash
cd /home/yomu/elysia-frontend
git add docs/review/2026-08-15-阶段3-联调前整改-决策记录.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md
git commit -m "docs(阶段3 联调前整改): 决策记录 D1-D4 + docs16 B-02 通过口径 + 测试数字同步"
```

- [ ] **Step 6: 确认无漏改**

Run: `cd apps/desktop && grep -rn "localDateToHalfOpenRange" src/ tests/ || echo "无残留"` + `git status --short`
Expected: `无残留`；工作区仅剩计划外的改动时核对。
