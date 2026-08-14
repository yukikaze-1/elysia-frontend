# Cyrene 阶段3 真实联调复验整改设计：相对签名URL / ContentPart null / StickerPart 恢复 / 搜索排序

**日期：** 2026-08-15
**依据：**
- [docs/review/2026-08-15-阶段3真实联调前端复验问题清单.md](../../review/2026-08-15-阶段3真实联调前端复验问题清单.md)（FE-S3-RUN-P0-01 相对签名URL / FE-S3-RUN-P0-02 ContentPart null / FE-S3-RUN-P0-03 StickerPart 恢复 / FE-S3-RUN-P1-01 搜索排序）
- `/home/yomu/elysia-agent/docs/review/2026-08-15-阶段3真实联调后端复验问题清单.md`（BE-S3-RUN-P0-02 WebM/WAV MIME 规范化——后端主修，本 spec 只补真实契约测试）
- docs/01（Main 信任边界）、docs/02 §19（REST 契约对齐表）、docs/07（Renderer 信任边界与媒体代理）、docs/13（统一口径）
**审查对象基线：** `main@391c425`（阶段3 联调前整改落地后 HEAD；阶段3 新功能「已开发、未联调」）
**范围：** 阶段3 真实联调复验的 4 项前端整改——**P0-01** 相对签名 URL 基于当前 endpoint 解析为绝对；**P0-02** ContentPart 可空数字 null/非法归一化为字段缺省；**P0-03** 持久化 StickerPart 恢复 `Message.stickerId`（用户）+ `AssistantSegment` sticker 分段（assistant）；**P1-01** 历史搜索首屏与分页统一 `sortKey` 升序。后端 MIME 规范化（BE-S3-RUN-P0-02）不在本 spec 实施。
**目的：** 闭合真实 Windows Electron 复验暴露的前端缺陷，使阶段3 附件/贴图/历史链路在「切走再切回、来源跳转、Renderer reload、后端重启」四条恢复路径上稳定：相对签名 URL 不再因 Node fetch 不能解析而 502/`probe_failed`；单个可空元数据 `null` 不再使整页 IPC 校验失败；贴图不再因持久化恢复缺失而消失；搜索多页不再整体翻转。
**决策：** D1～D4 已按推荐定案（详见 §5）——D1 相对拼接 + 绝对 http(s) scheme 校验放行（不强同源）；D2 签名缓存 key 按 endpoint 身份（baseUrl 含 path 前缀）分区；D3 StickerPart 恢复覆盖用户+assistant 双路径（共享映射；无效 `st_` ID fail-open 忽略）；D4 §7 后端 MIME 修复前前端不加兼容层。另：P0-02 归一化字段集与约束、P1-01 升序语义均为复验清单已冻结口径，非决策。
**文档状态：** v1.4 定稿（独立 code-review 1 轮 2026-08-15：spec 与 plan 各 1 轮，修到 Ready to proceed=Yes；C1 `new URL` 畸形 base/URL 归一 `SignedUrlResolveError` + stream catch 落 streamAttachment 内部；I2 src 兜底剥 `.png`；I3 §6 补 message.store.spec.ts ACK 断言；M4 sticker 分段 `st-` 前缀；M5 锚点归真实回归；M6 baseUrl 尾斜杠防御。plan 评审后补三处闭合：wire 边界 `duration_ms` nullable 扩到 WS replay（raw-schemas.ts，三条恢复路径一致）；`STICKER_ID_PATTERN`/src 兜底单一来源 `shared/domain/sticker-url`（content-part 门面、media-service 经 import，免第三份拷贝）；`extractStickerId` 收敛 `role==='user'` 作用域。rest-schemas.spec + raw-schemas.spec 补用例）。

---

## 1. 背景与目标

阶段3 联调前整改（2026-08-15，`main@473cb48→391c425`）落地后，真实 Windows Electron 复验（SSH 转发 → Ubuntu backend `0.1.0+3e47e02` / protocol 2.0）发现前端 4 项缺陷，全部是 **Mock/单测掩盖、真实契约才暴露** 的问题：

| 编号 | 真实现象 | 根因 | 掩盖点 |
|---|---|---|---|
| P0-01 | 点击音频/视频卡 →「加载失败」；`attachmentsCheck` 返回 `probe_failed` | Node fetch 不能解析无 base 的相对签名 URL → 抛异常映射 502 | 单测 fixture 恒用绝对 `https://cdn.x/...` |
| P0-02 | 一张 `width:null,height:null` 的 PNG → 整页 `getMessages` IPC 失败 | Mapper `!== undefined` 把 `null` 当 number 透传 → IPC Schema 拒页 | TS shape 只声明 `number \| undefined`，未反映 JSON `null` |
| P0-03 | 贴图发送时可见；来源跳转/reload 后消失 | `mapContentToEntries` 显式忽略 `sticker`；`assemble()` 不恢复 `stickerId` | 乐观消息自带 `stickerId`，Mock 富化掩盖 |
| P1-01 | 搜索第二页后结果整体翻转 | 单流首屏直接透传后端 DESC；`loadMore` 合并按 sortKey 升序 | 后端 keyset DESC 分页是正确的，前端展示顺序不一致 |

**完成目标：** 4 项生产修复 + 定向回归（新增相对签名 URL / ContentPart null / StickerPart replay / 两页排序真实 fixture）；全部单测/集成/typecheck/lint/build/check:contract（WS+REST）继续全绿；真实 Windows Electron 复验中附件、贴图、历史搜索四条恢复路径稳定后，阶段3 新功能可由「已开发、未联调」升「已真实联调」。

## 2. 范围（做 vs 不做）

**本 spec 做（前端仓）：**

1. **P0-01 签名 URL 解析**：`media-service.ts` 新增纯函数 `resolveSignUrl(signUrl, baseUrl)`（相对 → 基于 endpoint baseUrl 解析为绝对、保留 path 前缀；绝对 http(s) 原样；其余 scheme 拒绝）；`resolveSignedUrl` 缓存 key 改为 `${baseUrl}:${attachmentId}`（endpoint 身份分区，D2）；baseUrl 缺失/URL 非法 → stream 返回可诊断 500、checkStatus 返回 `{status:'error', reason:'resolve_failed'}`（不伪装成 not_found/transient，复验清单 §3.3.3）。
2. **P0-02 ContentPart null 归一化**：`content-part.ts` 新增 `toOptionalNonNegativeNumber(v)`（`typeof v === 'number' && Number.isFinite(v) && v >= 0`，否则 undefined）；`ContentPartShape` 数字字段类型如实反映 wire（允许 `null`）；`toMedia` 全数字字段（size_bytes/width/height/duration_ms）经 helper 归一化；`rest-mapper.ts` tool 块的 `duration_ms` 同口径；**wire 边界** `RestMessageSchema.duration_ms` 改 `z.number().nullable().optional()`（`.strict()` 下接受 null，否则整页在 wire 层失败）、`rest-types.ts` 类型同步。IPC Schema 保持严格（不 `.nullable()`），必填字段仍 fail-closed。
3. **P0-03 StickerPart 恢复（D3 双路径）**：`content-part.ts` 定义并 export `STICKER_ID_PATTERN`（`media-service.ts` 改为 import，单一来源）；新增 `extractStickerId(content)`（`sticker_id` 优先、`src` 尾段兜底、校验 `st_`、first-wins）；`mapContentToEntries` 增加 `sticker` 条目（assistant 逐 part 一个分段，无效 ID fail-open 忽略）；`rest-mapper.ts` `assemble()` 用户分支恢复 `Message.stickerId` + typed parts 文本提取（`extractText` 复用 `mapContentToEntries` 提取 `type:'text'` 条目），assistant 分支产出 `kind:'sticker'` 分段；贴图**不进入** `attachments`（`mapContentMedia` 已跳过 sticker 条目，保持）。
4. **P1-01 搜索排序统一升序**：`rest-mapper.ts` export `compareBySortKey`；`real-backend.ts` 单流分支升序归一化（与 image_video 分支、Mapper、store `loadMore` 一致）；cursor 原样续接后端返回值（复验清单 §6.3.3/§6.3.4 冻结）。

**本 spec 不做（边界）：**

- **后端 MIME 规范化**（BE-S3-RUN-P0-02：WebM audio → `audio/webm`、WAV → `audio/wav`）：主修在后端仓；前端不加 audio 别名兼容层、不扩白名单掩盖真值（D4）；保留既有 `wireKindHint`（上传侧消歧，非展示掩盖）；后端修复后补真实契约测试（`audio/webm`/`audio/wav` 断言）——该测试列为「后端修复后补」，本批若后端已修复则并入，否则记录为后续契约增强项。
- **SearchMessageItem 富化**（search item 增 kind/url/stickerId）：P0-1 已知限制，查看器贴图分类仍为文本行 + 来源跳转，不伪造实现。
- **IPC/领域 Schema 放宽**：null 归一化在映射层，wire/领域 Schema 保持严格（`z.number().nonnegative().optional()` 不变）。
- **Renderer UI 改动**：`CyMessageBubble` 已有两条贴图渲染路径（`message.stickerId` :61 / `seg.kind==='sticker'` :96），本批只让恢复路径产出正确字段，不改组件。
- **对绝对签名 URL 强制同源**：D1 决策为 scheme 校验放行（不强同源），以兼容对象存储/独立 CDN 绝对地址。
- **历史查看器分页算法重构**：keyset cursor、hitId 去重、滚动锚点语义均不变，只改首屏顺序归一化。

## 3. 现状与根因（代码证据）

**3.1 P0-01 相对签名 URL**：[media-service.ts](../../../apps/desktop/src/main/attachments/media-service.ts) 构造时已注入 `baseUrl`（:43 `baseUrl: () => string | undefined`），装配点为 [index.ts:203](../../../apps/desktop/src/main/index.ts#L203) `baseUrl: () => connConfig.getEndpoint()?.baseUrl`，而 [connection-config.ts:58](../../../apps/desktop/src/main/connection/connection-config.ts#L58) 定义 `baseUrl = origin + pathname`（**含反代 path 前缀**）。但 attachment 分支**未用** baseUrl：

- `resolveSignedUrl()`（:51-59）直接缓存 `sign.url`（真实契约相对路径 `/api/attachments/{id}?sig=...`）；
- `proxyFetch()`（:68-84）直接 `fetchImpl(signedUrl)`——Node fetch 不能解析相对 URL → 抛异常被 :80 catch → 502；
- `checkStatus()`（:145-163）同样直接 `fetchImpl(signed.url)` → `probe_failed`；
- 仅 `streamSticker`（:126-143）正确用 `baseUrl()` 拼静态代理。

掩盖点：[media-service.spec.ts:15](../../../apps/desktop/tests/unit/media-service.spec.ts#L15) 默认 sign fixture 返回绝对 `https://cdn.x/${id}?sig=s`，:41/:50/:57/:66 各用例同样绝对——相对路径场景从未被测试。

**3.2 P0-02 ContentPart null**：[content-part.ts:20-29](../../../apps/desktop/src/main/transport/protocol-v2/content-part.ts#L20-L29) `ContentPartShape` 数字字段只声明 `number | undefined`，未反映 REST JSON 的 `null`；`toMedia()`（:42-53）用 `!== undefined` 判断，`null` 被当存在透传；`mapContentMedia()`（:75-94）同样。下游 [ipc-response.ts:44-54](../../../apps/desktop/src/shared/schemas/ipc-response.ts#L44-L54) `MessageAttachmentSchema` 的 `size/width/height/durationMs` 是 `z.number().nonnegative().optional()`——`null` 触发 `expected number, received null`，整页 `getMessages` 被拒。AssistantSegmentSchema（:56-69）`size/width/height` 同理（`z.number().optional()`）。REST/replay 的 content 是 `z.unknown()`（[rest-schemas.ts:21](../../../apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts#L21)），`null` 能通过 wire schema 到达映射层，故归一化必须在映射层。

**3.3 P0-03 StickerPart 被忽略**：领域契约双 stickerId 已冻结——`Message.stickerId`（用户贴图消息，[message.ts:92](../../../apps/desktop/src/shared/contracts/message.ts#L92)）与 `AssistantSegment.stickerId`（分段级，[message.ts:55](../../../apps/desktop/src/shared/contracts/message.ts#L55)，`SegmentKind` 含 `sticker`）；渲染器两条路径（[CyMessageBubble.vue:61](../../../apps/desktop/src/renderer/src/components/CyMessageBubble.vue#L61) 与 :96）都已存在。但：

- [content-part.ts:70-71](../../../apps/desktop/src/main/transport/protocol-v2/content-part.ts#L70-L71) `mapContentToEntries` 明确忽略 `sticker`（注释「G4 贴图消费，本批不产媒体条目」），[content-part.spec.ts:37-39](../../../apps/desktop/tests/unit/content-part.spec.ts#L37-L39) 还断言 `toEqual([])`；
- [rest-mapper.ts:80-137](../../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts#L80-L137) `assemble()` 只恢复文字与普通附件：用户分支 `base.content = extractText(src.content, src.parts)` 不设 stickerId；assistant 分支分段循环无 sticker 分支；
- `extractText`（:142-153）只处理 string content 与 `{content:string}[]` parts——typed parts（`{type:'text',text}` / `{type:'sticker'}`）都不认，故「文字+贴图」用户消息连文本一起丢（复验清单 §5.3.4 缺口）；
- 乐观发送路径 [message.store.ts:221-231](../../../apps/desktop/src/renderer/src/stores/message.store.ts#L221-L231) 正确写 `stickerId`（扁平字段），REST/replay 恢复后字段缺失 → 来源跳转/切会话/reload 后贴图消失。

**3.4 P1-01 搜索排序**：[real-backend.ts:665-693](../../../apps/desktop/src/main/transport/real-backend.ts#L665-L693) `queryChatHistory()` 单流分支（:667-671）`data.items.map(toChatHistoryItem)` 后直接透传后端顺序（keyset 契约 `timestamp DESC`）；image_video 分支（:685-686）已按 `sortKey` 升序。store 侧 [historyViewer.store.ts:87](../../../apps/desktop/src/renderer/src/stores/historyViewer.store.ts#L87) `submitQuery` 直接赋值首屏、:112 `loadMore` 合并按 `sortKey` 升序——首屏 DESC 与后续升序矛盾，加载第二页后整体翻转。`RestMapper.toChatHistoryPage()`（[rest-mapper.ts:63-67](../../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts#L63-L67)）已升序（未被单流分支使用）。

## 4. 整改项设计

### 4.1 FE-S3-RUN-P0-01：相对签名 URL 基于 endpoint 解析（D1/D2）

**改动点：**

1. [media-service.ts](../../../apps/desktop/src/main/attachments/media-service.ts) 新增并 export 可区分的解析函数与错误标记：

   ```ts
   /** 签名 URL 解析失败（baseUrl 缺失/畸形/URL 非法）——与签发 fetch 失败区分（见 §4.1 错误分类） */
   export class SignedUrlResolveError extends Error {}
   /** 解析签名 URL：相对路径基于 backend baseUrl 解析为绝对（保留 path 前缀，反代/SSH 转发场景）；
    *  绝对 URL 仅 http(s) 原样放行（D1：兼容对象存储 CDN，不强同源）；其余 scheme/畸形/baseUrl 缺失 → 抛 SignedUrlResolveError。 */
   export function resolveSignUrl(signUrl: string, baseUrl: string | undefined): string {
     if (!baseUrl) throw new SignedUrlResolveError('backend base URL is not configured')
     if (/^https?:\/\//i.test(signUrl)) return signUrl                       // 绝对 http(s)：原样
     if (/^\/(?!\/)/.test(signUrl)) {
       try {
         return new URL(baseUrl.replace(/\/+$/, '') + signUrl).toString()   // /api/...：base + path（保留反代前缀）
       } catch {
         throw new SignedUrlResolveError(`invalid signed URL: ${baseUrl}${signUrl}`)  // 畸形 base/URL（TypeError 归一为可区分错误）
       }
     }
     throw new SignedUrlResolveError(`unsupported signed URL: ${signUrl}`)    // javascript:/file:/data://// 等
   }
   ```

   注意：`new URL('/api/x', 'https://host/proxy')` 会丢弃 `/proxy`（origin 相对解析），故必须字符串拼接 baseUrl + signUrl 再 `new URL` 验证——这是 `connection-config.ts` baseUrl 含 pathname 语义的必然要求（复验清单 §3.3.6「由前端当前 endpoint 决定 origin」）。协议相对 `//` 被 `/^\/(?!\/)/` 排除（fail-closed）；畸形 base/URL 的 `new URL` 抛 `TypeError` 必须 try/catch 归一为 `SignedUrlResolveError`，否则会被 call 方误判为 sign_failed/502。

2. `resolveSignedUrl()`（:51-59）改为：先 `const base = this.baseUrl()`，`!base` 立即抛 `SignedUrlResolveError`（**不先调签发表**，免无谓后端请求）；缓存 key 用 `${base.replace(/\/+$/, '')}:${attachmentId}`（D2 endpoint 身份分区，key 归一化防尾斜杠双键；origin 变化必然 baseUrl 变化，天然隔离旧签名）；sign 成功后 `const url = resolveSignUrl(sign.url, base)`（抛 `SignedUrlResolveError` → 上层区分处理）。

3. **错误分类**：`streamAttachment()` 与 `checkStatus()` 对 `resolveSignedUrl` 抛错按来源区分——`SignedUrlResolveError`（本地配置/数据问题：baseUrl 缺失/畸形、签名 URL 非法 scheme）→ stream 返回 `500`、checkStatus 返回 `{ status: 'error', reason: 'resolve_failed' }`（`AttachmentCheckResult.reason` 为自由字符串，无需类型改动）；其他错误（签发表 `restFetch` 网络/后端失败）→ 保持现有 transient 语义：stream 返回 `502`、checkStatus 返回 `{ status: 'error', reason: 'sign_failed' }`。**stream 的 catch 必须落在 `streamAttachment()` 内部**（当前 :93 `resolveSignedUrl` 无 try/catch，抛错会冒泡到 `registerCyreneProtocolHandler` 的 blanket catch 恒 502，无法区分）。语义与 P2-4（502=transient、非 404 not_found）和复验清单 §3.3.3（baseUrl 缺失/URL 非法不伪装成附件不存在）一致。

4. `proxyFetch` 不变（现在拿到的是绝对 URL）。

**约束（复验清单 §3.3）：** 相对 `sign.url` 的解析与 `streamAttachment`/`checkStatus` 完全同源（同一 `resolveSignedUrl`）；签名 URL 不落 Renderer、日志脱敏、`Sec-Fetch-Dest` 防护、1MB sticker 上限、`att_`/`st_` 白名单均保持；endpoint 切换后旧 baseUrl 下的签名缓存天然不可达（新 key 前缀）。

**测试（复验清单 §3.4，media-service.spec.ts）：** 相对 sign.url + base `http://127.0.0.1:18765` → fetch 实际 URL 正确拼接；baseUrl 含 path 前缀（`http://h/p`）→ 保留 `/p`；baseUrl 尾斜杠 → 不双斜杠；绝对 http(s) 原样；`javascript:`/`file:`/`data:`/`//` 拒绝；baseUrl 缺失 → **不调签发表**、stream 500、checkStatus resolve_failed；签发表 fetch 失败（非解析问题）→ stream 502、checkStatus sign_failed（与解析失败区分）；endpoint 变化（baseUrl 变化）→ 不复用旧缓存、重签；相对 URL 下 Range/206、401/403 强制重签、checkStatus 分类全部通过。

### 4.2 FE-S3-RUN-P0-02：ContentPart 可空数字归一化（冻结口径）

**改动点：**

1. [content-part.ts](../../../apps/desktop/src/main/transport/protocol-v2/content-part.ts) 新增纯函数：

   ```ts
   /** wire 可空数字 → 领域数字：仅 typeof number 且有限且 >=0 保留；null/负/NaN/Infinity → undefined（缺省，不污染 IPC） */
   export function toOptionalNonNegativeNumber(v: unknown): number | undefined {
     return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
   }
   ```

2. `ContentPartShape`（:20-29）数字字段类型由 `number | undefined` 改为 `unknown`（诚实反映 wire：JSON `null` 可通过 `z.unknown()` 到达映射层）；`MappedMedia`（:8-18）保持 `number | undefined`（归一化后的领域形状）。

3. `toMedia()`（:42-53）四个数字字段（size_bytes/width/height/duration_ms）改用 `toOptionalNonNegativeNumber`（helper 返回 undefined 即省略，`:83-88` 的 `!== undefined` spread 模式不变）：

   ```ts
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
   ```

4. [rest-mapper.ts:131](../../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts#L131) tool 块 `src.duration_ms !== undefined ? { durationMs: src.duration_ms } : {}` 改用 `toOptionalNonNegativeNumber(src.duration_ms)`。**此改动要可达，wire 层必须先放行 null**——[rest-schemas.ts:36](../../../apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts#L36) `RestMessageSchema.duration_ms` 当前 `z.number().optional()`（`.strict()`）会先拒掉 `null` 使整页失败（与 P0-02 同类的 wire 边界故障），故改为 `z.number().nullable().optional()`（wire 边界接受 null，映射层归一化，领域/IPC 仍严格）；[rest-types.ts:30](../../../apps/desktop/src/main/transport/protocol-v2/rest-types.ts#L30) `RestMessage.duration_ms?: number` 同步为 `number | null | undefined`（诚实反映 wire）。**WS replay wire 边界同款放行**——[raw-schemas.ts:42](../../../apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts#L42) `duration_ms: z.number().optional()` 改 `z.number().nullable().optional()`（复验清单 §4.4「REST 首屏、getMessageContext、WS replay 三条恢复路径使用相同归一化语义」，否则 replay tool `duration_ms:null` 整段拒）。领域 `MessageToolInfo.durationMs`（[message.ts:102](../../../apps/desktop/src/shared/contracts/message.ts#L102)）保持 `number | undefined`（归一化后）。

5. IPC Schema（[ipc-response.ts:44-69](../../../apps/desktop/src/shared/schemas/ipc-response.ts#L44-L69)）**不改**；必填 `attachmentId/kind/mediaType` 仍 fail-closed。

**约束（复验清单 §4.3）：** null/非法 → 字段缺省，**不丢媒体、不丢消息页**；`0` 为合法值保留（schema 非负含 0）；负/NaN/Infinity（单测注入）一律缺省；REST 首屏、`getMessageContext`、WS replay 三条恢复路径共用同一 helper（均经 `assemble`/`mapContentToEntries`）。

**测试（复验清单 §4.4，content-part.spec.ts + rest-mapper.spec.ts + rest-schemas.spec.ts）：** image `width:null,height:null` → 领域不含两字段且媒体保留；`undefined`/合法数字/`0`/负数/NaN/Infinity 分别按约束处理；video/audio 可空 `duration_ms` 与 file 可空 `size` 不污染 IPC；一页含文本+null-width PNG+其他附件 → IPC 整页成功；tool 消息 `duration_ms:null` → wire schema 接受（`.strict()` 下 `null` 通过）、映射层领域无 durationMs；replay 路径同语义。

### 4.3 FE-S3-RUN-P0-03：StickerPart 恢复（D3 双路径）

**改动点：**

1. [content-part.ts](../../../apps/desktop/src/main/transport/protocol-v2/content-part.ts)：
   - `STICKER_ID_PATTERN` 从 `@shared/domain` 导入并 re-export（**单一来源在 shared/domain**，[sticker-url.ts:4](../../../apps/desktop/src/shared/domain/sticker-url.ts#L4) 既有；content-part 作 main 层门面，[media-service.ts:11](../../../apps/desktop/src/main/attachments/media-service.ts#L11) 的本地同值 pattern 改为经 content-part import——避免第三份拷贝与漂移）。
   - src 兜底**委托** [sticker-url.ts:9](../../../apps/desktop/src/shared/domain/sticker-url.ts#L9) `stickerIdFromResourceUrl`（既有、已测：`new URL(url, 占位 origin).pathname` 末段剥 `.png` 再校验 `st_`，处理 `..` 归一化；真实 sticker src `/static/stickers/{id}.png` 命中，直接 `split('/').pop()` 得 `st_1.png` 会因 `.` 不符而永不命中）；**不新增 `parseStickerIdFromSrc`**（避免第三份解析拷贝）。后端实际总带 `sticker_id`（复验清单 §5.1），src 兜底为纵深防御。
   - 新增并 export 两个函数（单 part 核心 + 整数组扫描）：

     ```ts
     /** 单个 sticker ContentPart → 合法 stickerId（sticker_id 优先，src 经 stickerIdFromResourceUrl 兜底；无效/缺 → undefined） */
     export function stickerIdOf(part: unknown): string | undefined
     /** content（整数组）→ 首个合法 stickerId（first-wins，D3）；单 part 亦可；无效/缺 → undefined */
     export function extractStickerId(content: unknown): string | undefined
     ```

   - `mapContentToEntries`（:57-71）增加 sticker 分支：`part.type === 'sticker'` → `stickerIdOf(part)` 合法则 push `{ type: 'sticker', stickerId }`，无效忽略（fail-open）；返回类型扩为 `Array<{type:'text';text}|{type:'media';media}|{type:'sticker';stickerId}>`。
   - `mapContentMedia`（:75-94）不变——已 `if (entry.type !== 'media') continue`，sticker 条目天然不进入 `attachments`（复验清单 §5.3.4）。

2. [rest-mapper.ts](../../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts) `assemble()`：
   - **用户分支**（:90-91，`role === 'user'` 独立作用域，tool 消息不设 stickerId）追加（一次调用，first-wins）：`const stickerId = extractStickerId(src.content); if (stickerId) base.stickerId = stickerId`；
   - `extractText`（:142-153）扩展：content 为数组时先经 `mapContentToEntries` 提取 `type:'text'` 条目连接（typed parts「文字+贴图」文本保留），无文本再走 parts 兜底——与 assistant 文本提取同源；
   - assistant 分段循环（:100-119）拆分 `else` 分支：`entry.type === 'media'` 推媒体分段（现有逻辑），`entry.type === 'sticker'` 推 `{ segmentId: `st-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel:'public_reply', kind:'sticker', stickerId, completed:true }`（segmentId 用独立前缀 `st-`，与媒体 `media-`/文本 `pr-` 不撞段；逐 part 一个分段，天然支持多贴图）。

**约束（复验清单 §5.3）：** 显示语义以冻结的 `Message.stickerId` 为准；REST 与 WS replay 共用同一映射（均经 `assemble`）；校验 `st_` ID，Renderer 继续只走 `cyrene://renderer/__cyrene-media/sticker/{id}` 受控代理，不直接信任任意 `src`；「文字+贴图」与纯贴图都保留；贴图不塞入 `attachments`；乐观对象 ACK ID 迁移后与 REST/replay 恢复对象字段一致（`{content?, stickerId?}` 同构，不闪消失）。

**测试（复验清单 §5.4，rest-mapper.spec.ts + content-part.spec.ts）：** `toDomainMessage` 映射纯贴图/文字+贴图（user）；`toDomainMessageFromReplay` 同一 StickerPart → 相同 stickerId；来源 context 加载 / 会话首屏 / bootstrap replay 恢复（已含于既有恢复路径，断言 stickerId）；assistant 贴图 → `seg.kind==='sticker'` + stickerId；非法 sticker ID / 任意外部 src → 不设 stickerId（不进入代理）；用户文字+贴图 → content 与 stickerId 并存；`mapContentMedia` 对 sticker 条目不产附件；content-part.spec.ts:37-39 旧断言（sticker 产空）更新为新语义。

### 4.4 FE-S3-RUN-P1-01：历史搜索统一 `sortKey` 升序（冻结口径）

**改动点：**

1. [rest-mapper.ts](../../../apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts) export：

   ```ts
   /** 历史项稳定升序比较：(timestamp, hitId/messageId) 稳定次键（与 image_video 分支、store loadMore 同款） */
   export function compareBySortKey(a: ChatHistoryItem, b: ChatHistoryItem): number {
     return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
   }
   ```

2. [real-backend.ts:667-671](../../../apps/desktop/src/main/transport/real-backend.ts#L667-L671) 单流分支：`data.items.map(...)` 后 `.sort(compareBySortKey)`（进入领域前归一化，与 image_video 分支 :685-686 一致）；`nextCursor` 原样（`data.has_more ? data.cursor : undefined`，cursor 不参与排序）；image_video 分支 :685-686 内联比较器替换为 `compareBySortKey`（行为等价，消除重复）。
3. [historyViewer.store.ts](../../../apps/desktop/src/renderer/src/stores/historyViewer.store.ts) `submitQuery`（:87）保持直接赋值（transport 已升序）；`loadMore`（:112）合并排序保持（renderer/main 边界，不复用 main 模块函数）。

**约束（复验清单 §6.3）：** 领域层统一 `sortKey` 升序；同时间戳用 `hitId`（`timestamp|messageId` 已编码）作稳定次键；cursor 原样使用后端返回值；排序只作用于展示副本；合并继续按 `hitId` 去重、滚动锚点保持。

**测试（复验清单 §6.4，real-backend-search.spec.ts + history-viewer.store.spec.ts）：** 单流后端返回 `[new, old]` → 首屏 `[old, new]`；第二页更旧数据合并后全局升序、无重复、cursor 原样续接；同时间戳稳定次排序；`all/sticker/file/audio/link/image_video` 分类排序一致；多页无翻转（500 条规模在 real-backend-search.spec 用循环页 fixture 覆盖合并升序，不依赖真实 500 条）。**滚动锚点是组件/E2E 行为，store 单测不覆盖**——锚点保持归入 §7 真实 Windows Electron 回归验收（两页 50+50）。

## 5. 决策记录

| # | 事项 | 定案 | 理由 |
|---|---|---|---|
| D1 | P0-01 绝对签名 URL 策略 | 相对拼接 + 绝对 http(s) scheme 校验放行，**不强同源** | 复验清单 §3.4 要求明确兼容/拒绝策略；对象存储/独立 CDN 可能返回绝对地址，强制同源会误伤；Main 受信边界 fetch 签名 URL（Renderer 只供 attachmentId），scheme 白名单即足够防线 |
| D2 | P0-01 签名缓存失效 | 缓存 key 按 endpoint 身份分区（`${baseUrl}:${attachmentId}`，baseUrl 含反代 path 前缀） | 「origin 分区」落到 baseUrl 粒度：origin 变化必然 baseUrl 变化，且同 origin 不同 path（`/a` 与 `/b` 两部署）也不串签；无需主动清空 |
| D3 | P0-03 贴图恢复范围 | 用户 + assistant 双路径（共享映射）；`STICKER_ID_PATTERN`/src 兜底单一来源 `shared/domain/sticker-url`（content-part 作 main 层门面）；无效 `st_` ID fail-open 忽略 | 领域契约与渲染器两条渲染路径均已冻结；`mapContentToEntries` 是共享入口，双路径近乎零额外成本；贴图为显示增强，无效 ID 不应拒整页；sticker-url.ts 既有已测解析（剥 `.png`+校验），复用避免第三份拷贝与漂移 |
| D4 | §7 后端 MIME | 前端不加兼容层、不扩白名单，等后端 BE-S3-RUN-P0-02；后端修复后补真实契约测试 | 掩盖真值会迟滞后端修复；现有 `wireKindHint`（上传侧消歧）保留，非展示掩盖 |
| — | P0-02 归一化字段集与约束 | 全可空数字（size_bytes/width/height/duration_ms + tool.duration_ms）；`typeof number && finite && >=0`，非法 → 缺省 | 复验清单 §4.3.2 冻结口径，非决策 |
| — | P1-01 排序语义 | 领域层统一 `sortKey` 升序；cursor 原样 | 复验清单 §6.3 冻结口径，非决策 |

## 6. 测试计划

全部 node env 单测（vitest），跑法 `cd apps/desktop && npx vitest run tests/unit/<file>`。

| 文件 | 动作 | 内容 |
|---|---|---|
| `tests/unit/media-service.spec.ts` | 改 | sign fixture 增相对 URL；新增 resolveSignUrl 纯函数 describe（相对拼接/反代 path/尾斜杠/绝对放行/异 scheme 拒/baseUrl 缺失）；缓存 endpoint 隔离；相对 URL 下 Range/206、401/403 重签、checkStatus 全链路 |
| `tests/unit/rest-schemas.spec.ts` | 改 | `RestMessageSchema` 顶层 `duration_ms:null` → `.safeParse` 成功（wire 边界接受 null，P0-02）；`parseRestMessagesPage` 一页含 null duration_ms → success |
| `tests/unit/raw-schemas.spec.ts` | 改 | WS replay wire 边界同款：raw 帧 tool `duration_ms:null` → schema 接受（三条恢复路径一致，P0-02） |
| `tests/unit/content-part.spec.ts` | 改 | :37-39 sticker 边界断言更新（sticker → `{type:'sticker',stickerId}` 条目 + `mapContentMedia` 不产附件）；新增 `stickerIdOf`/`extractStickerId`（sticker_id 优先/src 经 `stickerIdFromResourceUrl` 兜底含真实 `/static/stickers/st_1.png` 形态/非法拒/first-wins/整数组扫描）；toMedia null/0/负/NaN/Infinity 归一化用例 |
| `tests/unit/rest-mapper.spec.ts` | 改 | 用户纯贴图/文字+贴图 → `Message.stickerId`+content；assistant 贴图 → sticker 分段；replay 同 StickerPart 同 stickerId；tool `duration_ms:null` → 无 durationMs；`width:null,height:null` 页混合返回成功 |
| `tests/unit/message.store.spec.ts` | 改 | 复验清单 §5.4「乐观消息 ACK ID 迁移后再收到 REST/replay，不重复、不丢贴图」：乐观写 stickerId → `migrateKey` 后 stickerId 保留；收到恢复对象（带 stickerId）合并不重复、不丢（现 :603-611 只测乐观写） |
| `tests/unit/real-backend-search.spec.ts` | 改 | 单流 `[new,old]` → 领域 `[old,new]`；第二页合并升序无重复 cursor 原样；各分类排序一致；image_video 仍一致 |
| `tests/unit/history-viewer.store.spec.ts` | 改 | submitQuery 首屏顺序断言（transport 升序后）；loadMore 合并升序无翻转 |

**全量门禁：** `typecheck` / `lint` / `test` / `test:integration` / `build` / `check:contract`（WS 13/13 + REST 8/8）全绿。

## 7. 完成定义

- P0-01/02/03、P1-01 均有生产修复与 §6 定向回归；测试数量同步（README/CLAUDE.md/docs16）；
- 单测、Electron 集成、typecheck、lint、build、check:contract（WS+REST）全绿；
- 新增真实相对签名 URL、ContentPart null、StickerPart replay、两页排序 fixture（复验清单 §9）；
- 后端 MIME 修复（BE-S3-RUN-P0-02）后补 `audio/webm`/`audio/wav` 真实契约测试，并记录到 docs/02 §19 与决策记录；
- 用修复后前端 SHA 做真实 Windows Electron 回归：附件（WAV/WebM/MP4/PNG 卡片代理）、贴图（首次发送→来源跳转→切会话→Renderer reload→后端重启恢复）、历史（两页 50+50 顺序稳定、来源跳转定位）全过后，阶段3 相应链路才可标「已真实联调」；本批交付前阶段3 仍保持「已开发、未联调」。
