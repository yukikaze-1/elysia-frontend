# 阶段3 真实联调复验整改 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地阶段3 真实联调复验的 4 项前端整改——P0-01 相对签名 URL 基于 endpoint 解析、P0-02 ContentPart 可空数字 null/非法归一化、P0-03 持久化 StickerPart 恢复（用户 `Message.stickerId` + assistant sticker 分段）、P1-01 历史搜索统一 `sortKey` 升序，使附件/贴图/历史链路在真实 Windows Electron 复验中稳定。

**Architecture:** 改动集中在三层——(1) attachments（`media-service.ts` 新增 `resolveSignUrl` 纯函数 + 错误分类 + endpoint 分区缓存）；(2) protocol-v2 映射层（`content-part.ts` 可空数字归一化 helper + sticker 恢复 helper；`rest-mapper.ts` `assemble` 双路径恢复 + `compareBySortKey`；`rest-schemas.ts`/`rest-types.ts` wire 边界放行 `duration_ms:null`）；(3) transport（`real-backend.ts` 单流分支升序归一化）。全部单元级 node env，不依赖 Electron。

**Tech Stack:** TypeScript / zod v4 / Vitest / Node（`--experimental-strip-types`）

**Spec:** [docs/superpowers/specs/2026-08-15-phase3-reverify-fixes-design.md](../specs/2026-08-15-phase3-reverify-fixes-design.md)

## Global Constraints

- 复验清单 4 项 P0/P1 全部修复；§7 后端 MIME（BE-S3-RUN-P0-02）**不**在本 plan 实施——不加 audio 别名兼容层、不扩白名单。
- P0-01：相对 `sign.url` 基于 **backend baseUrl（含反代 path 前缀）** 拼接为绝对；绝对 URL 仅 `http(s)` scheme 原样放行（不强同源）；`javascript:`/`file:`/`data:`/协议相对 `//` 拒绝 → `SignedUrlResolveError`；baseUrl 缺失/畸形 → `SignedUrlResolveError`（不抛裸 `TypeError`）。
- P0-01 错误分类：`SignedUrlResolveError` → stream 500 / checkStatus `reason:'resolve_failed'`；签发表 fetch 失败 → stream 502 / checkStatus `reason:'sign_failed'`；**stream 的 catch 必须落在 `streamAttachment()` 内部**（handler blanket catch 恒 502）。
- P0-01 缓存：key = `${baseUrl 去尾斜杠}:${attachmentId}`（endpoint 身份分区）；baseUrl 缺失时**先抛不调签发表**。
- P0-02：`toOptionalNonNegativeNumber` 约束 `typeof number && Number.isFinite && >=0`，`0` 合法保留；null/负/NaN/Infinity → undefined（字段缺省，不丢媒体/消息页）；`ContentPartShape` 数字字段类型改 `unknown`；**IPC Schema（ipc-response.ts）不改**，必填 `attachmentId/kind/mediaType` 仍 fail-closed。
- P0-02 wire 边界：`RestMessageSchema.duration_ms` 改 `z.number().nullable().optional()`（`.strict()` 下放行 null）；`rest-types.ts` `RestMessage.duration_ms` 改 `number | null | undefined`。
- P0-03：`STICKER_ID_PATTERN` 单一来源在 `content-part.ts`（`media-service.ts` 改为 import）；`sticker_id` 优先、`src` 尾段**剥 `.png`** 后校验兜底；无效 `st_` ID fail-open 忽略（不设 stickerId、不拒页）；贴图**不进入** `attachments`；REST 与 WS replay 共用同一 `assemble` 映射。
- P0-03 分段：assistant sticker 分段 `segmentId` 用独立前缀 `st-${messageId}-${segIndex}`（与 `pr-`/`media-` 不撞）；用户分支 `extractStickerId(src.content)` 一次调用、first-wins。
- P1-01：领域层统一 `sortKey` 升序；`cursor` 原样透传后端返回值（不参与排序）；`image_video` 分支与单流分支共用同一比较器；store `loadMore` 合并排序保持（renderer/main 边界不复用 main 模块函数）。
- 测试全部 node env（vitest.config.mts），跑法：`cd apps/desktop && npx vitest run tests/unit/<file>`。
- 提交信息用仓库既有约定（`feat/fix/docs(范围): 中文描述`）。

---

### Task 1: P0-01 相对签名 URL 基于 endpoint 解析（media-service）

**Files:**
- Modify: `apps/desktop/src/main/attachments/media-service.ts`（新增 `SignedUrlResolveError`/`resolveSignUrl` 导出；`resolveSignedUrl` 缓存 key + baseUrl 缺失先失败；`streamAttachment` 错误分类；`checkStatus` 错误分类）
- Test: `apps/desktop/tests/unit/media-service.spec.ts`

**Interfaces:**
- Consumes: 现有 `MediaService` 构造注入 `backend.signAttachmentUrl` / `baseUrl()`；现有 `ResolvedSignedUrl {url, expiresAt}`。
- Produces: `export class SignedUrlResolveError extends Error`；`export function resolveSignUrl(signUrl: string, baseUrl: string | undefined): string`；`MediaService.resolveSignedUrl` 缓存 key 改为 `${baseUrl 去尾斜杠}:${attachmentId}`、baseUrl 缺失抛 `SignedUrlResolveError`；`streamAttachment` 返回 500（resolve）/502（sign）；`checkStatus` 返回 `reason:'resolve_failed'`（resolve）/`'sign_failed'`（sign）。

- [ ] **Step 1: 先写失败的纯函数测试（resolveSignUrl）**

`apps/desktop/tests/unit/media-service.spec.ts` 顶部 import 增加：

```ts
import { isDocumentRequest, MediaService, parseMediaPath, resolveSignUrl, SignedUrlResolveError } from '../../src/main/attachments/media-service'
```

在 `parseMediaPath / isDocumentRequest` describe 之后新增 describe（纯函数，无 IO）：

```ts
describe('resolveSignUrl（P0-01：相对签名 URL 基于 endpoint 解析，spec §4.1）', () => {
  it('相对 /api/... → 基于 baseUrl 解析为绝对（保留 query）', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s&exp=1', 'http://127.0.0.1:18765'))
      .toBe('http://127.0.0.1:18765/api/attachments/att_1?sig=s&exp=1')
  })
  it('baseUrl 含 path 前缀（反代/SSH 转发）→ 保留前缀不吞路径', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s', 'http://127.0.0.1:18765/backend-proxy'))
      .toBe('http://127.0.0.1:18765/backend-proxy/api/attachments/att_1?sig=s')
  })
  it('baseUrl 尾斜杠 → 不双斜杠', () => {
    expect(resolveSignUrl('/api/attachments/att_1?sig=s', 'http://127.0.0.1:18765/'))
      .toBe('http://127.0.0.1:18765/api/attachments/att_1?sig=s')
  })
  it('绝对 http(s) URL → 原样放行（D1：兼容对象存储 CDN）', () => {
    expect(resolveSignUrl('https://cdn.x/att_1?sig=s', 'http://127.0.0.1:18765')).toBe('https://cdn.x/att_1?sig=s')
  })
  it('异 scheme（javascript:/file:/data:）与协议相对 // → SignedUrlResolveError', () => {
    expect(() => resolveSignUrl('javascript:alert(1)', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
    expect(() => resolveSignUrl('file:///etc/passwd', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
    expect(() => resolveSignUrl('//evil.com/x', 'http://127.0.0.1:18765')).toThrow(SignedUrlResolveError)
  })
  it('baseUrl 缺失 → SignedUrlResolveError', () => {
    expect(() => resolveSignUrl('/api/attachments/att_1?sig=s', undefined)).toThrow(SignedUrlResolveError)
  })
  it('畸形 baseUrl → SignedUrlResolveError（不抛裸 TypeError）', () => {
    expect(() => resolveSignUrl('/api/x', 'not a url')).toThrow(SignedUrlResolveError)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run tests/unit/media-service.spec.ts`
Expected: FAIL（`resolveSignUrl`/`SignedUrlResolveError` 未导出）。

- [ ] **Step 3: 实现 resolveSignUrl + SignedUrlResolveError**

`apps/desktop/src/main/attachments/media-service.ts` 在常量区（`STICKER_ID_PATTERN` 之后）新增：

```ts
/** P0-01：签名 URL 解析失败（baseUrl 缺失/畸形/URL 非法）——与签发 fetch 失败区分（spec §4.1 错误分类） */
export class SignedUrlResolveError extends Error {}

/** P0-01：解析签名 URL。相对路径基于 backend baseUrl 解析为绝对（保留反代 path 前缀）；
 *  绝对 URL 仅 http(s) 原样放行（D1：兼容对象存储 CDN，不强同源）；其余 scheme/畸形/baseUrl 缺失 → 抛 SignedUrlResolveError。 */
export function resolveSignUrl(signUrl: string, baseUrl: string | undefined): string {
  if (!baseUrl) throw new SignedUrlResolveError('backend base URL is not configured')
  if (/^https?:\/\//i.test(signUrl)) return signUrl
  if (/^\/(?!\/)/.test(signUrl)) {
    try {
      return new URL(baseUrl.replace(/\/+$/, '') + signUrl).toString()   // 拼接再验证：保留 path 前缀，`new URL(signUrl, baseUrl)` 会丢反代 path
    } catch {
      throw new SignedUrlResolveError(`invalid signed URL: ${baseUrl}${signUrl}`)
    }
  }
  throw new SignedUrlResolveError(`unsupported signed URL: ${signUrl}`)
}
```

- [ ] **Step 4: 改造 resolveSignedUrl（缓存 key + baseUrl 缺失先失败）**

把 `resolveSignedUrl()`（当前 :51-59）整体替换为：

```ts
/** 签名缓存：key 按 endpoint 身份分区（D2，baseUrl 含反代 path 前缀，origin 变化必然 baseUrl 变化）；exp−5min 视为过期经 /sign 重签（D6） */
async resolveSignedUrl(attachmentId: string, opts: { force?: boolean } = {}): Promise<ResolvedSignedUrl> {
  const base = this.baseUrl()
  const cacheKey = `${(base ?? '').replace(/\/+$/, '')}:${attachmentId}`
  const cached = this.cache.get(cacheKey)
  if (!opts.force && cached && cached.expiresAt - this.now() > RE_SIGN_LEEWAY_MS) return cached
  if (!base) throw new SignedUrlResolveError('backend base URL is not configured')   // P0-01：不调签发表，先失败
  const sign: AttachmentSignResult = await this.backend.signAttachmentUrl(attachmentId)
  const url = resolveSignUrl(sign.url, base)
  const expires = Date.parse(sign.expiresAt)
  // P2-6：非法 expiresAt（NaN/非有限）→ 降级短窗口缓存（防 NaN 恒重签放大请求）；URL 实际过期由流 401/403 重签兜底
  const entry: ResolvedSignedUrl = { url, expiresAt: Number.isFinite(expires) ? expires : this.now() + INVALID_EXPIRY_FALLBACK_MS }
  this.cache.set(cacheKey, entry)
  return entry
}
```

- [ ] **Step 5: 改造 streamAttachment（错误分类：resolve→500 / sign→502）**

把 `streamAttachment()`（当前 :86-102）的 `let signed = await this.resolveSignedUrl(attachmentId)` 段替换为（其余 Range/Accept/重签/410 逻辑不变）：

```ts
  let signed: ResolvedSignedUrl
  try {
    signed = await this.resolveSignedUrl(attachmentId)
  } catch (e) {
    // P0-01 错误分类：解析失败（baseUrl 缺失/URL 非法）→ 500 可诊断；签发表 fetch 失败 → 502 transient（P2-4）
    if (e instanceof SignedUrlResolveError) return new Response('Signed URL invalid', { status: 500 })
    return new Response('Bad Gateway', { status: 502 })
  }
```

（重签分支 `signed = await this.resolveSignedUrl(attachmentId, { force: true })` 保持不包 catch——base 已在上一步验证，重签瞬时失败冒泡到 handler 的 blanket 502 属可接受 transient。）

- [ ] **Step 6: 改造 checkStatus（错误分类：resolve_failed / sign_failed）**

把 `checkStatus()`（当前 :145-163）的 catch 段替换为：

```ts
  let signed: ResolvedSignedUrl
  try {
    signed = await this.resolveSignedUrl(attachmentId, { force: true })
  } catch (e) {
    return { status: 'error', reason: e instanceof SignedUrlResolveError ? 'resolve_failed' : 'sign_failed' }
  }
```

（Range-0 探测分支不变。）

- [ ] **Step 7: 追加 service 级集成测试（相对 URL 全链路 + 错误分类 + endpoint 隔离）**

`apps/desktop/tests/unit/media-service.spec.ts` 在 `MediaService.stream attachment 分支` describe 之后新增：

```ts
describe('MediaService P0-01 相对签名 URL 全链路（spec §4.1）', () => {
  it('相对 sign.url → stream 请求绝对 URL（Range/206 透传）', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=s`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toBe('http://127.0.0.1:9/api/attachments/att_1?sig=s')
      return new Response(new Uint8Array(64), { status: 206, headers: { 'content-type': 'video/mp4' } })
    })
    const svc = mkService({ sign, fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'video' } }))
    expect(res.status).toBe(206)
  })
  it('相对 sign.url → checkStatus 请求绝对 URL → ok', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=s`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      expect(String(u)).toBe('http://127.0.0.1:9/api/attachments/att_1?sig=s')
      return new Response('', { status: 200 })
    })
    const svc = mkService({ sign, fetchImpl })
    expect((await svc.checkStatus('att_1')).status).toBe('ok')
  })
  it('baseUrl 缺失 → 不调签发表、stream 500、checkStatus resolve_failed', async () => {
    const sign = vi.fn(async () => ({ url: '/api/attachments/att_1?sig=s', expiresAt: 'x' }))
    const svc = new MediaService({ backend: { signAttachmentUrl: sign }, baseUrl: () => undefined, now })
    const streamRes = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(streamRes.status).toBe(500)
    const cs = await svc.checkStatus('att_1')
    expect(cs.status).toBe('error')
    expect(cs.reason).toBe('resolve_failed')
    expect(sign).not.toHaveBeenCalled()
  })
  it('签发表 fetch 失败（非解析问题）→ stream 502、checkStatus sign_failed', async () => {
    const sign = vi.fn(async () => { throw new Error('net down') })
    const svc = mkService({ sign })
    const streamRes = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(streamRes.status).toBe(502)
    const cs = await svc.checkStatus('att_1')
    expect(cs.status).toBe('error')
    expect(cs.reason).toBe('sign_failed')
  })
  it('endpoint 变化（baseUrl 变化）→ 不复用旧缓存、重签且新 base 生效（D2 分区）', async () => {
    let base = 'http://127.0.0.1:9'
    let count = 0
    const sign = vi.fn(async (id: string) => ({ url: `/api/attachments/${id}?sig=${++count}`, expiresAt: new Date(now() + 3600_000).toISOString() }))
    const svc = new MediaService({ backend: { signAttachmentUrl: sign }, baseUrl: () => base, now })
    const a = await svc.resolveSignedUrl('att_1')
    base = 'http://127.0.0.1:9999'
    const b = await svc.resolveSignedUrl('att_1')
    expect(a.url).not.toBe(b.url)
    expect(b.url).toBe('http://127.0.0.1:9999/api/attachments/att_1?sig=2')
    expect(sign).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 8: 跑测试确认全过**

Run: `cd apps/desktop && npx vitest run tests/unit/media-service.spec.ts`
Expected: 全部 PASS（既有绝对 fixture 用例在 D1 下原样放行，不回归）。

- [ ] **Step 9: typecheck + commit**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 无新错误。

```bash
git add apps/desktop/src/main/attachments/media-service.ts apps/desktop/tests/unit/media-service.spec.ts
git commit -m "fix(阶段3 真实联调复验 P0-01): 相对签名 URL 基于 endpoint 解析——resolveSignUrl + 错误分类 + endpoint 分区缓存"
```

---

### Task 2: P0-02 ContentPart 可空数字归一化 + wire 边界放行 null

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/content-part.ts`（`toOptionalNonNegativeNumber`；`ContentPartShape` 数字字段改 `unknown`；`toMedia` 四字段用 helper）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（`MessageSource.duration_ms` 类型同步；tool 块 `duration_ms` 用 helper）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts`（`RestMessageSchema.duration_ms` → `z.number().nullable().optional()`）
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`（WS replay wire 边界 `duration_ms` → `z.number().nullable().optional()`，三条恢复路径一致）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-types.ts`（`RestMessage.duration_ms` → `number | null | undefined`）
- Test: `apps/desktop/tests/unit/content-part.spec.ts`、`apps/desktop/tests/unit/rest-mapper.spec.ts`、`apps/desktop/tests/unit/rest-schemas.spec.ts`、`apps/desktop/tests/unit/raw-schemas.spec.ts`

**Interfaces:**
- Consumes: 现有 `MappedMedia`（保持 `number | undefined`）；现有 `MessageToolInfo.durationMs?: number`（领域，不变）。
- Produces: `export function toOptionalNonNegativeNumber(v: unknown): number | undefined`（content-part.ts）；`RestMessageSchema` 接受 `duration_ms:null`；raw wire schema 接受 `duration_ms:null`；`RestMessage.duration_ms: number | null | undefined`；`MessageSource.duration_ms: number | null | undefined`。

- [ ] **Step 1: 先写失败的测试（content-part 归一化 + rest-mapper tool null + wire schema null）**

`apps/desktop/tests/unit/content-part.spec.ts` import 增加 `toOptionalNonNegativeNumber`，并在 `mapContentMedia` describe 之后新增：

```ts
describe('toOptionalNonNegativeNumber（P0-02：可空数字归一化，spec §4.2）', () => {
  it('合法数字与 0 保留；undefined 缺省', () => {
    expect(toOptionalNonNegativeNumber(100)).toBe(100)
    expect(toOptionalNonNegativeNumber(0)).toBe(0)
    expect(toOptionalNonNegativeNumber(undefined)).toBeUndefined()
  })
  it('null/负/NaN/Infinity/字符串 → undefined', () => {
    expect(toOptionalNonNegativeNumber(null)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(-1)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(NaN)).toBeUndefined()
    expect(toOptionalNonNegativeNumber(Infinity)).toBeUndefined()
    expect(toOptionalNonNegativeNumber('100')).toBeUndefined()
  })
})

describe('mapContentMedia / mapContentToEntries 可空数字（P0-02）', () => {
  it('image width:null,height:null → 领域不含两字段且媒体保留', () => {
    const atts = mapContentMedia([{ type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', width: null, height: null }])
    expect(atts).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }])
  })
  it('audio duration_ms:null、file size_bytes:null → 条目不含该字段', () => {
    const entries = mapContentToEntries([
      { type: 'audio', src: '/api/attachments/att_2', mime: 'audio/mpeg', attachment_id: 'att_2', duration_ms: null },
      { type: 'file', src: '/api/attachments/att_3', mime: 'application/pdf', attachment_id: 'att_3', size_bytes: null }
    ])
    expect(entries[0]).toMatchObject({ type: 'media', media: { kind: 'audio', attachmentId: 'att_2' } })
    expect(entries[1]).toMatchObject({ type: 'media', media: { kind: 'file', attachmentId: 'att_3' } })
    expect((entries[0] as { media: { durationMs?: number } }).media.durationMs).toBeUndefined()
  })
})
```

`apps/desktop/tests/unit/rest-mapper.spec.ts` 在 `describe('RestMapper')` 块内（既有 tool 用例 :42 之后）新增：

```ts
  it('tool 消息 duration_ms:null → 领域无 durationMs（P0-02 wire 放行 null 后归一化）', () => {
    const raw: RestMessage = { role: 'tool', content: '已执行', message_id: 'msg-t', timestamp: '2026-08-11T00:00:01.000Z', session_id: 'conv-1', duration_ms: null, tool_name: 'desktop.file.read' }
    const m = mapper.toDomainMessage(raw)
    expect(m.tool).toEqual({ name: 'desktop.file.read' })
  })
```

（`RestMessage.duration_ms` 类型在 Task 2 改为 `number | null | undefined` 后本 fixture 通过 typecheck。）

`apps/desktop/tests/unit/rest-schemas.spec.ts` 在 `REST wire schema` describe 内新增：

```ts
  it('Message 顶层 duration_ms:null 通过（P0-02 wire 边界放行，映射层归一化）', () => {
    const withNull = { ...validMessage, duration_ms: null }
    expect(parseRestMessage(withNull).success).toBe(true)
  })
  it('parseRestMessagesPage 一页含 null duration_ms → success（单字段 null 不拒整页）', () => {
    const page = {
      messages: [
        { role: 'tool', message_id: 'm1', timestamp: '2026-08-11T00:00:00.000Z', duration_ms: null },
        { role: 'user', message_id: 'm2', timestamp: '2026-08-11T00:00:01.000Z', content: 'hi' }
      ],
      has_more: false, total: 2
    }
    expect(parseRestMessagesPage(page).success).toBe(true)
  })
```

`apps/desktop/tests/unit/raw-schemas.spec.ts` 在 `describe('raw wire schema')` 内新增（WS replay wire 边界同款，三条恢复路径一致；`parseRawFrame` 已导入，session 帧形状照 :24-38）：

```ts
  it('session 帧 tool duration_ms:null 通过（P0-02 replay wire 边界放行，映射层归一化）', () => {
    const session = {
      type: 'session', conversationId: 'conv-1',
      messages: [{ role: 'tool', message_id: 'm1', timestamp: '2026-08-11T00:00:00.000Z', duration_ms: null }],
      token_stats: { total: 0, byModel: {} }
    }
    expect(parseRawFrame(session).success).toBe(true)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run tests/unit/content-part.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/rest-schemas.spec.ts tests/unit/raw-schemas.spec.ts`
Expected: FAIL——`toOptionalNonNegativeNumber` 未导出；`duration_ms:null` 被 `RestMessageSchema`/raw schema 拒（rest-schemas 两用例 + raw-schemas 一用例 fail）；rest-mapper tool null 用例 fail（`m.tool` 含 `durationMs: null`；vitest 不 typecheck，fixture 运行无碍）。

- [ ] **Step 3: 实现 toOptionalNonNegativeNumber + ContentPartShape 字段改 unknown + toMedia 用 helper**

`apps/desktop/src/main/transport/protocol-v2/content-part.ts`：

在 `MappedMedia` 之后新增导出函数：

```ts
/** P0-02：wire 可空数字 → 领域数字。仅 typeof number 且有限且 >=0 保留；null/负/NaN/Infinity → undefined（缺省，不污染 IPC） */
export function toOptionalNonNegativeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
```

`ContentPartShape` 数字字段类型改 `unknown`（诚实反映 wire：JSON `null` 经 `z.unknown()` 可达映射层）：

```ts
interface ContentPartShape {
  type?: string
  src?: string
  mime?: string
  attachment_id?: string
  filename?: string
  size_bytes?: unknown   // P0-02：JSON 可为 null，映射层归一化
  width?: unknown
  height?: unknown
  duration_ms?: unknown
}
```

`toMedia()` 替换为（四数字字段经 helper，`MappedMedia` 形状不变）：

```ts
function toMedia(part: ContentPartShape, kind: 'image' | 'video' | 'audio' | 'file'): MappedMedia {
  const attachmentId = part.attachment_id ?? parseAttachmentIdFromSrc(part.src)
  const size = toOptionalNonNegativeNumber(part.size_bytes)
  const width = toOptionalNonNegativeNumber(part.width)
  const height = toOptionalNonNegativeNumber(part.height)
  const durationMs = toOptionalNonNegativeNumber(part.duration_ms)
  return {
    kind,
    ...(attachmentId ? { attachmentId } : {}),
    ...(part.src ? { url: part.src } : {}),
    ...(part.mime ? { mediaType: part.mime } : {}),
    ...(part.filename ? { name: part.filename } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationMs !== undefined ? { durationMs } : {})
  }
}
```

- [ ] **Step 4: 实现 rest-mapper tool 块归一化 + MessageSource 类型同步**

`apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`：
- import 行（第 7 行 `import { mapContentMedia, mapContentToEntries } from './content-part'`）追加 `toOptionalNonNegativeNumber`。
- **`MessageSource.duration_ms`（:26）类型改 `number | null | undefined`**——`RestMessage.duration_ms` 改 nullable 后，`assemble({ ...raw }, ...)`（:34 `{ ...raw }: RestMessage`）必须可赋给 `MessageSource.duration_ms`，否则 Task Step 7 `tsc --noEmit` 报 `TS2345 'null' not assignable to 'number | undefined'`。
- `assemble()` tool 块（当前 :131）`if (src.duration_ms !== undefined) tool.durationMs = src.duration_ms` 替换为：

```ts
  const toolDurationMs = toOptionalNonNegativeNumber(src.duration_ms)
  if (toolDurationMs !== undefined) tool.durationMs = toolDurationMs
```

- [ ] **Step 5: 实现 wire 边界放行 null（REST + WS replay）**

`apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts`（:36）：
```ts
  duration_ms: z.number().nullable().optional(),   // P0-02：wire 边界接受 null，映射层归一化（不扩散到领域/IPC）
```

`apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`（:42）：
```ts
  duration_ms: z.number().nullable().optional(),   // P0-02：WS replay wire 边界同款（三条恢复路径一致，否则 replay tool null 整段拒）
```

`apps/desktop/src/main/transport/protocol-v2/rest-types.ts`（:30）：
```ts
  duration_ms?: number | null   // P0-02：JSON 可为 null（wire 类型诚实反映）
```

- [ ] **Step 6: 跑测试确认全过**

Run: `cd apps/desktop && npx vitest run tests/unit/content-part.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/rest-schemas.spec.ts tests/unit/raw-schemas.spec.ts`
Expected: 全部 PASS。

- [ ] **Step 7: typecheck + commit**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 无新错误（含 `MessageSource.duration_ms` nullable 同步）。

```bash
git add apps/desktop/src/main/transport/protocol-v2/content-part.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/src/main/transport/protocol-v2/rest-types.ts apps/desktop/tests/unit/content-part.spec.ts apps/desktop/tests/unit/rest-mapper.spec.ts apps/desktop/tests/unit/rest-schemas.spec.ts apps/desktop/tests/unit/raw-schemas.spec.ts
git commit -m "fix(阶段3 真实联调复验 P0-02): ContentPart 可空数字 null/非法归一化为字段缺省 + REST/replay wire 边界放行 duration_ms null"
```

---

### Task 3: P0-03 StickerPart 恢复（用户 Message.stickerId + assistant sticker 分段）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/content-part.ts`（`STICKER_ID_PATTERN` 从 `@shared/domain` 导入并 re-export；`stickerIdOf`/`extractStickerId`；`mapContentToEntries` sticker 分支 + 返回类型扩展）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（`assemble` 用户分支 stickerId + typed parts 文本；assistant sticker 分段）
- Modify: `apps/desktop/src/main/attachments/media-service.ts`（:11 本地 `STICKER_ID_PATTERN` 改为从 content-part import）
- Test: `apps/desktop/tests/unit/content-part.spec.ts`、`apps/desktop/tests/unit/rest-mapper.spec.ts`、`apps/desktop/tests/unit/message.store.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `content-part.ts`（同一文件后续修改）；Task 1 的 `media-service.ts`（改 import）；现有 `Message.stickerId?` / `AssistantSegment.stickerId?` / `SegmentKind 'sticker'`；`@shared/domain` 的 `STICKER_ID_PATTERN` / `stickerIdFromResourceUrl`（sticker-url.ts 既有、已测）。
- Produces: `export { STICKER_ID_PATTERN }`（content-part 从 `@shared/domain` re-export，main 层门面）；`export function stickerIdOf(part: unknown): string | undefined`；`export function extractStickerId(content: unknown): string | undefined`；`mapContentToEntries` 返回类型含 `{ type: 'sticker'; stickerId: string }`。

- [ ] **Step 1: 先改失败的测试（content-part sticker 新语义 + rest-mapper 恢复 + store ACK 迁移）**

`apps/desktop/tests/unit/content-part.spec.ts`：
- import 追加 `extractStickerId, stickerIdOf, STICKER_ID_PATTERN`（不新增 `parseStickerIdFromSrc`——src 兜底委托 `stickerIdFromResourceUrl`，sticker-url.spec 已覆盖）。
- **更新 :37-39 旧断言**（原 `'sticker ContentPart 不产媒体条目/附件（G4 边界）'`）：

```ts
  it('sticker ContentPart → sticker 条目（assistant 分段）；mapContentMedia 不产附件（P0-03）', () => {
    expect(mapContentToEntries([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }]))
      .toEqual([{ type: 'sticker', stickerId: 'st_1' }])
    expect(mapContentMedia([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }])).toEqual([])
  })
```

- 新增 describe：

```ts
describe('sticker 恢复 helpers（P0-03，spec §4.3）', () => {
  it('stickerIdOf：sticker_id 优先；src 经 stickerIdFromResourceUrl 兜底（真实 /static/stickers/{id}.png）；非法拒绝', () => {
    expect(stickerIdOf({ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' })).toBe('st_1')
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/st_2.png' })).toBe('st_2')        // src 兜底（真实形态）
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/bad.png' })).toBeUndefined()      // 非 st_ 前缀拒
    expect(stickerIdOf({ type: 'sticker', src: '/static/stickers/st_1.jpeg' })).toBeUndefined()    // 非 .png 拒
    expect(stickerIdOf({ type: 'sticker' })).toBeUndefined()
    expect(stickerIdOf(null)).toBeUndefined()
    expect(stickerIdOf({ type: 'image' })).toBeUndefined()
  })
  it('extractStickerId：整数组扫描 first-wins；单 part 亦可；无 → undefined', () => {
    expect(extractStickerId([{ type: 'text', text: '见图' }, { type: 'sticker', sticker_id: 'st_1', src: '/s.png' }, { type: 'sticker', sticker_id: 'st_2', src: '/s.png' }])).toBe('st_1')
    expect(extractStickerId({ type: 'sticker', sticker_id: 'st_3' })).toBe('st_3')
    expect(extractStickerId([{ type: 'text', text: 'x' }])).toBeUndefined()
    expect(extractStickerId('plain')).toBeUndefined()
    expect(extractStickerId(undefined)).toBeUndefined()
  })
  it('STICKER_ID_PATTERN 单一来源：@shared/domain re-export 与媒体代理一致', () => {
    expect(STICKER_ID_PATTERN.test('st_abc-1')).toBe(true)
    expect(STICKER_ID_PATTERN.test('ST_1')).toBe(false)
    expect(STICKER_ID_PATTERN.test('st_1.png')).toBe(false)
  })
})
```

`apps/desktop/tests/unit/rest-mapper.spec.ts` 在 `describe('RestMapper')` 块内新增（放在既有 P0-02 tool 用例之后）：

```ts
  it('user 纯贴图 content → Message.stickerId（content 缺省）', () => {
    const raw: RestMessage = {
      role: 'user', content: [{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }],
      message_id: 'msg-st1', timestamp: '2026-08-11T00:00:07.000Z', session_id: 'conv-1'
    }
    const m = mapper.toDomainMessage(raw)
    expect(m.stickerId).toBe('st_1')
    expect(m.content).toBeUndefined()
    expect(m.attachments).toBeUndefined()   // 贴图不进入附件
  })
  it('user 文字+贴图 content（typed parts）→ content 与 stickerId 并存', () => {
    const raw: RestMessage = {
      role: 'user', content: [{ type: 'text', text: '你看这个' }, { type: 'sticker', sticker_id: 'st_2', src: '/static/stickers/st_2.png' }],
      message_id: 'msg-st2', timestamp: '2026-08-11T00:00:08.000Z', session_id: 'conv-1'
    }
    const m = mapper.toDomainMessage(raw)
    expect(m.content).toBe('你看这个')
    expect(m.stickerId).toBe('st_2')
  })
  it('assistant 贴图 content → sticker 分段（kind sticker + stickerId + st- 前缀不撞段）', () => {
    const raw: RestMessage = {
      role: 'assistant', content: [{ type: 'text', text: '回复' }, { type: 'sticker', sticker_id: 'st_3', src: '/static/stickers/st_3.png' }],
      message_id: 'msg-st3', timestamp: '2026-08-11T00:00:09.000Z', session_id: 'conv-1'
    }
    const m = mapper.toDomainMessage(raw)
    const segs = m.assistantSegments ?? []
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'sticker'])
    expect(segs[1]).toMatchObject({ kind: 'sticker', stickerId: 'st_3', channel: 'public_reply', completed: true })
    expect(segs[1].segmentId).toMatch(/^st-msg-st3-1$/)
  })
  it('toDomainMessageFromReplay：同一 StickerPart → 相同 stickerId（REST/replay 共用 assemble）', () => {
    const raw: RawSessionMessageItem = {
      role: 'user', content: [{ type: 'sticker', sticker_id: 'st_4', src: '/static/stickers/st_4.png' }],
      message_id: 'msg-st4', timestamp: '2026-08-11T00:00:10.000Z'
    }
    const m = mapper.toDomainMessageFromReplay(raw, 'conv-1')
    expect(m.stickerId).toBe('st_4')
  })
  it('非法 sticker ID / 任意外部 src → 不设 stickerId（fail-open，不拒页）', () => {
    const raw: RestMessage = {
      role: 'user', content: [{ type: 'sticker', sticker_id: 'bad', src: 'https://evil.example/x.png' }],
      message_id: 'msg-st5', timestamp: '2026-08-11T00:00:11.000Z', session_id: 'conv-1'
    }
    const m = mapper.toDomainMessage(raw)
    expect(m.stickerId).toBeUndefined()
  })
```

（`RawSessionMessageItem` 已在 rest-mapper.spec.ts 使用，见既有 `toDomainMessageFromReplay` 用例 :48。）

`apps/desktop/tests/unit/message.store.spec.ts` 在 `乐观发送` 用例（:108）之后新增：

```ts
  it('乐观贴图消息 ACK ID 迁移后保留 stickerId；恢复对象合并不重复不丢（P0-03 §5.4）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1', serverMessageId: 'msg-srv-1' })
    const store = useMessageStore()
    await store.send('', 'st_1')
    const optimistic = Object.values(store.byId).find((m) => m.role === 'user')
    expect(optimistic?.messageId).toBe('msg-srv-1')      // migrateKey 迁移
    expect(optimistic?.stickerId).toBe('st_1')            // stickerId 保留
    const recovered: Message = { messageId: 'msg-srv-1', conversationId: 'conv-1', role: 'user', status: 'completed', createdAt: optimistic!.createdAt, stickerId: 'st_1' }
    store.loadReplay('conv-1', [recovered])
    const msgs = Object.values(store.byId).filter((m) => m.messageId === 'msg-srv-1')
    expect(msgs).toHaveLength(1)                          // 不重复
    expect(msgs[0].stickerId).toBe('st_1')                // 不丢
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run tests/unit/content-part.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/message.store.spec.ts`
Expected: 新 helpers 未导出（module-load FAIL）；`mapContentToEntries` 对 sticker 仍返回 `[]`（content-part 边界断言 FAIL）；rest-mapper 不恢复 stickerId/文本（user/assistant/replay 用例 FAIL）。**注意：message.store.spec 的 ACK 迁移用例是防御性测试——`migrateKey`/`loadReplay` 现状已保留 stickerId 且 byId 去重，该用例对当前代码即绿（与 Task 4 store 防御用例同理）**；它的价值是守护 store 侧不改坏，Step 2 中出现绿不视为问题。

- [ ] **Step 3: 实现 content-part sticker helpers + mapContentToEntries 分支**

`apps/desktop/src/main/transport/protocol-v2/content-part.ts`：
- 顶部 import 区新增（`@shared/domain` 为单一来源，[sticker-url.ts](../../../apps/desktop/src/shared/domain/sticker-url.ts) 既有已测）：

```ts
import { STICKER_ID_PATTERN, stickerIdFromResourceUrl } from '@shared/domain'
export { STICKER_ID_PATTERN }   // P0-03：main 层门面 re-export（media-service 代理白名单 import 复用，免第三份拷贝）
```

- 新增两个 helper（放在 `parseAttachmentIdFromSrc` 之后）：

```ts
/** P0-03：单个 sticker ContentPart → 合法 stickerId（sticker_id 优先，src 经 stickerIdFromResourceUrl 兜底（剥 .png+校验）；无效/缺 → undefined） */
export function stickerIdOf(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  const p = part as { sticker_id?: unknown; src?: unknown }
  if (typeof p.sticker_id === 'string' && STICKER_ID_PATTERN.test(p.sticker_id)) return p.sticker_id
  return typeof p.src === 'string' ? stickerIdFromResourceUrl(p.src) : undefined
}

/** P0-03：content（整数组）→ 首个合法 stickerId（first-wins，D3）；单 part 亦可；无效/缺 → undefined */
export function extractStickerId(content: unknown): string | undefined {
  if (Array.isArray(content)) {
    for (const p of content) {
      if (typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'sticker') {
        const id = stickerIdOf(p)
        if (id) return id
      }
    }
    return undefined
  }
  return stickerIdOf(content)
}
```

- `mapContentToEntries`（:57-71）替换为（加 sticker 分支，返回类型含 sticker）：

```ts
export function mapContentToEntries(content: unknown): Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia } | { type: 'sticker'; stickerId: string }> {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const entries: Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia } | { type: 'sticker'; stickerId: string }> = []
  for (const p of content) {
    if (typeof p !== 'object' || p === null) continue
    const part = p as ContentPartShape & { text?: unknown }
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      entries.push({ type: 'text', text: part.text })
    } else if (part.type === 'image' || part.type === 'video' || part.type === 'audio' || part.type === 'file') {
      entries.push({ type: 'media', media: toMedia(part, part.type) })
    } else if (part.type === 'sticker') {
      const stickerId = stickerIdOf(part)
      if (stickerId) entries.push({ type: 'sticker', stickerId })   // P0-03：无效 st_ 忽略（fail-open）
    }
    // 未知 type：忽略（宽容）
  }
  return entries
}
```

- `mapContentMedia`（:75-94）**不变**——已 `if (entry.type !== 'media') continue`，sticker 条目天然不进入附件。

- [ ] **Step 4: 实现 rest-mapper assemble 双路径**

`apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`：
- import 行（:7）追加 `extractStickerId`。
- `assemble()` 用户分支（:90-91）改为（**`extractStickerId` 收敛 `role === 'user'` 独立作用域**——tool 消息不设 stickerId，与 spec §4.3「用户分支」一致）：

```ts
    if (role === 'user' || role === 'tool') {
      base.content = extractText(src.content, src.parts)
    } else if (role === 'assistant') {
```
- 在 content 赋值之后（`assemble` 内、tool 元数据块之前）追加：

```ts
    if (role === 'user') {
      const stickerId = extractStickerId(src.content)
      if (stickerId) base.stickerId = stickerId   // P0-03：用户贴图消息恢复 Message.stickerId（first-wins）
    }
```

- `extractText`（:142-153）改为（typed parts「文字+贴图」文本经 `mapContentToEntries` 提取，与 assistant 文本同源）：

```ts
/** 提取纯文本:content 为 string 优先;否则 typed parts 经 mapContentToEntries 提取 type:'text'(P0-03 文字+贴图);
 *  再退 parts 旧形状 `{content:string}[]`(assistant content/parts 同文本时不重复)。 */
function extractText(content: unknown, parts?: unknown[]): string | undefined {
  if (typeof content === 'string' && content.length > 0) return content
  const fromEntries = mapContentToEntries(content)
    .filter((e) => e.type === 'text')
    .map((e) => (e as { type: 'text'; text: string }).text)
    .join('')
  if (fromEntries.length > 0) return fromEntries
  const joined = (parts ?? []).reduce<string>((acc, p) => {
    if (typeof p === 'object' && p !== null && 'content' in p) {
      const c = (p as { content?: unknown }).content
      if (typeof c === 'string') return acc + c
    }
    return acc
  }, '')
  return joined.length > 0 ? joined : undefined
}
```

- `assemble()` assistant 分段循环的 `else` 分支（:104-118）拆分为 media 与 sticker 两分支：

```ts
        } else if (entry.type === 'media') {
          segments.push({
            segmentId: `media-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply',
            kind: entry.media.kind, completed: true,
            ...(entry.media.attachmentId ? { attachmentId: entry.media.attachmentId } : {}),
            ...(entry.media.url ? { url: entry.media.url } : {}),
            ...(entry.media.mediaType ? { mediaType: entry.media.mediaType } : {}),
            ...(entry.media.name ? { name: entry.media.name } : {}),
            ...(entry.media.size !== undefined ? { size: entry.media.size } : {}),
            ...(entry.media.width !== undefined ? { width: entry.media.width } : {}),
            ...(entry.media.height !== undefined ? { height: entry.media.height } : {}),
            ...(entry.media.durationMs !== undefined ? { durationMs: entry.media.durationMs } : {})
          })
          segIndex += 1
        } else if (entry.type === 'sticker') {
          segments.push({   // P0-03：assistant sticker 分段（st- 前缀不撞 pr-/media-）
            segmentId: `st-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply',
            kind: 'sticker', stickerId: entry.stickerId, completed: true
          })
          segIndex += 1
        }
```

- [ ] **Step 5: 实现 media-service 单一来源 import**

`apps/desktop/src/main/attachments/media-service.ts`：
- :11 删除 `const STICKER_ID_PATTERN = /^st_[A-Za-z0-9-]+$/`。
- 文件顶部 import 区新增：`import { STICKER_ID_PATTERN } from '../transport/protocol-v2/content-part'`。

- [ ] **Step 6: 跑测试确认全过**

Run: `cd apps/desktop && npx vitest run tests/unit/content-part.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/message.store.spec.ts tests/unit/media-service.spec.ts`
Expected: 全部 PASS（media-service 既有 sticker 白名单用例经 import 后行为不变）。

- [ ] **Step 7: typecheck + commit**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 无新错误。

```bash
git add apps/desktop/src/main/transport/protocol-v2/content-part.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/src/main/attachments/media-service.ts apps/desktop/tests/unit/content-part.spec.ts apps/desktop/tests/unit/rest-mapper.spec.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "fix(阶段3 真实联调复验 P0-03): StickerPart 恢复——用户 Message.stickerId + assistant sticker 分段（REST/replay 共用 assemble）"
```

---

### Task 4: P1-01 历史搜索统一 sortKey 升序

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（export `compareBySortKey`）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（:667-671 单流升序；:685-686 image_video 复用比较器）
- Test: `apps/desktop/tests/unit/real-backend-search.spec.ts`、`apps/desktop/tests/unit/history-viewer.store.spec.ts`

**Interfaces:**
- Consumes: 现有 `ChatHistoryItem.sortKey`（`${timestamp}|${messageId}` 稳定次键，rest-mapper `toChatHistoryItem` 产出）。
- Produces: `export function compareBySortKey(a: ChatHistoryItem, b: ChatHistoryItem): number`（rest-mapper.ts）。

- [ ] **Step 1: 先改测试（单流升序 + 二页升序/cursor 原样 + store loadMore DESC 页防御）**

`apps/desktop/tests/unit/real-backend-search.spec.ts`：
- `apiServer` 的 options 增加可选 `searchBody`（返回体可变，供排序用例返回 DESC 页）：

```ts
function apiServer(opts: { onSearch?: (url: string) => void; onContext?: (url: string) => void; onStickers?: () => void; searchBody?: (url: string) => unknown }): Promise<{ port: number; close(): void }> {
  ...
      if (req.url?.startsWith('/api/search/messages')) {
        opts.onSearch?.(req.url)
        send(opts.searchBody ? opts.searchBody(req.url) : { items: [{ conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '命中' }], has_more: false })
      }
```

- 在 `queryChatHistory` describe 内新增两用例：

```ts
  it('单流（all）首屏按 sortKey 升序：后端 DESC [newer, older] → 领域 [older, newer]；cursor 原样（P1-01 §6.4）', async () => {
    const { port, close } = await apiServer({
      searchBody: () => ({
        items: [
          { conversationId: 'c1', messageId: 'm2', timestamp: '2026-08-14T02:00:02.000Z', role: 'user', snippet: '新' },
          { conversationId: 'c1', messageId: 'm1', timestamp: '2026-08-14T02:00:01.000Z', role: 'user', snippet: '旧' }
        ],
        has_more: true, cursor: 'cur-2'
      })
    })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, query: 'x', timeZone: 'Asia/Shanghai', category: 'all', limit: 50 })
      expect(page.items.map((i) => i.messageId)).toEqual(['m1', 'm2'])   // 领域升序
      expect(page.nextCursor).toBe('cur-2')                               // cursor 原样透传
      await backend.disconnect()
    } finally { close() }
  })
  it('单流第二页（更旧）同样升序；cursor 参数原样发给后端', async () => {
    const seen: string[] = []
    const { port, close } = await apiServer({
      onSearch: (u) => seen.push(u),
      searchBody: () => ({ items: [{ conversationId: 'c1', messageId: 'm0', timestamp: '2026-08-14T02:00:00.000Z', role: 'user', snippet: '更旧' }], has_more: false })
    })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const page = await backend.queryChatHistory({ scope: { type: 'all_conversations' }, query: 'x', timeZone: 'Asia/Shanghai', category: 'all', limit: 50, cursor: 'cur-2' })
      expect(seen[0]).toContain('cursor=cur-2')
      expect(page.items.map((i) => i.messageId)).toEqual(['m0'])
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
      await backend.disconnect()
    } finally { close() }
  })
```

`apps/desktop/tests/unit/history-viewer.store.spec.ts` 在 `loadMore` 用例之后新增（防御：即使 transport 回 DESC 页，store loadMore 合并仍全局升序、去重、不翻转）：

```ts
  it('loadMore 收到 DESC 更旧页（含与首屏重叠项）→ 合并后仍全局升序、去重、不整表翻转（P1-01 §6.4）', async () => {
    setDesktopApi({
      queryChatHistory: async () => ({
        items: [item('m1', 't1'), item('m0', 't0')],   // 更旧页后端 DESC：[m1 较新在前, m0 更旧在后]，m1 与首屏重叠
        hasMore: false, nextCursor: undefined
      })
    } as never)
    const s = useHistoryViewerStore()
    s.openViewer()
    s.$patch({ items: [item('m1', 't1'), item('m2', 't2')], hasMore: true, nextCursor: 'cur-2' })   // 首屏已升序
    await s.loadMore()
    expect(s.items.map((i) => i.messageId)).toEqual(['m0', 'm1', 'm2'])   // 全局升序、m1 去重、无翻转
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run tests/unit/real-backend-search.spec.ts tests/unit/history-viewer.store.spec.ts`
Expected: 单流升序用例 FAIL（当前单流透传 DESC → `['m2','m1']`）；store 防御用例 PASS（store loadMore 已升序——该用例此时是绿的是允许的，它的作用是守护 store 侧不改坏）。

- [ ] **Step 3: 实现 compareBySortKey + 单流/双流统一**

`apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts` 文件底部新增导出：

```ts
/** P1-01：历史项稳定升序比较（sortKey 含 timestamp|messageId 稳定次键；单流/image_video/store 同款） */
export function compareBySortKey(a: ChatHistoryItem, b: ChatHistoryItem): number {
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
}
```

`apps/desktop/src/main/transport/real-backend.ts`：
- import 行（:43）`import { RestMapper } from './protocol-v2/rest-mapper'` 改为 `import { RestMapper, compareBySortKey } from './protocol-v2/rest-mapper'`。
- 单流分支（:667-671）改为（进入领域前升序归一化，cursor 原样）：

```ts
    if (wireCats.length === 1) {
      // 单流（all/sticker/file/audio/link）：不透明游标直接透传；领域层统一 sortKey 升序（P1-01，与 image_video/loadMore 一致）
      const data = await this.fetchHistoryStream(input, wireCats[0], input.cursor)
      const items = data.items.map((i) => this.restMapper.toChatHistoryItem(i)).sort(compareBySortKey)
      return { items, hasMore: data.has_more, nextCursor: data.has_more ? data.cursor : undefined }
    }
```

- image_video 分支（:685-686）内联比较器替换为 `compareBySortKey`：

```ts
    const items = [...byHit.values()].sort(compareBySortKey)
```

- [ ] **Step 4: 跑测试确认全过**

Run: `cd apps/desktop && npx vitest run tests/unit/real-backend-search.spec.ts tests/unit/history-viewer.store.spec.ts tests/unit/rest-mapper.spec.ts`
Expected: 全部 PASS（rest-mapper.spec 的 `toChatHistoryPage` 排序行为不变，无回归）。

- [ ] **Step 5: typecheck + commit**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: 无新错误。

```bash
git add apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/real-backend-search.spec.ts apps/desktop/tests/unit/history-viewer.store.spec.ts
git commit -m "fix(阶段3 真实联调复验 P1-01): 历史搜索单流首屏统一 sortKey 升序——cursor 原样续接，与 image_video/loadMore 一致"
```

---

### Task 5: 全量门禁 + 文档同步 + 提交

**Files:**
- 文档：`docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md`（新建，记录 D1-D4 + 冻结口径）；`docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（阶段3 复验整改进度/测试数字同步）；`README.md`（测试数字 + 阶段3 状态）；`CLAUDE.md`（测试数字 + 状态同步）

**Interfaces:**
- Consumes: Task 1-4 的生产修复与测试。
- Produces: 全绿门禁证据；文档同步；最终提交。

- [ ] **Step 1: 跑全量门禁**

Run（repo root）：
```bash
pnpm -F @cyrene/desktop typecheck
pnpm -F @cyrene/desktop lint
pnpm -F @cyrene/desktop test
pnpm -F @cyrene/desktop test:integration
pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
```
Expected: 全部通过。若单测/集成测试数量有变化，记录新数字（Task 1 增 12 条 media-service、Task 2 增 ~6 条、Task 3 增 ~12 条、Task 4 增 ~3 条；以实际输出为准）。

- [ ] **Step 2: 决策记录文档**

新建 `docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md`（中文），记录：D1-D4 定案与理由（复制 spec §5）、冻结口径（P0-02 字段集/约束、P1-01 升序）、wire 边界修正（`duration_ms` nullable 扩到 REST + WS replay 两条 wire 边界，领域/IPC 仍严格）、`STICKER_ID_PATTERN`/src 兜底单一来源（`shared/domain/sticker-url`，content-part 门面 + media-service 经 import）、§7 后端 MIME 依赖与后续契约测试项（`audio/webm`/`audio/wav` 断言，BE-S3-RUN-P0-02 修复后补）、真实回归验收清单（§7 完成定义：附件/贴图/历史四条恢复路径）。

- [ ] **Step 3: 同步文档测试数字与状态**

- `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`：阶段3 复验整改行（4 P0/P1 修复落地、门禁全绿、新增真实 fixture），阶段3 状态保持「已开发、未联调」。
- `README.md` / `CLAUDE.md`：测试数字同步（以 Step 1 实际输出为准）；阶段3 复验整改已落地描述。

- [ ] **Step 4: 最终提交**

```bash
git add docs/review/2026-08-15-阶段3-真实联调复验整改-决策记录.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md
git commit -m "docs(阶段3 真实联调复验整改): 决策记录 + docs16/README/CLAUDE 测试数字与状态同步"
```
