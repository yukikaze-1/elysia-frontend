# Cyrene 阶段3 真实联调前整改设计：日期自然日 / WebM hint / REST-multipart 跨仓门禁 / 贴图真实契约

**日期：** 2026-08-15
**依据：**
- [docs/review/2026-08-15-阶段3真实联调前端整改清单.md](../../review/2026-08-15-阶段3真实联调前端整改清单.md)（FE-S3-INT-P0-01 日期自然日 / FE-S3-INT-DEP-01 贴图保留 sticker / FE-S3-INT-DEP-02 混合附件逐文件 kind）
- `/home/yomu/elysia-agent/docs/review/2026-08-15-阶段3真实联调后端整改清单.md`（BE-S3-INT-P0-01 贴图搜索白名单 / BE-S3-INT-P0-02 逐文件 multipart / BE-S3-INT-P1-01 日期 fail-fast——前端对接口径，实施在后端仓）
- docs/02 §19（REST 搜索/资源/上传契约对齐表）、docs/07（Renderer 信任边界与媒体加载）、docs/12（阶段 3 门禁）、docs/13（统一口径）
**审查对象基线：** `main@473cb48`（CI 修复后 HEAD；阶段 3 全部新功能「已开发、未联调」）
**范围：** 阶段3 真实联调前的前端整改 5 项——**P0-01** 搜索日期参数按后端自然日契约发送；**D1** 混合附件 webm kind hint 消歧（FE-S3-INT-DEP-02 配套）；**D2** REST/multipart 跨仓门禁（check:contract REST 段 + 纯前端定向 vitest 双轨）；**D3** 贴图历史/发送真实契约测试（FE-S3-INT-DEP-01 配套 + B-02 验收口径）；**D4** 删除 `localDateToHalfOpenRange` 死代码。后端侧三项整改不在本 spec 实施。
**目的：** 闭合阶段3 真实 REST/multipart 契约错位，使 B-02（历史/搜索/来源跳转）与 B-03（附件/多媒体）真实联调可准入、可验证：搜索日期不再预转 UTC ISO（200 空页误判根因）；webm audio/video hint 不串位（后端 WebM 消歧依赖 hint/part MIME）；REST 字段漂移纳入跨仓门禁早发现；贴图历史/发送走真实契约测试与 B-02 通过口径。
**决策：** D1～D4 已按推荐定案（详见 §5）——D1 webm hint=MIME 特例回退（大小限额仍魔数）；D2 REST 门禁=check:contract 扩 REST 段 + 纯前端 vitest 双轨；D3 贴图发送纳入 B-02 顺带验证；D4 删除 `localDateToHalfOpenRange`。另含验收口径：B-02 以「纯文本行展示 + 来源跳转正常」为通过标准。
**文档状态：** v1 定稿（自审 1 轮：占位符/链接深度/删除范围行号/测试归属定死；**独立 code-review 1 轮（2026-08-15，评审→修复→重验全过）**：C1 存储行为断言反向修正（`hasSearched` 失败保持 false，防伪空态）、I1 `audio/webm` 白名单破坏等值断言 + 渲染层预检差异记录为已知行为、I2 必填判定防空转（`Field(...)` 参数 token 作用域）、I3 chip 措辞（真实 search item 无 resource，chip 恒「消息」、空 snippet「（无文本命中）」）、I4 防静默通过（模型数<8 或字段数=0 → exit 1）、M1/M5/R1 IPC 双方向 schema（请求方向 `chatQueryHistorySchema`、响应方向 `ChatHistoryPageSchema` 分开）、M2 webm 消歧断言归属、M3 取消错误码对齐、M4 测试名同步、M6 类型级比对列为后续；重验结论：Ready to proceed=Yes，残留 R1-R3 Minor 已修复）

---

## 1. 背景与目标

B-01 已真实联调封口（2026-08-14），阶段2 主链「已真实联调」，阶段3 转为主线。阶段3 四组（G1 布局 / G2 历史草稿 / G3 附件媒体 / G4 历史查看器+表情+无障碍）已落地并通过 Mock/自动化验证（894 单测 / 39 集成 / typecheck / lint / build / WS check:contract 全绿），全部标「已开发、未联调」。

真实 REST 联调前，双仓（前端 `main@473cb48` / 后端 `main@4ecaac6f`）2026-08-15 整改清单确认三处确定性契约错位，前端侧错位与修正方向：

| 错位 | 根因 | 权威口径 | 本 spec 前端动作 |
|---|---|---|---|
| 日期筛选 200 空页 | `fetchHistoryStream` 把本地自然日预转 UTC ISO（`date_from=2026-08-13T16:00:00.000Z`），后端 `date.fromisoformat()` 无法解析 → 吞成空 | **后端**：`YYYY-MM-DD` 自然日 + IANA timezone | P0-01：改发自然日；删死代码 D4 |
| 贴图历史 400 | 后端搜索 category 白名单缺 `sticker`（现 `"text,image,video,audio,file,link,tool"`） | **前端**：保留 `category=sticker`，后端补白名单 | D3：真实契约测试 + B-02 口径，不做客户端降级 |
| 混合附件误分类 | 后端只存标量 `kind`（后值覆盖前值），webm 魔数无法区分 audio/video | **前端**：逐文件 `kind+files` 有序 multipart | D1：webm hint MIME 特例回退 |

**完成目标：** 前端侧四项整改落地并全量验证；B-02/B-03 进入条件达成；阶段3 新功能在真实复验通过后可从「已开发、未联调」升级为「已真实联调」。

## 2. 范围（做 vs 不做）

**本 spec 做（前端仓）：**

1. **P0-01 日期自然日**：`RealBackend.fetchHistoryStream()` 改为发送 `date_from=localDate`、`date_to=localDate`（YYYY-MM-DD），不再预转 UTC ISO；timezone 照传 IANA；无日期筛选省略两个日期参数（现状已如此，保持）。
2. **D4**：删除 `localDateToHalfOpenRange` 及其私有助手（shared/domain/history-date.ts）与对应单测；`isoToLocalDate` 保留（mock 自然日过滤仍用）。
3. **D1 WebM hint**：新增纯函数 `wireKindHint(kind, mediaType)`（attachment-policy.ts）；`upload-service.uploadBatch` 两分支（path/bytes）用它生成 `UploadContent.kind`（wire hint），**大小限额仍用 `sniffKind` 魔数**；`audio/webm` 加入 `ATTACHMENT_KIND_MIME.audio` 白名单（渲染层预检/标签对齐）。
4. **D2 REST 门禁**：`check:contract` 扩展 REST 段（读 `frontend_contract/rest.py` 目标模型，与前端 zod schema 比对）；新增纯前端定向 vitest（URL 自然日参数、FormData part 顺序、混合批次、错误映射）。
5. **D3 贴图真实契约**：fixture 驱动的「后端 category=sticker 真实形状响应 → Schema → Mapper → IPC → History Store 可展示 + 跳转」测试（新文件 `sticker-contract.spec.ts`）；错误语义补 `INVALID_TIMEZONE` 映射（400 → INVALID_INPUT）。
6. **验收口径**：B-02 通过口径写入「纯文本行 + 跳转正常」（P2-3 无缩略图已知限制）。

**本 spec 不做（边界）：**

- **后端侧三项整改**（贴图搜索白名单 BE-S3-INT-P0-01、逐文件 multipart BE-S3-INT-P0-02、日期 fail-fast BE-S3-INT-P1-01）：属后端仓，前端只按对接口径补测试与验收。
- **媒体代理/签名策略**（`cyrene://renderer/__cyrene-media` 签名缓存/重签/401/403 重试、Range/206、1MB 上限）：已实现并有测试，不因本批改动。
- **贴图缩略图富化**（SearchMessageItem 增 kind/url/stickerId）：P2-3 已知限制，标注后续契约增强项，不伪造实现。
- **image_video 双子流游标合并重构**：现实现（独立游标 + 顺序合并）已验收，本批仅保证 B-02 通过口径记录该语义，不改算法。
- **Renderer 布局/草稿/附件队列 UI**：本批不涉及 UI 变更（webm 白名单影响渲染层 kind 标签，属顺带修正，无视觉重构）。

## 3. 现状与根因（代码证据）

**3.1 P0-01 日期错位**：[real-backend.ts:700-704](../../../apps/desktop/src/main/transport/real-backend.ts#L700-L704)：

```ts
if (input.localDate) {
  const range = localDateToHalfOpenRange(input.localDate, input.timeZone)
  params['date_from'] = range.from   // 2026-08-13T16:00:00.000Z（预转 UTC ISO）
  params['date_to'] = range.to
}
params['timezone'] = input.timeZone
```

后端 `/home/yomu/elysia-agent/core/input/session_routes.py::search_messages_handler` 把 `date_from/date_to` 原样传给 `query_search`，内部 `date.fromisoformat()` 遇 `T16:00:00.000Z` 抛错 → 吞成 200 空页（前端误判「当天无历史」）。契约权威形态：`date_from=2026-08-14`、`date_to=2026-08-14`、`timezone=Asia/Shanghai`。

**3.2 D4 死代码**：`localDateToHalfOpenRange`（[history-date.ts:22-28](../../../apps/desktop/src/shared/domain/history-date.ts#L22-L28)）仅被 [real-backend.ts:46](../../../apps/desktop/src/main/transport/real-backend.ts#L46)（本批删除点）与自身单测 [history-date.spec.ts:7-22](../../../apps/desktop/tests/unit/history-date.spec.ts#L7-L22) 使用；其私有助手 `getTimezoneOffsetMs`（:5-14）与 `zonedTimeToUtc`（:16-20）也是唯一被它调用，须一并删；`@shared/domain` barrel `export *`（[index.ts](../../../apps/desktop/src/shared/domain/index.ts)），删除导出即自动去桶。mock 后端日期过滤已用自然日语义（`isoToLocalDate(m.createdAt, input.timeZone) === input.localDate`），无需改。

**3.3 D1 webm hint 现状**：[attachment-policy.ts:35](../../../apps/desktop/src/main/attachments/attachment-policy.ts#L35) 对 EBML/webm 魔数（`0x1a45dfa3`）恒返回 `'video'`，无法区分 audio/webm 与 video/webm；[upload-service.ts:152,157](../../../apps/desktop/src/main/attachments/upload-service.ts#L152-L157) 两分支 `kind = sniffKind(head)` 同时用于大小限额与 `UploadContent.kind`（wire hint）。P2-1 曾否决 MIME 判 kind（可伪造绕过限额），故限额仍须魔数；但 webm 是魔数盲区，hint 需 MIME 特例兜底。另 [attachments.ts:79-82](../../../apps/desktop/src/shared/contracts/attachments.ts#L79-L82) `ATTACHMENT_KIND_MIME.audio` 缺 `audio/webm`（video 有 `video/webm`），`kindFromMime('audio/webm')` 落成 `'file'`，渲染层预检/标签与 hint 语义不一致——需补白名单。mock 的 `uploadAttachments` 以 `f.kind ?? kindFromMimeForMock(...)` 为权威（[mock-backend.ts:223](../../../apps/desktop/src/main/transport/mock-backend.ts#L223)），故 hint 生成须在 **upload-service 生成 UploadContent.kind 处**（非 real-backend wire 处），mock/real 行为自动一致。

**3.4 D2 门禁缺口**：[check-backend-contract.mjs](../../../apps/desktop/scripts/check-backend-contract.mjs) 仅守护 WS v2 13 帧（读 `contract.schema.json` + `ws_message.py`，字段级深比较 + error/rejected ACK 探针），**不读 rest.py、不覆盖 multipart**；`package.json` 的 `check:contract` 即此脚本。后端 `frontend_contract/rest.py` 已有目标契约模型：`SearchMessageItem`（:344）/`SearchMessagesResponse`（:356）/`MessageContextResponse`（:335）/`AttachmentInfo`（:493）/`AttachmentUploadResponse`（:510）/`AttachmentSignResponse`/`StickerEntry`（:524）/`StickerListResponse`（:535）；`Role` 枚举 = `{user, assistant, tool}`（:58-63）。前端 zod 侧：`RestSearchMessageItemSchema`/`RestSearchMessagesResponseSchema`/`RestMessageContextResponseSchema`/`RestAttachmentUploadResponseSchema`/`RestAttachmentSignResponseSchema`/`RestStickerItemSchema`/`RestStickerListResponseSchema`（[rest-schemas.ts:84-135](../../../apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts#L84-L135)）均为 `.strict()`。

**3.5 D3 贴图契约现状**：真实后端搜索 item 形状（无 kind/url，P2-3）；前端 [rest-schemas.ts:111-124](../../../apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts#L111-L124) 已按真实形状严格建模（`snippet`/`role` 可选、`.strict()` 拒多余键）；[real-backend-search.spec.ts:167-194](../../../apps/desktop/tests/unit/real-backend-search.spec.ts#L167-L194) 已有 sendMessage wire stickerId 测试；mock 侧有 category=sticker 过滤测试（mock 领域富化含 resource，与真实形状不同）。缺「真实契约形状」的端到端测试：sticker 搜索响应 → Schema → Mapper → IPC → History Store → 展示 + 跳转。错误语义：`mapHttpError`（[real-backend.ts:127-132](../../../apps/desktop/src/main/transport/real-backend.ts#L127-L132)）只映射 `400 CONTRACT_VALIDATION`，后端 P1-01 的 `400 INVALID_TIMEZONE` 落 `UNKNOWN`（展示仍为结构化错误，但语义不准）。

## 4. 整改项设计

### 4.1 FE-S3-INT-P0-01：日期查询按后端自然日契约（+ D4 删死代码）

**改动点：**

1. [real-backend.ts](../../../apps/desktop/src/main/transport/real-backend.ts) `fetchHistoryStream()`（:700-704）改为：

   ```ts
   if (input.localDate) {
     params['date_from'] = input.localDate   // YYYY-MM-DD 自然日（不再预转 UTC ISO）
     params['date_to'] = input.localDate
   }
   params['timezone'] = input.timeZone
   ```

2. 移除 `import { localDateToHalfOpenRange } from '@shared/domain'`（:46）。
3. [history-date.ts](../../../apps/desktop/src/shared/domain/history-date.ts) 删除 `getTimezoneOffsetMs`（:5-14）、`zonedTimeToUtc`（:16-20）、`localDateToHalfOpenRange`（:22-28）三函数及注释；`isoToLocalDate`（:30-36）保留。
4. [history-date.spec.ts](../../../apps/desktop/tests/unit/history-date.spec.ts) 删除「localDateToHalfOpenRange」describe 块（:7-22），保留「isoToLocalDate」块。
5. `mapHttpError`（[real-backend.ts:127-132](../../../apps/desktop/src/main/transport/real-backend.ts#L127-L132)）补一条：`status===400 && code==='INVALID_TIMEZONE' → INVALID_INPUT`（对齐后端 P1-01 fail-fast；历史查看器展示语义准确的错误，不显伪空态）。

**约束（前端清单 §2.2）：** 只传用户选择的自然日；timezone 继续 IANA 名；不在 Adapter 预转 UTC；无日期筛选省略 `date_from/date_to`；`localDateToHalfOpenRange` 删除后不得再用于该后端请求。

### 4.2 FE-S3-INT-DEP-02 配套：WebM kind hint 消歧（D1）

**改动点：**

1. [attachment-policy.ts](../../../apps/desktop/src/main/attachments/attachment-policy.ts) 新增纯函数：

   ```ts
   /** wire kind 提示：webm 魔数无法区分 audio/video，特例回退 MIME（仅 hint；大小限额仍用 sniffKind 魔数，P2-1 防线不变） */
   export function wireKindHint(kind: AttachmentKind, mediaType: string): AttachmentKind {
     if (kind === 'video' && mediaType === 'audio/webm') return 'audio'
     return kind
   }
   ```

2. [upload-service.ts](../../../apps/desktop/src/main/attachments/upload-service.ts) `uploadBatch` 两分支（:154 path / :159 bytes）把 `UploadContent.kind` 从 `sniffKind` 结果改为 `wireKindHint(kind, d.mediaType)`；**大小限额判断 `sizeLimitFor(kind)` 仍用 `sniffKind` 原值**（:153/:158 不变）。
3. [attachments.ts](../../../apps/desktop/src/shared/contracts/attachments.ts) `ATTACHMENT_KIND_MIME.audio` 追加 `'audio/webm'`（渲染层 `kindFromMime` 分类/播放矩阵/预检对齐；`video/webm` 已有）。
4. mock 无需改（自动收到消歧后的 `f.kind`）。

**约束（前端清单 §4.1 冻结语义）：** 每个 `kind` 只作用于紧随其后的一个文件；批次内不同 kind 保持一次上传与整批原子性（不改）；`files` 字段名不变（后端兼容旧 `files[]`）；kind 只是提示，响应 kind/mime 才是权威（现状已如此）；上传成功发送消息时用响应值映射 `{attachmentId, kind, mime}`（现状已如此）。

**已知行为（I1-评审确认，需在 spec 显式记录）：**

- [attachments-contracts.spec.ts:59](../../../apps/desktop/tests/unit/attachments-contracts.spec.ts#L59) 对 `ATTACHMENT_KIND_MIME.audio` 是**精确等值断言**（`toEqual([...])`），补 `'audio/webm'` 后该测试与注释（「audio 可播 mp3/wav/ogg/flac/m4a」）必须同步更新——纳入 §6 测试计划。
- 渲染层 `clientPrecheck`（[attachment-state.ts:102-115](../../../apps/desktop/src/renderer/src/attachments/attachment-state.ts#L102-L115)）用 `kindFromMime` 预检：audio/webm 此前归类 `'file'` 跳过单文件限额，补白名单后按 `audio`（20MB）预检；而 Main 侧权威路径（`sniffKind` 魔数）对 webm 仍按 `video`（50MB）。即 **audio/webm 在 20–50MB 区间渲染层预检更严、Main 放行**——渲染层 UX 预检为早期反馈、Main 为权威，方向为更严，记录为已知行为，不做算法改动。

### 4.3 D2：REST/multipart 跨仓门禁

**4.3.1 check:contract 扩展 REST 段（依赖后端挂载，未挂载跳过）：**

在 [check-backend-contract.mjs](../../../apps/desktop/scripts/check-backend-contract.mjs) 现有 WS 段后新增 REST 段：

1. 读 `frontend_contract/rest.py` 源码。
2. 按 `^class (\w+)\(` 边界切出目标模型类体，解析字段行 `/^    (\w+):\s*([^=#\n]+?)\s*(?:=([^\n]+))?$/`，得 `{name, annotation, default?}`；跳过 docstring（`"""`/`'''` 行）与空行。
3. 目标模型 ↔ 前端 zod schema 映射表：

   | rest.py 模型 | 前端 schema（rest-schemas.ts） | 说明 |
   |---|---|---|
   | `SearchMessageItem` | `RestSearchMessageItemSchema` | role 枚举单独校验 |
   | `SearchMessagesResponse` | `RestSearchMessagesResponseSchema` | |
   | `MessageContextResponse` | `RestMessageContextResponseSchema` | 仅顶层字段（anchor/before/after/conversationId）；内嵌 Message 由 WS 契约已覆盖 |
   | `AttachmentInfo` | `RestAttachmentUploadResponseSchema.shape.attachments` 元素 | |
   | `AttachmentUploadResponse` | `RestAttachmentUploadResponseSchema` | |
   | `AttachmentSignResponse` | `RestAttachmentSignResponseSchema` | |
   | `StickerEntry` | `RestStickerItemSchema` | |
   | `StickerListResponse` | `RestStickerListResponseSchema` | |

4. 校验规则：
   - **字段覆盖**：后端字段名集 ⊆ 前端 schema 键集（前端 `.strict()`，后端新增字段 → 前端缺 → fail）；
   - **必填性**：后端必填字段必须存在于前端 schema（前端可更宽松可选）。**必填判定**（评审 I2/R3 修正，防规则空转）：注解不以 `Optional[` 开头 **且** `Field(...)` 参数内不含 `default=`/`default_factory=`（且默认值非字面 `None`/`""`）——token 检查**作用域限定在 `Field(...)` 实参内**，不扫整段默认值文本（防 description 含 `= None` 等字样误判）。如 `role: Role = Field(description=...)` 即必填；`filename: str = Field(default="", ...)`、`responseId: Optional[str] = Field(default=None, ...)` 即可选；
   - **role 枚举子集**：后端 `Role` 枚举值 ⊆ 前端 role 枚举（`['user','assistant','tool','system']`）。Role 成员用 StrEnum 写法提取：`/^    (\w+)\s*=\s*"([^"]+)"/`（R2：**作用域限定在 `Role` 类体内**——与模型类同一切片，避免误收 `GenerationStatusEnum` 等其他 StrEnum 成员导致子集校验假阳性）。
5. **防静默通过（评审 I4，对齐 WS 段 :62-63/:138 语义）**：解析出的目标模型数 < 8，或任一目标模型字段数为 0 → `exit 1`（防 rest.py 格式变化使正则失效后门禁空转误放行）。
6. 任一字段/枚举 fail → `exit 1` 并列出模型/字段；后端未挂载 → 跳过（与 WS 段同语义）。

**已知限制（M6，后续增强项）：** 本批 REST 段仅比对字段名/必填性/枚举，**不做类型级比对**（`has_more: bool` vs `z.boolean()`、`size: int` vs `z.number()` 的类型漂移静默通过）；类型 token 映射（Python 内建类型 → zod 类型）留待后续。

**4.3.2 纯前端定向 vitest（不依赖后端挂载）：**

- 新增 [real-backend-upload.spec.ts](../../../apps/desktop/tests/unit/real-backend-upload.spec.ts)：注入 `fetchImpl` 捕获 `FormData`（`RealBackendOptions.fetchImpl` 已支持，:58），断言：
  1. FormData part 顺序 `[kind, files, kind, files, …]`（`[...form.entries()]` 保序）；
  2. PNG + MP4 + PDF 混合批次 kind 依次 `['image','video','file']`；
  3. `audio/webm` + `video/webm` 同批传入已消歧 kind（as upload-service 产出）→ 顺序不串位 `['audio','video']`（M2 澄清：**消歧逻辑本身**在 attachment-policy.spec `wireKindHint` 与 upload-service.spec 断言；real-backend 层只验 multipart 顺序与透传）；
  4. 响应 kind 与 hint 不同 → 以响应值为准（`AttachmentInfo.kind` 权威）；
  5. 取消（`AbortSignal` abort）→ reject `INVALID_INPUT '附件上传已取消'`（M3，对齐 real-backend.ts:632），无迟到发送。
- 改 [real-backend-search.spec.ts](../../../apps/desktop/tests/unit/real-backend-search.spec.ts)（:37-58）：日期断言改自然日（`date_from=2026-08-14`、`date_to=2026-08-14`）；测试名「date_from 半开区间」同步改「自然日」（M4）；补 DST 时区自然日命中；补 `INVALID_TIMEZONE` 400 → `INVALID_INPUT` 映射断言。
- [history-viewer.store.spec.ts](../../../apps/desktop/tests/unit/history-viewer.store.spec.ts) 补（C1 修正，对齐 submitQuery 行为）：搜索失败 → `error` 置位 + **`hasSearched` 保持 false**（不触发「没有找到相关聊天记录」空态）+ 保留上次结果。注意：`hasSearched` 仅在成功分支置 true（store :90），断言不得写「失败也置 true」。

### 4.4 FE-S3-INT-DEP-01 配套：贴图真实契约测试 + B-02 验收口径（D3）

**改动点：**

1. 新增 [sticker-contract.spec.ts](../../../apps/desktop/tests/unit/sticker-contract.spec.ts)（fixture 驱动，node env 单元级）：构造后端 `category=sticker` 真实形状响应（含**纯贴图消息空 snippet 项**与「文字+贴图」项，无 `resource`/`kind`/`url` 键），断言：
   - `parseRestSearchMessages` 严格通过（`.strict()` 拒多余键 → 证明不伪造富化）；
   - `restMapper.toChatHistoryItem` 映射出可展示项（snippet 空则展示「（无文本命中）」兜底，见 [CyHistoryResultItem.vue:31](../../../apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue#L31)）；
   - **IPC 通路（M5/R1 澄清，单元级实现，两个方向分开）**：请求方向——store 构造的 `ChatHistoryQuery` 过 `chatQueryHistorySchema`（[channels.ts:97](../../../apps/desktop/src/main/ipc/channels.ts#L97)）`safeParse`；响应方向——restMapper 产出的 `ChatHistoryPage` 过 `ChatHistoryPageSchema`（[chat-handlers.ts:69](../../../apps/desktop/src/main/chat/chat-handlers.ts#L69) `handle()` 双 schema 校验的响应 schema）`safeParse`。fixture 本身是响应形状（`SearchMessagesResponse`），只走响应方向校验，不走请求 schema；两条合起来证明真实后端形状可穿越 IPC 校验层。
   - History Store：`setDesktopApi({ queryChatHistory })` mock 驱动 [historyViewer.store.ts](../../../apps/desktop/src/renderer/src/stores/historyViewer.store.ts) submitQuery（沿用 history-viewer.store.spec.ts 的注入方式：createPinia + setDesktopApi），断言 items 可展示、`conversationId/messageId` 可作 `jumpTo` 跳转字段。
2. 联调验收清单（写入 B-02 报告模板）：贴图发送（WS stickerId）→ 消息列表展示 → 搜索命中 sticker → 来源跳转，四步闭环；真实后端 `category=sticker` 返回 200 非 400。
3. B-02 通过口径（写入 docs/16 阶段3 跟踪表）：**所有分类 tab 搜索结果以「纯文本行 + 「消息」chip」展示**（真实 search item 无 resource，[CyHistoryResultItem.vue:11-12](../../../apps/desktop/src/renderer/src/components/CyHistoryResultItem.vue#L11-L12) chip 恒为「消息」，非按分类标签；空 snippet 显示「（无文本命中）」），无缩略图（P2-3 已知限制）不视为缺陷；`image_video` 双子流独立游标合并语义记录；「跳回来源消息/分段」正常即通过。

## 5. 决策记录

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | webm kind hint 来源 | **MIME 特例回退**：仅 `audio/webm` 时 `video→audio`，其余不变；大小限额仍魔数 sniffKind | 双仓清单均要求 audio/webm+video/webm 分类正确；魔数盲区（EBML 无 audio/video 区分）；MIME 可伪造但 hint 仅提示、后端独立复核，不破 P2-1 限额防线；纯函数最小改动 |
| D2 | REST 门禁载体 | **双轨**：check:contract 扩 REST 段（依赖后端挂载）+ 纯前端定向 vitest | 字段一致性需后端契约源（rest.py 有目标模型）；URL/FormData 语义是纯前端断言、不依赖挂载，CI 稳定；职责分开互不拖累 |
| D3 | 贴图发送纳入 B-02 | **纳入顺带验证**（发送→列表→搜索命中→跳转闭环） | 后端 WS 已接受 stickerId（ws_message.py:714）、前端已发送（real-backend.ts:470）、wire 测试已存在；验证成本低、一次闭环验收 G4 交付 |
| D4 | `localDateToHalfOpenRange` | **删除**（连私有助手与单测） | 修复后唯一调用点消失；保留误导后人以为后端请求仍用它；`isoToLocalDate` 保留供 mock 用 |
| 附 | `audio/webm` 白名单 | 补入 `ATTACHMENT_KIND_MIME.audio` | D1 成立的前置：`kindFromMime` 才能把 audio/webm 归 audio，渲染层播放矩阵/预检/标签与 hint 语义一致；已知行为：渲染层预检按 audio 20MB（此前 file 跳过），Main 魔数路径仍按 video 50MB，渲染层更严，方向安全 |
| 附 | `INVALID_TIMEZONE` 映射 | `400 → INVALID_INPUT` | 对齐后端 P1-01 fail-fast；历史查看器错误语义准确，不显伪空态 |
| 附 | B-02 验收口径 | 纯文本行 + 跳转正常即通过 | P2-3 无缩略图是已知限制，非缺陷；防联调误判 |

## 6. 测试计划

**改动/新增测试（全部单元级，node env，不依赖 Electron）：**

| 文件 | 动作 | 断言要点 |
|---|---|---|
| [real-backend-search.spec.ts](../../../apps/desktop/tests/unit/real-backend-search.spec.ts) | 改 | 日期参数自然日（:49-50）；测试名「半开区间」→「自然日」（M4）；DST 时区自然日；`INVALID_TIMEZONE`→INVALID_INPUT |
| [history-date.spec.ts](../../../apps/desktop/tests/unit/history-date.spec.ts) | 删块 | 删 `localDateToHalfOpenRange` describe，留 `isoToLocalDate` |
| [attachment-policy.spec.ts](../../../apps/desktop/tests/unit/attachment-policy.spec.ts) | 增 | `wireKindHint`：audio/webm→audio、video/webm→video、其余不变 |
| [upload-service.spec.ts](../../../apps/desktop/tests/unit/upload-service.spec.ts) | 增/改 | `UploadContent.kind` 为 `wireKindHint` 消歧后值；大小限额仍按 `sniffKind` 魔数 kind |
| [attachments-contracts.spec.ts](../../../apps/desktop/tests/unit/attachments-contracts.spec.ts) | 改（I1） | `ATTACHMENT_KIND_MIME.audio` 等值断言补 `'audio/webm'`，注释「audio 可播 …m4a」同步 |
| [real-backend-upload.spec.ts](../../../apps/desktop/tests/unit/real-backend-upload.spec.ts) | **新增** | FormData 顺序/混合批次/已消歧 kind 透传不串位/响应权威/取消 reject `INVALID_INPUT '附件上传已取消'` |
| [history-viewer.store.spec.ts](../../../apps/desktop/tests/unit/history-viewer.store.spec.ts) | 增（C1） | 搜索失败 → error 置位 + hasSearched **保持 false** + 保留结果（不显空态） |
| [sticker-contract.spec.ts](../../../apps/desktop/tests/unit/sticker-contract.spec.ts) | **新增** | 真实形状 sticker 响应 → `chatQueryHistorySchema`+`ChatHistoryPageSchema` → restMapper → store（setDesktopApi）可展示 + 跳转字段 |
| [check-backend-contract.mjs](../../../apps/desktop/scripts/check-backend-contract.mjs) | 增 REST 段 | 8 模型字段覆盖/必填性（`default=`/`default_factory=`/`Optional[` 判定）/role 枚举子集/防静默通过（模型数<8 或字段数=0 → exit 1）；后端未挂载跳过 |

**全量门禁：** typecheck / lint / 全部单测 / 39 集成 / build / `check:contract`（后端挂载时 13/13 + REST 段 N/8 通过）。

## 7. 完成定义

- 搜索请求不再出现 UTC ISO `date_from/date_to`（请求参数为 `YYYY-MM-DD`）；
- `localDateToHalfOpenRange` 及其私有助手与单测删除，无残留引用；
- webm 批次 hint 不串位（audio/webm→audio、video/webm→video），`audio/webm` 入白名单（含 `attachments-contracts.spec.ts` 等值断言同步），大小限额仍魔数，渲染层预检差异记录为已知行为；
- check:contract REST 段覆盖 8 模型（字段覆盖/必填性/role 枚举子集/防静默通过），新增定向 vitest 全绿，后端未挂载时跳过不误报；
- sticker 真实契约测试通过（真实形状响应严格 Schema → IPC 双 schema → Mapper → Store 可展示 + 跳转字段）；
- `INVALID_TIMEZONE` 400 映射 INVALID_INPUT；历史查看器失败显结构化错误（`hasSearched` 保持 false，不显空态）；
- 全量门禁（typecheck/lint/单测/集成/build/check:contract）绿；
- 文档更新：docs/review 决策记录补 D1~D4；docs/16 阶段3 跟踪表补 B-02 通过口径；README/CLAUDE.md 测试数字同步（如变化）；
- 已知限制记录：贴图缩略图仍为后续契约增强项（P2-3），B-02 以纯文本行 + 跳转正常为通过标准。
