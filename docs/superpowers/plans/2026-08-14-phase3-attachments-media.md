# 阶段 3 G3：附件与多媒体 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地阶段 3 G3「附件与多媒体」——点击/拖拽/粘贴共用附件状态机与待发送队列（拖拽只建条目绝不自动上传/发送）、Main 校验链（数量/大小/类型/路径/敏感范围/魔数）、批量 multipart 上传（每文件 kind、AbortController 取消、batch 原子）、通用媒体代理 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（attachment 流式签名代理 / sticker 静态代理）+ CSP 最小增量、呈现（图片内联预览 / 视频音频图标卡点击展开 / 文件链接图标卡 / 错误过期撤销不支持占位）、绝对本地路径不泄漏。

**Architecture:** 按信任边界分层——Renderer 只收集浏览器 `File` 对象与展示待发送 UI，真实磁盘路径由 Preload `webUtils.getPathForFile` 注入并立即交 Main 转不透明资源句柄；Main `UploadService`（校验链 + 批量上传，复用 safe-open 平台拒非普通文件）+ `MediaService`（签名 URL 持有/缓存/过期重签/流式代理 + sticker 静态白名单代理）+ 协议 handler 媒体分支（dev/prod 都注册）+ CSP 最小增量（prod 同源 `media-src 'self'`、dev 三处 `cyrene:`）；`Message` 内嵌附件（D2），`SendMessageInput.attachments` 走既有 send/ack/乐观路径（D3）；媒体 ContentPart 在映射层建模（schema 保持 `content: unknown`，schemaHash/check:contract 13/13 不变，D7）；附件状态机为纯函数 `attachmentQueueReducer` 可单测（D4，省略 `uploaded` 瞬态）；上传进度为阶段态 + 不确定 spinner（D10）。

**Tech Stack:** Electron + Vue 3 + TypeScript（strict）+ Pinia（setup store）+ Vitest（node 环境）+ zod（仅 IPC 边界）+ `fs/promises`（Main 直读盘）。**不新增运行时依赖**（无缩略图/高亮/上传进度库；media 用原生 `<img>/<video>/<audio>` + Electron `protocol.handle` 流式代理）。

**Spec:** `docs/superpowers/specs/2026-08-14-phase3-attachments-media-design.md`（v3，已闭环：D1 通用媒体代理 + D7 ContentPart 建模主路径 + G4 贴图边界）。实施者以 spec 为准；本计划每任务引用对应 spec 章节（§2 范围 / §3.1 缺口表 / §3.2 技术约束 / §4.1 决策总表 D1-D10 / §4.2-4.10 / §5 验收 / §6 已知限制）。

**评审修订轮次（1，2026-08-14，独立评审 5 P1 + 8 P2，基于 commit d4c4e0c）：**
- **P1**：
  - P1-1 上传取消接线后端——`BackendAdapter.uploadAttachments` 增 `opts?: { signal? }`（Task 5），Task 7 `uploadBatch` 把 active controller 的 signal 传给 backend，RealBackend 用 `AbortSignal.any([timeoutSignal, cancelSignal])`，Task 7 测试补真实 in-flight abort→reject 闭环（可控 backend，不再依赖不存在的 Task 18）；
  - P1-2 `toIpcDescriptor` 改两个独立 if（`file` 注入 path、`bytes` 独立保留），pathless 粘贴项走 bytes 不丢；
  - P1-3 Task 5 RealBackend 测试加 `WebSocketServer({server, path:'/ws'})` 握手 stub（既有惯例），消除 60s 挂起；
  - P1-4 `sniffKind` 测试改用真实 12 字节 RIFF+WEBP / RIFF+WAVE 头，删「裸 RIFF→image」错误用例；
  - P1-5 dev 省略 `rendererRoot`（媒体分支不依赖）+ handler realpath 失败非媒体一律 404 不抛错。
- **P2**：P2-1 store `descriptor` 的 `source` 改字面联合 `AttachmentSource`；P2-2 `MockBackend.signAttachmentUrl` 删多余 `attachmentId`（TS excess property）；P2-3 rest-mapper 保留 parts 文本兜底；P2-4 `proxyFetch` 网络/5xx 失败映射 502（transient≠not_found）；P2-5 流式 assistant 媒体分段无 `attachmentId` 记为已知限制（wire 契约，待联调）；P2-6 `CyImageAttachment` 补 `name` prop；P2-7 `protocol-media-handler.spec.ts` 改真集成（launchApp + `net.fetch` 命中 `protocol.handle` 媒体分支）；P2-8 Task 14 取消测试改确定性 deferred（消除 5ms 定时竞态）。

---

## Global Constraints（subagent 必须遵守，逐条绑定）

1. **TypeScript 严格**：新增/修改文件必须过 `pnpm -F @cyrene/desktop typecheck`（typecheck:node 覆盖 main/preload/shared，typecheck:web 覆盖 renderer）。
2. **zod 只在 IPC 边界**：request/response schema 只出现在 `main/ipc/channels.ts`、`shared/schemas/ipc-response.ts`、`preload/desktop-api.ts` 的防御性解析；Main 服务层（UploadService/MediaService）与 Renderer 纯逻辑层一律不用 zod（形状手检 + 类型守卫）。
3. **不新增运行时依赖**：只用现有 vue/pinia/marked + Node 内置（fs/promises、crypto、FormData/Blob/fetch——Node 22 全局可用）。
4. **Renderer 不碰文件系统、不直连后端、不持有签名 URL**：路径只在 Preload/Main 流转（D5）；`path` 不进入 contextBridge 返回面、不入 Pinia store、不进后端；`cyrene://` 媒体 URL 是 Renderer 唯一媒体来源。
5. **设计 token 在 `tokens.css` 单一来源**：组件只使用现有 `--cy-accent/--cy-accent-strong/--cy-accent-text/--cy-border/--cy-danger/--cy-muted/--cy-pane/--cy-surface/--cy-surface-hover/--cy-surface-soft/--cy-success/--cy-text/--cy-user/--cy-warning/--cy-window` 等，不新增颜色 token。
6. **CSP 同步纪律（G-9）**：prod 响应头 `buildRendererCsp()` 与 index.html meta **AND 取交集、严格头胜出**——改 meta 会静默改变 prod 有效策略；本批 **prod 头与 meta 必须同步**（prod 文档同源 cyrene://renderer，`img-src 'self'` 同源即放行；`media-src` 需新增 `'self'`；dev 三处加 `cyrene:`——`buildDevCsp()` 的 `media-src`、`img-src` 与 index.html meta，**connect-src 不动**）。
7. **附件状态机与 docs/06 §7 枚举一致**：`selected|validating|ready|uploading|failed|cancelled`，**省略 `uploaded` 瞬态**（D4）；拖拽/粘贴/点击只建条目、不自动上传/发送；`uploading` 期间禁止移除。
8. **batch 原子（D3）**：一次上传全成或全不成；上传失败逐文件 `failed(reason)`；`attachmentsCancel` 经 AbortController 批量中止。
9. **TDD 红-绿-提交**：每任务先写失败测试→跑（FAIL）→最小实现→跑（PASS）→commit；commit 消息 `feat/fix/test/docs(...)`，中文说明（如 `feat(G3 attachment): ...`）。组件任务无单测基线，以 `typecheck` + `build` 为准（spec §6 已知限制）。
10. **文档编辑保持中文**（docs 集约定）。
11. **门禁**（Task 17 全量复跑）：`typecheck` / `lint`（`--max-warnings=0`）/ `test`（527 现有 + 本组新增）/ `test:integration`（23 现有 + 本组 2 新增，预期不回退）/ `build` / `check:contract`（13/13，schema 结构不变——`content` 保持 `unknown`，指纹不下探嵌套元素，实施时实测确认）/ `package` + `verify:artifact --smoke`（protocol/CSP/装配改动波及打包路径，必须复跑）。
12. **三态状态源**：本组无真实后端附件联调对象（上传/签发/媒体真实链路未联调）→ 本地门禁全绿后标「**已开发、未联调**」，不得标「已完成」（spec §5 验收最后一项）。
13. **G4 边界（锁定决策，2026-08-14）**：表情包贴图复用本组通用媒体代理 `__cyrene-media/sticker/{stickerId}`（静态 `/static/stickers/{stickerId}.png`、stickerId 白名单 `^st_[A-Za-z0-9-]+$`、MIME 白名单 image/png、无签名）与待发送队列 `PendingSticker` 分支；本批只做承载点，贴图业务语义（选包/发送/呈现）由 G4 完成。

---

## 文件结构（新建 / 修改）

**新建（shared / main / preload / renderer）：**
- `apps/desktop/src/shared/contracts/attachments.ts` —— 队列 + 上传/校验/媒体状态类型 + 限额单一事实来源（spec §4.2）
- `apps/desktop/src/main/transport/protocol-v2/content-part.ts` —— 媒体 ContentPart 建模 + 映射（spec D7）
- `apps/desktop/src/main/attachments/attachment-policy.ts` —— 纯校验策略：限额/kind 矩阵/魔数嗅探（spec §4.5）
- `apps/desktop/src/main/attachments/upload-service.ts` —— `UploadService`：validateFiles / uploadBatch / cancel（spec §4.5）
- `apps/desktop/src/main/attachments/media-service.ts` —— `MediaService`：resolveSignedUrl / stream / checkStatus + parseMediaPath / isDocumentRequest（spec D1/D6）
- `apps/desktop/src/main/attachments/attachments-handlers.ts` —— 四通道 IPC handler（spec §4.5 IPC 注册）
- `apps/desktop/src/renderer/src/attachments/attachment-state.ts` —— 纯状态机 reducer + canSendQueue + clientPrecheck（spec §4.3）
- `apps/desktop/src/renderer/src/utils/media.ts` —— 播放矩阵 PLAYABLE_MEDIA（spec §4.6）
- `apps/desktop/src/renderer/src/utils/media-url.ts` —— `mediaUrlFor` 媒体 URL 构造（spec §4.4）
- `apps/desktop/src/renderer/src/stores/attachment.store.ts` —— Pinia 附件 store（spec §4.3/4.4）
- `apps/desktop/src/renderer/src/components/CyAttachmentQueue.vue`、`CyDropOverlay.vue`、`CyAttachmentMedia.vue`、`CyImageAttachment.vue`、`CyVideoAttachment.vue`、`CyAudioAttachment.vue`、`CyFileAttachment.vue`、`CyLinkAttachment.vue`、`CyAttachmentPlaceholder.vue`（spec §4.6/4.7/4.9）

**新建（测试）：**
- `apps/desktop/tests/unit/attachments-contracts.spec.ts`、`content-part.spec.ts`、`attachment-policy.spec.ts`、`attachment-validate.spec.ts`、`upload-service.spec.ts`、`media-service.spec.ts`、`desktop-api-attachments.spec.ts`、`attachment-state.spec.ts`、`attachment.store.spec.ts`、`media-utils.spec.ts`
- `apps/desktop/tests/integration/ipc-attachments.spec.ts`、`protocol-media-handler.spec.ts`

**修改：**
- `apps/desktop/src/shared/contracts/message.ts`（AttachmentKind/MessageAttachment/MessageAttachmentRef/AssistantSegment 媒体字段/Message.attachments/SendMessageInput.attachments）、`index.ts`（export attachments）
- `apps/desktop/src/shared/contracts/ipc.ts`（四通道常量）
- `apps/desktop/src/shared/schemas/ipc-response.ts`（MessageAttachmentSchema/AssistantSegmentSchema 媒体字段/MessageSchema.attachments/FileValidationResultSchema/AttachmentsUploadResponseSchema/AttachmentCheckResultSchema）
- `apps/desktop/src/main/ipc/channels.ts`（attachmentsValidateSchema/attachmentsUploadSchema/attachmentsCancelSchema/attachmentsCheckSchema/UploadFileDescriptorSchema/chatSendSchema.attachments）
- `apps/desktop/src/main/transport/backend-adapter.ts`（UploadContent + uploadAttachments/signAttachmentUrl）
- `apps/desktop/src/main/transport/real-backend.ts`（multipart 上传 + 签发 + sendMessage 带 attachments）
- `apps/desktop/src/main/transport/mock-backend.ts`（确定性上传/签发）
- `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（media ContentPart 映射）
- `apps/desktop/src/main/protocol/handler.ts`（`{rendererRoot?, resolveMedia?}` + 媒体分支，dev/prod 都注册）
- `apps/desktop/src/main/protocol/csp.ts`（`media-src 'self'`）
- `apps/desktop/src/main/config/dev-csp.ts`（`media-src`/`img-src` 加 `cyrene:`）
- `apps/desktop/src/renderer/index.html`（meta CSP 同步）
- `apps/desktop/src/main/windows/navigation.ts`（`__cyrene-media/*` 前缀 deny）
- `apps/desktop/src/main/index.ts`（dev 也注册 protocol + MediaService/UploadService 装配 + attachments handlers）
- `apps/desktop/src/main/ipc/handlers.ts`（注册 attachments-handlers）
- `apps/desktop/src/preload/desktop-api.ts`（四方法 + webUtils.getPathForFile）
- `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`（DesktopApiLike 四方法）
- `apps/desktop/src/renderer/src/stores/message.store.ts`（send 接受 attachments）
- `apps/desktop/src/renderer/src/components/CyChatInput.vue`、`CyMessageBubble.vue`

**文档（Task 17）：** spec §7 —— docs/02 §19 注记、docs/06 附件状态节、docs/16 阶段 3 勾选与测试数字、README/CLAUDE.md 三态标记。

**范围外（不做）：** 贴图/表情包发送状态机（G4，本组只定义队列联合类型与媒体代理 sticker 分支）；历史查看器；会话级草稿持久化（G2）；缩略图生成（锁定不引库）；文件保存到磁盘（D-08 P2）；断点续传；上传字节级进度。

---

### Task 1: 附件领域模型（message.ts + ipc-response 镜像）（D2/D7）

> 扩展 `AssistantSegment` 媒体引用字段、`Message.attachments`、`AttachmentKind`/`MessageAttachment`/`MessageAttachmentRef`、`SendMessageInput.attachments`；`shared/schemas/ipc-response.ts` 严格镜像（C1：字段可丢即契约漂移）。**不改 schema 结构**（`content` 保持 `unknown`），故 schemaHash/check:contract 不受影响。

**Files:**
- Modify: `apps/desktop/src/shared/contracts/message.ts`
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`
- Test: `apps/desktop/tests/unit/attachments-contracts.spec.ts`（本任务只断言 MessageAttachmentSchema/AssistantSegmentSchema 形状）

**Interfaces:**
- Produces（Task 2-5、7、11-16 消费）：
  - `export type AttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'link'`
  - `export interface MessageAttachment { attachmentId: string; kind: AttachmentKind; mediaType: string; name?: string; size?: number; width?: number; height?: number; durationMs?: number; messageId?: string }`
  - `export interface MessageAttachmentRef { attachmentId: string; kind: AttachmentKind; mime: string }`
  - `AssistantSegment` 增：`attachmentId?/url?/mediaType?/name?/size?/width?/height?/durationMs?`
  - `Message` 增：`attachments?: MessageAttachment[]`
  - `SendMessageInput` 增：`attachments?: MessageAttachmentRef[]`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/attachments-contracts.spec.ts`

```typescript
// tests/unit/attachments-contracts.spec.ts
// Task 1:附件领域模型（spec §4.2，D2/D7）——MessageAttachment/MessageAttachmentRef 形状 + AssistantSegment/Message 扩展经响应 schema 校验。
// env=node：纯 zod schema 断言，无 Electron。
import { describe, expect, it } from 'vitest'
import type { MessageAttachment, MessageAttachmentRef } from '../../src/shared/contracts/message'
import { AssistantSegmentSchema, MessageAttachmentSchema, MessageSchema } from '../../src/shared/schemas'

describe('附件领域模型（spec §4.2）', () => {
  it('MessageAttachmentSchema 接受上传响应形态（name/size/尺寸/来源消息均可缺省兜底）', () => {
    const a: MessageAttachment = { attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 }
    const r = MessageAttachmentSchema.safeParse(a)
    expect(r.success).toBe(true)
    expect(r.data).toEqual(a)
  })
  it('MessageAttachmentSchema 全 optional 字段缺省也可过（历史回放兜底）', () => {
    const r = MessageAttachmentSchema.safeParse({ attachmentId: 'att_1', kind: 'video', mediaType: 'video/mp4' })
    expect(r.success).toBe(true)
  })
  it('MessageAttachmentSchema 拒非法 kind', () => {
    expect(MessageAttachmentSchema.safeParse({ attachmentId: 'att_1', kind: 'bogus', mediaType: 'x' }).success).toBe(false)
  })
  it('MessageAttachmentRef 三字段形状（wire 提示值）', () => {
    const ref: MessageAttachmentRef = { attachmentId: 'att_1', kind: 'image', mime: 'image/png' }
    expect(AssistantSegmentSchema).toBeDefined()
    expect(ref).toEqual({ attachmentId: 'att_1', kind: 'image', mime: 'image/png' })
  })
  it('AssistantSegmentSchema 接受媒体引用字段（媒体分段形状）', () => {
    const r = AssistantSegmentSchema.safeParse({
      segmentId: 'seg-1', segmentIndex: 1, channel: 'public_reply', kind: 'image', completed: true,
      attachmentId: 'att_1', url: '/api/attachments/att_1', mediaType: 'image/png', width: 100, height: 80
    })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ attachmentId: 'att_1', mediaType: 'image/png', width: 100 })
  })
  it('MessageSchema 接受 attachments（Message.attachments 内嵌）', () => {
    const r = MessageSchema.safeParse({
      messageId: 'm1', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't',
      content: 'hi', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png' }]
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts`
Expected: FAIL——`MessageAttachmentSchema` 未导出；`AssistantSegmentSchema` 拒绝媒体字段（strict 前多键报错）。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/shared/contracts/message.ts`

追加到 `message.ts`（`SegmentKind` 之后）：

```typescript
/** 附件类别（链接为资源级类别，不参与上传 kind） */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'link'

/** 已发送消息携带的附件（上传响应/媒体分段映射而来）；name/size/尺寸：上传响应与历史/回放 ContentPart 均提供，字段仍 optional 兜底 */
export interface MessageAttachment {
  attachmentId: string            // att_ 前缀（后端权威）
  kind: AttachmentKind
  mediaType: string               // MIME
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
  /** 来源消息跳转锚点（历史查看器复用；本批消息内嵌不另存 ConversationResource） */
  messageId?: string
}

/** 发送消息携带的附件引用（wire AttachmentRef 提示值；服务端以记录为准） */
export interface MessageAttachmentRef {
  attachmentId: string
  kind: AttachmentKind
  mime: string
}
```

`AssistantSegment` 接口替换为（追加媒体引用字段）：

```typescript
export interface AssistantSegment {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind              // 含 image/video/audio/file/link
  text?: string
  completed: boolean
  attachmentId?: string          // 媒体分段：附件 ID（ContentPart.attachment_id 优先，src 兜底解析）
  url?: string                   // 稳定路径 /api/attachments/{id}（展示兜底；attachment_id 缺失时解析）
  mediaType?: string
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
}
```

`Message` 增（`tool?` 之后）：`attachments?: MessageAttachment[]`；`SendMessageInput` 增：`attachments?: MessageAttachmentRef[]`。

`apps/desktop/src/shared/schemas/ipc-response.ts`：

```typescript
export const MessageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
  mediaType: z.string().min(1),
  name: z.string().optional(),
  size: z.number().nonnegative().optional(),
  width: z.number().nonnegative().optional(),
  height: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  messageId: z.string().optional()
})
```

`AssistantSegmentSchema` 追加媒体字段（text 之后）：`attachmentId: z.string().optional(), url: z.string().optional(), mediaType: z.string().optional(), name: z.string().optional(), size: z.number().optional(), width: z.number().optional(), height: z.number().optional(), durationMs: z.number().optional()`；`MessageSchema` 追加 `attachments: z.array(MessageAttachmentSchema).optional()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts`
Expected: PASS（6 tests）。再跑 `pnpm -F @cyrene/desktop typecheck` 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/message.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/tests/unit/attachments-contracts.spec.ts
git commit -m "feat(G3 attachment): 附件领域模型与响应 schema 镜像（D2/D7）"
```

---

### Task 2: 附件/队列/上传契约类型 + IPC 通道常量（spec §4.2）

> 新建 `shared/contracts/attachments.ts`：队列联合（`PendingSendItem`，含 G4 `PendingSticker` 分支）、`UploadFileDescriptor`、`FileValidationResult`、`AttachmentsUploadResponse`、`AttachmentMediaStatus`、`AttachmentCheckResult`、`AttachmentInfo`、`AttachmentSignResult`、限额常量（`ATTACHMENT_LIMITS` 单一事实来源，Renderer/Main 共用）。`ipc.ts` 增四通道常量；`index.ts` 导出。

**Files:**
- Create: `apps/desktop/src/shared/contracts/attachments.ts`
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`、`apps/desktop/src/shared/contracts/index.ts`
- Test: `apps/desktop/tests/unit/attachments-contracts.spec.ts`（追加 describe）

**Interfaces:**
- Consumes（Task 1）：`AttachmentKind`、`MessageAttachment`
- Produces（Task 3、7、8、11-16 消费）：
  - `export type AttachmentSource = 'picker' | 'drag_drop' | 'paste'`
  - `export type PendingAttachmentStatus = 'selected' | 'validating' | 'ready' | 'uploading' | 'failed' | 'cancelled'`
  - `export interface PendingAttachment { kind: 'attachment'; localId: string; name: string; size: number; mediaType: string; source: AttachmentSource; status: PendingAttachmentStatus; reason?: string }`
  - `export interface PendingSticker { kind: 'sticker'; stickerId: string; name?: string; status: 'ready' }`
  - `export type PendingSendItem = PendingAttachment | PendingSticker`
  - `export interface UploadFileDescriptor { localId: string; name: string; size: number; mediaType: string; source: AttachmentSource; kind?: AttachmentKind; path?: string; bytes?: Uint8Array }`
  - `export interface FileValidationResult { localId: string; ok: boolean; kind?: AttachmentKind; reason?: string; message?: string }`
  - `export interface AttachmentsUploadResponse { uploadId: string; attachments: MessageAttachment[] }`
  - `export type AttachmentMediaStatus = 'ok' | 'expired' | 'not_found' | 'revoked' | 'error'`
  - `export interface AttachmentCheckResult { status: AttachmentMediaStatus; reason?: string }`
  - `export interface AttachmentInfo { attachmentId: string; kind: string; mime: string; size: number; url: string; signedUrl?: string; filename: string }`
  - `export interface AttachmentSignResult { url: string; expiresAt: string }`
  - `export const ATTACHMENT_MAX_FILES = 10`；`export const ATTACHMENT_AGGREGATE_BYTES = 64 * 1024 * 1024`；`export const ATTACHMENT_MAX_BYTES_BY_KIND: Record<AttachmentKind, number>`（image 10MB / video 50MB / audio 20MB / file 20MB / link 0）；`export const ATTACHMENT_KIND_MIME: Record<AttachmentKind, readonly string[]>`（D-03 播放矩阵的 MIME 白名单）
  - IpcChannels 增：`attachmentsValidate/attachmentsUpload/attachmentsCancel/attachmentsCheck`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/attachments-contracts.spec.ts`

```typescript
import { ATTACHMENT_MAX_FILES, ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_KIND_MIME, type PendingSendItem, type UploadFileDescriptor } from '../../src/shared/contracts/attachments'
import { IpcChannels } from '../../src/shared/contracts'

describe('附件/队列/上传契约（spec §4.2）', () => {
  it('限额常量单一事实来源（D-04：≤10 / 聚合 64MB / 单文件 10/50/20/20MB）', () => {
    expect(ATTACHMENT_MAX_FILES).toBe(10)
    expect(ATTACHMENT_AGGREGATE_BYTES).toBe(64 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.image).toBe(10 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.video).toBe(50 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.audio).toBe(20 * 1024 * 1024)
    expect(ATTACHMENT_MAX_BYTES_BY_KIND.file).toBe(20 * 1024 * 1024)
  })
  it('播放矩阵 MIME 白名单与 D-03 一致（video 可播 mp4/webm/ogv；audio 可播 mp3/wav/ogg/flac/m4a；image png/jpg/gif/webp/svg）', () => {
    expect(ATTACHMENT_KIND_MIME.video).toEqual(['video/mp4', 'video/webm', 'video/ogg'])
    expect(ATTACHMENT_KIND_MIME.audio).toEqual(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'])
    expect(ATTACHMENT_KIND_MIME.image).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
  })
  it('队列联合可判别：attachment 分支状态机枚举无 uploaded 瞬态（D4）', () => {
    const item: PendingSendItem = { kind: 'attachment', localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'drag_drop', status: 'selected' }
    expect(item.kind).toBe('attachment')
    const statuses: ReadonlyArray<string> = ['selected', 'validating', 'ready', 'uploading', 'failed', 'cancelled']
    for (const s of statuses) expect(statuses).toContain(s)
    expect(statuses).not.toContain('uploaded')
  })
  it('G4 PendingSticker 分支挂入队列（入队即 ready）', () => {
    const st: PendingSendItem = { kind: 'sticker', stickerId: 'st_1', status: 'ready' }
    expect(st.kind).toBe('sticker')
    expect(st.status).toBe('ready')
  })
  it('UploadFileDescriptor 二选一承载 path/bytes（path 仅 Preload 注入）', () => {
    const d: UploadFileDescriptor = { localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array(2) }
    expect(d.path).toBeUndefined()
    expect(d.bytes).toBeInstanceOf(Uint8Array)
  })
  it('IPC 四通道常量存在', () => {
    expect(IpcChannels.attachmentsValidate).toBe('attachments:validate')
    expect(IpcChannels.attachmentsUpload).toBe('attachments:upload')
    expect(IpcChannels.attachmentsCancel).toBe('attachments:cancel')
    expect(IpcChannels.attachmentsCheck).toBe('attachments:check')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts`
Expected: FAIL——模块 `attachments` 不存在 / `IpcChannels.attachmentsValidate` undefined。

- [ ] **Step 3: 最小实现** —— 三个文件

`apps/desktop/src/shared/contracts/attachments.ts`（完整新建）：

```typescript
// src/shared/contracts/attachments.ts
// 阶段 3 G3（spec §4.2）：附件/队列/上传/媒体状态契约 + 限额单一事实来源（Renderer 预检与 Main 权威校验共用）。
// 队列联合含 G4 PendingSticker 分支（spec §2 G4 边界：贴图非附件，无上传/签名）。
import type { AttachmentKind, MessageAttachment } from './message'

export type AttachmentSource = 'picker' | 'drag_drop' | 'paste'
export type PendingAttachmentStatus = 'selected' | 'validating' | 'ready' | 'uploading' | 'failed' | 'cancelled'

/** G3 附件条目（状态机见 spec §4.3；省略 uploaded 瞬态，D4） */
export interface PendingAttachment {
  kind: 'attachment'
  localId: string
  name: string
  size: number
  mediaType: string
  source: AttachmentSource
  status: PendingAttachmentStatus
  reason?: string   // failed 的可解释原因
}

/** G4 表情包贴图挂入本队列的最小分支（sticker 非附件：无 attachmentId/上传/签名） */
export interface PendingSticker {
  kind: 'sticker'
  stickerId: string        // ^st_[A-Za-z0-9-]+$
  name?: string
  status: 'ready'          // 贴图无校验/上传阶段，入队即 ready
}

export type PendingSendItem = PendingAttachment | PendingSticker

/** 上传文件描述符（Renderer→Preload 携带 file?/bytes?；Preload 以 webUtils 注入 path；IPC 至 Main 时 path?/bytes? 二选一） */
export interface UploadFileDescriptor {
  localId: string
  name: string
  size: number
  mediaType: string
  source: AttachmentSource
  kind?: AttachmentKind      // 校验阶段魔数判定的每文件 kind（P2-3：批量上传按文件 kind；可省略由后端魔数判定）
  path?: string              // 仅 Preload 注入；Renderer 永不构造
  bytes?: Uint8Array         // 仅粘贴型（pathless）
}

/** 校验结果（per-file） */
export interface FileValidationResult { localId: string; ok: boolean; kind?: AttachmentKind; reason?: string; message?: string }

/** 上传响应（batch 原子，一次调用） */
export interface AttachmentsUploadResponse { uploadId: string; attachments: MessageAttachment[] }

/** 媒体状态分类（元素 error 后按需经 attachments:check 查询） */
export type AttachmentMediaStatus = 'ok' | 'expired' | 'not_found' | 'revoked' | 'error'
export interface AttachmentCheckResult { status: AttachmentMediaStatus; reason?: string }

/** 后端上传响应条目（契约 frontend_contract AttachmentInfo；kind 权威） */
export interface AttachmentInfo {
  attachmentId: string
  kind: string
  mime: string
  size: number
  url: string
  signedUrl?: string
  filename: string
}

/** 签发端点响应（GET /api/attachments/{id}/sign） */
export interface AttachmentSignResult { url: string; expiresAt: string }

// —— 限额（D-04 后端数值沿用；Renderer 预检与 Main 权威校验共用，单一事实来源）——
export const ATTACHMENT_MAX_FILES = 10
export const ATTACHMENT_AGGREGATE_BYTES = 64 * 1024 * 1024
export const ATTACHMENT_MAX_BYTES_BY_KIND: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  file: 20 * 1024 * 1024,
  link: 0
}

/** kind → 接受 MIME 白名单（D-03 播放矩阵参考表；列表外一律 file 图标卡） */
export const ATTACHMENT_KIND_MIME: Record<AttachmentKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'],
  file: [],
  link: []
}
```

`apps/desktop/src/shared/contracts/ipc.ts`：`IpcChannels` 对象追加 `attachmentsValidate: 'attachments:validate', attachmentsUpload: 'attachments:upload', attachmentsCancel: 'attachments:cancel', attachmentsCheck: 'attachments:check'`。

`apps/desktop/src/shared/contracts/index.ts`：追加 `export * from './attachments'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（Task 1 6 + Task 2 6 = 12 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/contracts/attachments.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/contracts/index.ts apps/desktop/tests/unit/attachments-contracts.spec.ts
git commit -m "feat(G3 attachment): 附件/队列/上传契约与 IPC 通道常量（spec §4.2）"
```

---

### Task 3: IPC request/response zod schema（channels.ts + ipc-response.ts 镜像）

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`（`chatSendSchema` 增 attachments + 四通道 request schema）
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（FileValidationResultSchema/AttachmentsUploadResponseSchema/AttachmentCheckResultSchema）
- Test: `apps/desktop/tests/unit/attachments-contracts.spec.ts`（追加 describe：request schema 校验）

**Interfaces:**
- Consumes（Task 2）：`UploadFileDescriptor` 等类型
- Produces（Task 10、11 消费）：
  - `export const UploadFileDescriptorSchema`（zod；`path?/bytes?` refine 二选一）
  - `export const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })`
  - `export const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })`
  - `export const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })`
  - `export const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })`
  - `chatSendSchema` 增 `attachments: z.array(z.object({ attachmentId: z.string().min(1), kind: z.enum(['image','video','audio','file','link']), mime: z.string().min(1) })).optional()`
  - `FileValidationResultSchema`、`AttachmentsUploadResponseSchema`、`AttachmentCheckResultSchema`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/attachments-contracts.spec.ts`

```typescript
import { attachmentsUploadSchema, attachmentsValidateSchema, attachmentsCancelSchema, attachmentsCheckSchema, chatSendSchema } from '../../src/main/ipc/channels'
import { AttachmentsUploadResponseSchema, AttachmentCheckResultSchema, FileValidationResultSchema } from '../../src/shared/schemas'

describe('IPC request/response schema（spec §4.2/§4.5）', () => {
  it('attachmentsValidateSchema 收 files[1..10]，path/bytes 二选一', () => {
    const ok = attachmentsValidateSchema.safeParse({ files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array(2) }] })
    expect(ok.success).toBe(true)
    const noBoth = attachmentsValidateSchema.safeParse({ files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'image/png', source: 'picker', path: '/tmp/a', bytes: new Uint8Array(2) }] })
    expect(noBoth.success).toBe(false)   // path/bytes 二选一
    const empty = attachmentsValidateSchema.safeParse({ files: [] })
    expect(empty.success).toBe(false)    // min(1)
    const over = attachmentsValidateSchema.safeParse({ files: Array.from({ length: 11 }, (_, i) => ({ localId: `l${i}`, name: 'a', size: 1, mediaType: 'x', source: 'picker' as const, path: '/tmp/a' })) })
    expect(over.success).toBe(false)     // max(10)
  })
  it('attachmentsUploadSchema 需 uploadId + files[1..10]', () => {
    expect(attachmentsUploadSchema.safeParse({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'picker', path: '/tmp/a' }] }).success).toBe(true)
    expect(attachmentsUploadSchema.safeParse({ files: [] }).success).toBe(false)
    expect(attachmentsUploadSchema.safeParse({ uploadId: '', files: [] }).success).toBe(false)
  })
  it('attachmentsCancelSchema / attachmentsCheckSchema 单字段', () => {
    expect(attachmentsCancelSchema.safeParse({ uploadId: 'u1' }).success).toBe(true)
    expect(attachmentsCheckSchema.safeParse({ attachmentId: 'att_1' }).success).toBe(true)
    expect(attachmentsCheckSchema.safeParse({}).success).toBe(false)
  })
  it('chatSendSchema 接受可选 attachments（MessageAttachmentRef 形状）', () => {
    const r = chatSendSchema.safeParse({ conversationId: 'c1', text: 'hi', clientRequestId: 'cr1', attachments: [{ attachmentId: 'att_1', kind: 'image', mime: 'image/png' }] })
    expect(r.success).toBe(true)
  })
  it('响应 schema：FileValidationResult/UploadResponse/CheckResult', () => {
    expect(FileValidationResultSchema.safeParse({ localId: 'l1', ok: false, reason: 'too_large' }).success).toBe(true)
    expect(AttachmentsUploadResponseSchema.safeParse({ uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png' }] }).success).toBe(true)
    expect(AttachmentCheckResultSchema.safeParse({ status: 'expired' }).success).toBe(true)
    expect(AttachmentCheckResultSchema.safeParse({ status: 'bogus' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts`
Expected: FAIL——`attachmentsUploadSchema` 等未导出。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/ipc/channels.ts`

追加（文件末尾，import 区补 `AttachmentKind` 类型导入 `import type { AttachmentKind } from '@shared/contracts'`）：

```typescript
// —— attachments 命令 request schema（spec §4.2/§4.5；响应 schema 在 shared/schemas/ipc-response）——
export const UploadFileDescriptorSchema = z.object({
  localId: z.string().min(1),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  source: z.enum(['picker', 'drag_drop', 'paste']),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  path: z.string().optional(),
  bytes: z.instanceof(Uint8Array).optional()
}).refine((d) => (d.path !== undefined) !== (d.bytes !== undefined), { message: 'path/bytes 二选一' })

export const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
export const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })
export const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })
```

`chatSendSchema` 改为：

```typescript
export const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  clientRequestId: z.string().min(1),
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.enum(['image', 'video', 'audio', 'file', 'link']),
    mime: z.string().min(1)
  })).optional()
})
```

`apps/desktop/src/shared/schemas/ipc-response.ts` 追加：

```typescript
export const FileValidationResultSchema = z.object({
  localId: z.string().min(1),
  ok: z.boolean(),
  kind: z.enum(['image', 'video', 'audio', 'file', 'link']).optional(),
  reason: z.string().optional(),
  message: z.string().optional()
})
export const AttachmentsUploadResponseSchema = z.object({
  uploadId: z.string().min(1),
  attachments: z.array(MessageAttachmentSchema)
})
export const AttachmentCheckResultSchema = z.object({
  status: z.enum(['ok', 'expired', 'not_found', 'revoked', 'error']),
  reason: z.string().optional()
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-contracts.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（12 + 5 = 17 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/channels.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/tests/unit/attachments-contracts.spec.ts
git commit -m "feat(G3 attachment): 附件四通道 request schema + 响应 schema 镜像（spec §4.5）"
```

---

### Task 4: 媒体 ContentPart 建模 + rest-mapper 映射（D7 主路径）

> **前提修正（spec v3 P1-1）**：两 schema `content` 均为 `z.unknown().optional()`，媒体 ContentPart **本可过 `.strict()` 解析**——不存在「整条拒绝」缺口；真实缺口是映射层 `extractText` 丢媒体。本任务在映射层建模（schema 结构不动，`content` 保持 `unknown`）。新建 `content-part.ts` 提供 `mapContentToEntries`（有序文本/媒体条目）与 `mapContentMedia`（消息级附件），rest-mapper `assemble` 调用并把媒体映射为 `assistantSegments` 媒体分段 + `Message.attachments`。

**Files:**
- Create: `apps/desktop/src/main/transport/protocol-v2/content-part.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`
- Test: `apps/desktop/tests/unit/content-part.spec.ts`（新建）+ `apps/desktop/tests/unit/rest-mapper.spec.ts`（追加）+ `apps/desktop/tests/unit/raw-schemas.spec.ts`（追加：媒体 content 可解析 + 指纹不变）

**Interfaces:**
- Consumes（Task 1）：`MessageAttachment`、`AssistantSegment` 媒体字段
- Produces（Task 5 消费）：
  - `export interface MappedMedia { kind: 'image' | 'video' | 'audio' | 'file'; attachmentId?: string; url?: string; mediaType?: string; name?: string; size?: number; width?: number; height?: number; durationMs?: number }`
  - `export function parseAttachmentIdFromSrc(src?: string): string | undefined`（src 尾段解析，校验 `^att_[A-Za-z0-9_-]+$`）
  - `export function mapContentToEntries(content: unknown): Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia }>`
  - `export function mapContentMedia(content: unknown): MessageAttachment[]`（消息级附件，attachment_id 优先、src 兜底）

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/content-part.spec.ts`

```typescript
// tests/unit/content-part.spec.ts
// Task 4:媒体 ContentPart 建模（spec §4.2/§4.4，D7）——content(unknown) 数组 → 有序文本/媒体条目 + 消息级附件。
import { describe, expect, it } from 'vitest'
import { mapContentMedia, mapContentToEntries, parseAttachmentIdFromSrc } from '../../src/main/transport/protocol-v2/content-part'

describe('parseAttachmentIdFromSrc', () => {
  it('稳定路径尾段解析 att_ ID（校验格式）', () => {
    expect(parseAttachmentIdFromSrc('/api/attachments/att_abc')).toBe('att_abc')
    expect(parseAttachmentIdFromSrc('att_abc')).toBe('att_abc')      // 纯 ID 也可
    expect(parseAttachmentIdFromSrc('/api/attachments/other')).toBeUndefined()  // 非 att_ 前缀拒
    expect(parseAttachmentIdFromSrc(undefined)).toBeUndefined()
    expect(parseAttachmentIdFromSrc('/api/attachments/att_1/extra')).toBeUndefined()  // 尾段必须恰一个
  })
})

describe('mapContentToEntries（有序文本/媒体，供 segmentIndex 分配）', () => {
  it('字符串 content → 单一文本条目', () => {
    expect(mapContentToEntries('你好')).toEqual([{ type: 'text', text: '你好' }])
  })
  it('媒体 ContentPart 数组 → 文本与媒体交错保留顺序', () => {
    const content = [
      { type: 'text', text: '见图：' },
      { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', width: 100, height: 80, attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024 },
      { type: 'video', src: '/api/attachments/att_2', mime: 'video/mp4', duration_ms: 5000 },
      { type: 'file', src: '/api/attachments/att_3', mime: 'application/pdf', attachment_id: 'att_3', filename: 'doc.pdf', size_bytes: 2048 }
    ]
    const entries = mapContentToEntries(content)
    expect(entries[0]).toEqual({ type: 'text', text: '见图：' })
    expect(entries[1]).toMatchObject({ type: 'media', media: { kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 } })
    expect(entries[2]).toMatchObject({ type: 'media', media: { kind: 'video', attachmentId: 'att_2', durationMs: 5000 } })
    expect(entries[3]).toMatchObject({ type: 'media', media: { kind: 'file', attachmentId: 'att_3' } })
  })
  it('attachment_id 缺失时从 src 尾段解析（兜底）', () => {
    const entries = mapContentToEntries([{ type: 'audio', src: '/api/attachments/att_9', mime: 'audio/mpeg' }])
    expect(entries[0]).toMatchObject({ type: 'media', media: { kind: 'audio', attachmentId: 'att_9' } })
  })
  it('sticker ContentPart 不产媒体条目/附件（G4 边界）', () => {
    expect(mapContentToEntries([{ type: 'sticker', sticker_id: 'st_1', src: '/static/stickers/st_1.png' }])).toEqual([])
  })
  it('未知 type / 非对象元素 → 忽略（宽容）', () => {
    expect(mapContentToEntries([{ type: 'bogus' }, 'x', null])).toEqual([])
  })
})

describe('mapContentMedia（消息级附件）', () => {
  it('媒体 ContentPart → MessageAttachment[]（name/size/尺寸/时长映射）', () => {
    const atts = mapContentMedia([
      { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024, width: 100, height: 80 },
      { type: 'audio', src: '/api/attachments/att_2', mime: 'audio/mpeg', duration_ms: 3000 }
    ])
    expect(atts).toEqual([
      { attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 },
      { attachmentId: 'att_2', kind: 'audio', mediaType: 'audio/mpeg', durationMs: 3000 }
    ])
  })
  it('无 attachmentId（src 也解析不到）→ 不产附件（媒体缺身份不进领域）', () => {
    expect(mapContentMedia([{ type: 'image', src: '/other/path.png', mime: 'image/png' }])).toEqual([])
  })
  it('纯文本/空 → []', () => {
    expect(mapContentMedia('文本')).toEqual([])
    expect(mapContentMedia(undefined)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/content-part.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/transport/protocol-v2/content-part.ts`

```typescript
// src/main/transport/protocol-v2/content-part.ts
// 阶段 3 G3（spec §4.4/§4.5，D7）：媒体 ContentPart 建模——schema 保持 content:unknown，
// 建模在映射层（两 schema content 为 z.unknown().optional()，媒体本可过 .strict() 解析，真实缺口是映射层丢媒体）。
import type { AttachmentKind, MessageAttachment } from '@shared/contracts/message'

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/

export interface MappedMedia {
  kind: 'image' | 'video' | 'audio' | 'file'
  attachmentId?: string
  url?: string
  mediaType?: string
  name?: string
  size?: number
  width?: number
  height?: number
  durationMs?: number
}

interface ContentPartShape {
  type?: string
  src?: string
  mime?: string
  attachment_id?: string
  filename?: string
  size_bytes?: number
  width?: number
  height?: number
  duration_ms?: number
}

/** src 稳定路径尾段解析 att_ ID；格式不匹配返回 undefined（spec §6：attachment_id 优先，src 兜底解析并校验格式） */
export function parseAttachmentIdFromSrc(src?: string): string | undefined {
  if (!src) return undefined
  const tail = src.split('/').pop() ?? ''
  const m = tail === src ? undefined : tail   // 纯 ID（无 '/'）也接受；其余经 '/api/attachments/{id}' 尾段
  const id = m ?? (/\/api\/attachments\/([^/]+)$/.exec(src)?.[1] ?? (ATTACHMENT_ID_PATTERN.test(src) ? src : undefined))
  if (id && ATTACHMENT_ID_PATTERN.test(id)) return id
  return undefined
}

function toMedia(part: ContentPartShape, kind: 'image' | 'video' | 'audio' | 'file'): MappedMedia {
  const attachmentId = part.attachment_id ?? parseAttachmentIdFromSrc(part.src)
  return {
    kind,
    ...(attachmentId ? { attachmentId } : {}),
    ...(part.src ? { url: part.src } : {}),
    ...(part.mime ? { mediaType: part.mime } : {}),
    ...(part.filename ? { name: part.filename } : {}),
    ...(part.size_bytes !== undefined ? { size: part.size_bytes } : {}),
    ...(part.width !== undefined ? { width: part.width } : {}),
    ...(part.height !== undefined ? { height: part.height } : {}),
    ...(part.duration_ms !== undefined ? { durationMs: part.duration_ms } : {})
  }
}

/** 有序文本/媒体条目（assemble 据此分配全局 segmentIndex；sticker/未知 type 忽略——G4 边界） */
export function mapContentToEntries(content: unknown): Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia }> {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const entries: Array<{ type: 'text'; text: string } | { type: 'media'; media: MappedMedia }> = []
  for (const p of content) {
    if (typeof p !== 'object' || p === null) continue
    const part = p as ContentPartShape
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      entries.push({ type: 'text', text: part.text })
    } else if (part.type === 'image' || part.type === 'video' || part.type === 'audio' || part.type === 'file') {
      entries.push({ type: 'media', media: toMedia(part, part.type) })
    }
    // sticker/status/未知：G4 贴图消费，本批不产媒体条目
  }
  return entries
}

/** 消息级附件（user/assistant 消息 content 中的媒体 → Message.attachments；无 attachmentId 不产） */
export function mapContentMedia(content: unknown): MessageAttachment[] {
  const attachments: MessageAttachment[] = []
  for (const entry of mapContentToEntries(content)) {
    if (entry.type !== 'media') continue
    const m = entry.media
    if (!m.attachmentId) continue
    attachments.push({
      attachmentId: m.attachmentId,
      kind: m.kind as AttachmentKind,
      mediaType: m.mediaType ?? 'application/octet-stream',
      ...(m.name ? { name: m.name } : {}),
      ...(m.size !== undefined ? { size: m.size } : {}),
      ...(m.width !== undefined ? { width: m.width } : {}),
      ...(m.height !== undefined ? { height: m.height } : {}),
      ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {})
    })
  }
  return attachments
}
```

`apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`：`assemble` 中 assistant 分支替换为（`mapContentToEntries`/`mapContentMedia` import）：

```typescript
} else if (role === 'assistant') {
  const segments: NonNullable<Message['assistantSegments']> = []
  if (src.inner_voice) segments.push({ segmentId: `iv-${base.messageId}`, segmentIndex: 0, channel: 'inner_voice', kind: 'text', text: src.inner_voice, completed: true })
  let segIndex = segments.length
  // P2-3：保留 parts 文本兜底——assistant content 为纯媒体数组（无文本条目）时，正文经 extractText(src.content, src.parts) 兜底补一个文本条目
  const entries = mapContentToEntries(src.content)
  const mainText = entries.some((e) => e.type === 'text') ? undefined : extractText(src.content, src.parts)
  const ordered = mainText ? [{ type: 'text' as const, text: mainText }, ...entries] : entries
  for (const entry of ordered) {
    if (entry.type === 'text') {
      segments.push({ segmentId: `pr-${base.messageId}-${segIndex}`, segmentIndex: segIndex, channel: 'public_reply', kind: 'markdown', text: entry.text, completed: true })
      segIndex += 1
    } else {
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
    }
  }
  if (segments.length) base.assistantSegments = segments
}
```

并在 `assemble` 末尾（tool/mood 处理之前）追加消息级附件：

```typescript
const media = mapContentMedia(src.content)
if (media.length) base.attachments = media
```

（`assemble` 的 role==='user'/'tool' 分支保持 `extractText`；media attachments 对 user/tool 消息同样落 `base.attachments`。）

- [ ] **Step 4: 追加 rest-mapper 与 raw-schemas 测试**

`apps/desktop/tests/unit/rest-mapper.spec.ts` 追加 describe：

```typescript
describe('RestMapper 媒体 ContentPart（D7 主路径：映射层不丢媒体）', () => {
  it('assistant 消息 content 含媒体 → 分段 + 消息级附件（name/size/尺寸从 ContentPart 映射）', () => {
    const raw: RestMessage = {
      role: 'assistant', content: [
        { type: 'text', text: '见图：' },
        { type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1', filename: 'a.png', size_bytes: 1024, width: 100, height: 80 }
      ],
      message_id: 'msg-img', timestamp: '2026-08-11T00:00:04.000Z', session_id: 'conv-1', _id: 'i1'
    }
    const m = mapper.toDomainMessage(raw)
    const segs = m.assistantSegments ?? []
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'image'])
    expect(segs[1]).toMatchObject({ kind: 'image', attachmentId: 'att_1', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 })
    expect(m.attachments).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 1024, width: 100, height: 80 }])
  })
  it('user 消息 content 含媒体 → Message.attachments（正文空则 content 缺省）', () => {
    const raw: RestMessage = {
      role: 'user', content: [{ type: 'file', src: '/api/attachments/att_2', mime: 'application/pdf', attachment_id: 'att_2', filename: 'doc.pdf', size_bytes: 2048 }],
      message_id: 'msg-f', timestamp: '2026-08-11T00:00:05.000Z', session_id: 'conv-1', _id: 'i2'
    }
    const m = mapper.toDomainMessage(raw)
    expect(m.content).toBeUndefined()
    expect(m.attachments).toEqual([{ attachmentId: 'att_2', kind: 'file', mediaType: 'application/pdf', name: 'doc.pdf', size: 2048 }])
  })
  it('assistant 纯媒体 content 且 parts 有文本 → 文本分段兜底（P2-3 parts 兜底）', () => {
    const raw: RestMessage = {
      role: 'assistant',
      content: [{ type: 'image', src: '/api/attachments/att_9', mime: 'image/png', attachment_id: 'att_9' }],
      parts: [{ content: '见附件' }],
      message_id: 'msg-parts', timestamp: '2026-08-11T00:00:06.000Z', session_id: 'conv-1', _id: 'i9'
    }
    const m = mapper.toDomainMessage(raw)
    const segs = m.assistantSegments ?? []
    expect(segs.map((s) => s.kind)).toEqual(['markdown', 'image'])
    expect(segs[0].text).toBe('见附件')
    expect(segs[1]).toMatchObject({ kind: 'image', attachmentId: 'att_9' })
  })
})
```

`apps/desktop/tests/unit/raw-schemas.spec.ts` 追加 describe（schema 结构不动，媒体 content 本可解析 + 指纹不变）：

```typescript
import { parseRawFrame, rawSchemasFingerprint } from '../../src/main/transport/protocol-v2/raw-schemas'

describe('媒体 ContentPart 过 raw schema + 指纹不变（D7，schemaHash 门禁）', () => {
  it('session 回放项 content 为媒体 ContentPart 数组可解析（schema 保持 content:unknown，无整条拒绝）', () => {
    const frame = {
      type: 'session', conversationId: 'conv-1',
      messages: [{ role: 'assistant', message_id: 'msg-1', timestamp: 't',
        content: [{ type: 'image', src: '/api/attachments/att_1', mime: 'image/png', attachment_id: 'att_1' }] }]
    }
    const r = parseRawFrame(frame)
    expect(r.success).toBe(true)
  })
  it('rawSchemasFingerprint 不含 content 嵌套结构（指纹不下探嵌套元素）→ 本批不改 schema 故指纹不变', () => {
    const fp = rawSchemasFingerprint()
    // content 字段 zod 类型仍为 z.unknown().optional()，其 _def.type 不变；断言指纹为 64 位 hex 即可（相对不变性由 wire-fixtures 门禁兜）
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/content-part.spec.ts tests/unit/rest-mapper.spec.ts tests/unit/raw-schemas.spec.ts`
Expected: PASS（content-part 9 + rest-mapper 现有 7 + 新增 3（含 P2-3 parts 兜底）+ raw-schemas 现有 + 2）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/content-part.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/tests/unit/content-part.spec.ts apps/desktop/tests/unit/rest-mapper.spec.ts apps/desktop/tests/unit/raw-schemas.spec.ts
git commit -m "feat(G3 attachment): 媒体 ContentPart 建模 + rest-mapper 映射（D7 主路径）"
```

---

### Task 5: BackendAdapter 上传/签发 + RealBackend multipart + MockBackend 确定性版

**Files:**
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`（接口 + UploadContent）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（uploadAttachments multipart + signAttachmentUrl + sendMessage 带 attachments）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`
- Test: `apps/desktop/tests/unit/real-backend.spec.ts`（追加）、`apps/desktop/tests/unit/mock-backend-state.spec.ts`（追加）

**Interfaces:**
- Consumes（Task 2）：`AttachmentInfo`、`AttachmentSignResult`
- Produces（Task 7、8 消费）：
  - `export interface UploadContent { name: string; mediaType: string; size: number; kind?: AttachmentKind; path?: string; bytes?: Uint8Array }`（backend-adapter.ts）
  - `BackendAdapter.uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]>`（**P1-1**：`opts.signal` 为调用方取消信号——`attachments:cancel` 经 Main AbortController abort() 批量终止，IPC 以 cancelled 错误 reject，spec §4.1 D10 / §5 验收#4）
  - `BackendAdapter.signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult>`
  - RealBackendOptions 增 `uploadTimeoutMs?: number`（默认 60000，上传长超时非 10s，spec §4.4）
  - `RealBackend.sendMessage` payload 带 `attachments`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/real-backend.spec.ts`

```typescript
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { RealBackend } from '../../src/main/transport/real-backend'
import type { UploadContent } from '../../src/main/transport/backend-adapter'
import { CyreneErrorCode } from '@shared/errors'

describe('RealBackend uploadAttachments / signAttachmentUrl（spec §4.5/§3.2）', () => {
  // P1-3：既有惯例（real-backend.spec.ts 同款）——同一 http server 上挂真实 WebSocketServer({path:'/ws'}) 握手 stub，
  // 使 backend.connect 在 server_info 后 resolve；否则普通 http server 对 /ws 返 404 → 重连退避 ~61s 挂起。
  function uploadServer(handler: (req: import('http').IncomingMessage, chunks: Buffer[]) => void): Promise<{ port: number; close(): void }> {
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => handler(req, chunks))
        if (req.url === '/api/uploads') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ attachments: [{ attachmentId: 'att_up1', kind: 'image', mime: 'image/png', size: 2, url: '/api/attachments/att_up1', filename: 'a.png' }] }))
          }, 5)
        } else if (req.url === '/api/attachments/att_up1/sign') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ attachmentId: 'att_up1', url: 'https://cdn.example/att_up1?sig=abc&exp=2030-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00.000Z' }))
        } else { res.writeHead(404); res.end() }
      })
      const wss = new WebSocketServer({ server: s, path: '/ws' })
      wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
        ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
        ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
      })
      s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => { wss.close(); s.close() } }))
    })
  }

  it('multipart POST /api/uploads（每文件 kind + bytes 型），响应映射 AttachmentInfo', async () => {
    const { port, close } = await uploadServer((req, chunks) => {
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/api/uploads')
      expect(req.headers['content-type']).toMatch(/multipart\/form-data; boundary=/)
      expect(req.headers['content-type']).not.toMatch(/application\/json/)
      const body = Buffer.concat(chunks).toString('utf8')
      expect(body).toContain('name="files"')
      expect(body).toContain('filename="a.png"')
      expect(body).toContain('name="kind"')
      expect(body).toContain('image')   // 每文件 kind 提示值
    })
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const files: UploadContent[] = [{ name: 'a.png', mediaType: 'image/png', size: 2, kind: 'image', bytes: new Uint8Array([0x89, 0x50]) }]
      const infos = await backend.uploadAttachments(files)
      expect(infos).toEqual([{ attachmentId: 'att_up1', kind: 'image', mime: 'image/png', size: 2, url: '/api/attachments/att_up1', filename: 'a.png' }])
      await backend.disconnect()
    } finally { close() }
  })

  it('signAttachmentUrl 带 Bearer 调 /sign 解析 AttachmentSignResult', async () => {
    const { port, close } = await uploadServer((_req, _chunks) => {})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const r = await backend.signAttachmentUrl('att_up1')
      expect(r.url).toContain('sig=abc')
      expect(r.expiresAt).toBe('2030-01-01T00:00:00.000Z')
      await backend.disconnect()
    } finally { close() }
  })

  it('opts.signal 已中止 → 上传立即 reject（取消经 signal 接入，P1-1）', async () => {
    const { port, close } = await uploadServer((_req, _chunks) => {})
    try {
      const backend = new RealBackend({ now: () => Date.now() })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const controller = new AbortController()
      controller.abort()   // 预中止：AbortSignal.any 组合后 fetch 立即 abort → catch 走取消分支
      const files: UploadContent[] = [{ name: 'a.png', mediaType: 'image/png', size: 2, bytes: new Uint8Array([0x89, 0x50]) }]
      await expect(backend.uploadAttachments(files, { signal: controller.signal })).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
      await backend.disconnect()
    } finally { close() }
  })
})
```

`apps/desktop/tests/unit/mock-backend-state.spec.ts` 追加：

```typescript
describe('MockBackend 附件确定性（spec §3.2 MockBackend 需扩展）', () => {
  it('uploadAttachments 返回确定性 AttachmentInfo（kind 权威，size 用客户端声明）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const infos = await mb.uploadAttachments([{ name: 'a.png', mediaType: 'image/png', size: 2, bytes: new Uint8Array([0x89, 0x50]) }])
    expect(infos).toHaveLength(1)
    expect(infos[0].attachmentId).toMatch(/^att_/)
    expect(infos[0].kind).toBe('image')
    expect(infos[0].size).toBe(2)
    expect(infos[0].url).toMatch(/^\/api\/attachments\/att_/)
    expect(infos[0].filename).toBe('a.png')
  })
  it('signAttachmentUrl 返回假签名 URL（可解析、expiresAt 为注入时钟 ISO）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const r = await mb.signAttachmentUrl('att_1')
    expect(r.url).toContain('/api/attachments/att_1?')
    expect(r.url).toContain('sig=')
    expect(r.expiresAt).toBe('2026-08-14T00:00:00.000Z')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend.spec.ts tests/unit/mock-backend-state.spec.ts`
Expected: FAIL——`uploadAttachments`/`signAttachmentUrl` 不存在（接口与方法缺失）。

- [ ] **Step 3: 实现 BackendAdapter 接口**

`backend-adapter.ts`：

```typescript
import type { AttachmentKind } from '@shared/contracts/message'
import type { AttachmentInfo, AttachmentSignResult } from '@shared/contracts/attachments'

/** 上传内容（路径型 Main 直读盘 / 粘贴型 bytes；kind 为客户端提示值，可省略由后端魔数判定） */
export interface UploadContent {
  name: string
  mediaType: string
  size: number
  kind?: AttachmentKind
  path?: string
  bytes?: Uint8Array
}
```

接口内追加：

```typescript
  /** 批量 multipart 上传（batch 原子；AttachmentInfo.kind 权威；P1-1：opts.signal 为调用方取消信号，abort 后 reject cancelled） */
  uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]>
  /** 签发短期签名 URL（Main 持有，不落 Renderer） */
  signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult>
```

- [ ] **Step 4: 实现 RealBackend 两方法 + sendMessage attachments**

`real-backend.ts` 增 `uploadTimeoutMs`（RealBackendOptions 加 `uploadTimeoutMs?: number`，常量 `UPLOAD_TIMEOUT_DEFAULT_MS = 60000`）与方法：

```typescript
  private async readUploadBytes(f: UploadContent): Promise<Uint8Array> {
    if (f.bytes) return f.bytes
    if (f.path) return new Uint8Array(await (await import('fs/promises')).readFile(f.path))
    throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '上传内容缺少 bytes/path')
  }

  async uploadAttachments(files: UploadContent[], opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]> {
    if (!this.serverUrl) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'REST 方法需先 connect')
    const uploadTimeoutMs = this.options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_DEFAULT_MS
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), uploadTimeoutMs)
    // P1-1：取消经 opts.signal 接入——AbortSignal.any 组合超时与调用方取消；任一方 abort 即终止 fetch（spec §4.1 D10）
    const effectiveSignal = opts?.signal ? AbortSignal.any([timeoutController.signal, opts.signal]) : timeoutController.signal
    this.activeControllers.add(timeoutController)
    const form = new FormData()
    for (const f of files) {
      const bytes = await this.readUploadBytes(f)
      // 每文件 kind：重复 kind 字段按文件顺序对应；可省略由后端魔数判定
      if (f.kind) form.append('kind', f.kind)
      form.append('files', new Blob([bytes], { type: f.mediaType }), f.name)
    }
    const url = `${this.serverUrl.replace(/\/$/, '')}/api/uploads`
    try {
      const res = await (this.options.fetchImpl ?? fetch)(url, {
        method: 'POST',
        signal: effectiveSignal,
        headers: { authorization: `Bearer ${this.token}` },   // multipart 不设 content-type（fetch 自动带 boundary）
        body: form
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const code = (body as { code?: string }).code ?? 'HTTP_ERROR'
        throw new CyreneError(mapHttpError(res.status, code), (body as { message?: string }).message ?? `HTTP ${res.status}`, body)
      }
      const parsed = parseAttachmentUploadResponse(await res.json())
      if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '附件上传响应校验失败')
      return parsed.data.attachments
    } catch (e) {
      if (opts?.signal?.aborted) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, '附件上传已取消')   // 调用方取消（IPC attachments:cancel 触发）
      if (timeoutController.signal.aborted) {
        if (this.disconnected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, '连接已断开，上传已取消')
        throw new CyreneError(CyreneErrorCode.TIMEOUT, `附件上传超时(${uploadTimeoutMs}ms)`)
      }
      throw e
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(timeoutController)
    }
  }

  async signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult> {
    const res = await this.restFetch(`/api/attachments/${encodeURIComponent(attachmentId)}/sign`)
    const parsed = parseAttachmentSignResponse(await res.json())
    if (!parsed.success) throw new CyreneError(CyreneErrorCode.SCHEMA_VALIDATION_FAILED, '签发响应校验失败')
    return parsed.data
  }
```

`sendMessage` payload 追加（`conversationId` 之后）：

```typescript
    const payload: Record<string, unknown> = { type: 'text', content: input.text, clientRequestId: input.clientRequestId, conversationId: input.conversationId }
    if (input.attachments?.length) payload.attachments = input.attachments
```

`parseAttachmentUploadResponse`/`parseAttachmentSignResponse` 加到 `rest-schemas.ts`（响应 schema；请求不建 zod）：

```typescript
export const RestAttachmentUploadResponseSchema = z.object({
  attachments: z.array(z.object({
    attachmentId: z.string().min(1),
    kind: z.string().min(1),
    mime: z.string().min(1),
    size: z.number().int().nonnegative(),
    url: z.string().min(1),
    signedUrl: z.string().optional(),
    filename: z.string()
  }))
}).strict()
export const RestAttachmentSignResponseSchema = z.object({
  attachmentId: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.string().min(1)
}).strict()
export function parseAttachmentUploadResponse(input: unknown) {
  return RestAttachmentUploadResponseSchema.safeParse(input)
}
export function parseAttachmentSignResponse(input: unknown) {
  return RestAttachmentSignResponseSchema.safeParse(input)
}
```

> safeParse 返回判别联合 `{success:true;data: <schema 推导类型>} | {success:false;error: ZodError}`；real-backend 调用方按 `parsed.success` 收窄（与既有 parseRest* 助手同模式）。`RestAttachmentUploadResponseSchema` 推导的 `data.attachments` 字段与 `AttachmentInfo` 同形。

- [ ] **Step 5: 实现 MockBackend 两方法**

`mock-backend.ts`：

```typescript
  async uploadAttachments(files: UploadContent[]): Promise<AttachmentInfo[]> {
    if (!this.connected) throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'MockBackend 未连接')
    return files.map((f) => {
      const attachmentId = `att_${this.idFactory().replace(/[^A-Za-z0-9_-]/g, '')}`
      const kind = f.kind ?? kindFromMimeForMock(f.mediaType)
      return { attachmentId, kind, mime: f.mediaType, size: f.size, url: `/api/attachments/${attachmentId}`, filename: f.name }
    })
  }

  async signAttachmentUrl(attachmentId: string): Promise<AttachmentSignResult> {
    const base = 'https://mock.local'
    // P2-2：返回精确 AttachmentSignResult 形状（{url,expiresAt}）——多余 attachmentId 属字面量超集，TS excess property 报错
    return { url: `${base}/api/attachments/${encodeURIComponent(attachmentId)}?sig=mock&exp=1`, expiresAt: this.now().toISOString() }
  }
```

`UploadContent`/`AttachmentInfo`/`AttachmentSignResult` import 到 mock-backend.ts；`kindFromMimeForMock` 为本地小函数（`image/*→image`、`video/*→video`、`audio/*→audio`、其余 `file`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/real-backend.spec.ts tests/unit/mock-backend-state.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts apps/desktop/tests/unit/real-backend.spec.ts apps/desktop/tests/unit/mock-backend-state.spec.ts
git commit -m "feat(G3 attachment): BackendAdapter 上传/签发 + RealBackend multipart + MockBackend 确定性版"
```

---

### Task 6: `attachment-policy.ts` —— 纯校验策略（限额/kind 矩阵/魔数嗅探）

**Files:**
- Create: `apps/desktop/src/main/attachments/attachment-policy.ts`
- Test: `apps/desktop/tests/unit/attachment-policy.spec.ts`

**Interfaces:**
- Consumes（Task 2）：`ATTACHMENT_*` 常量、`AttachmentKind`
- Produces（Task 7 UploadService 消费）：
  - `export function kindFromMime(mime: string): AttachmentKind`（白名单匹配，否则 `file`）
  - `export function sniffKind(head: Uint8Array): AttachmentKind`（轻量魔数嗅探表：PNG/JPEG/GIF/WebP/SVG/MP4/WebM/OGG/MP3/WAV/FLAC/M4A）
  - `export function isKindAcceptable(kind: AttachmentKind, mime: string): boolean`（`ATTACHMENT_KIND_MIME[kind].includes(mime)`，file 恒真）
  - `export function sizeLimitFor(kind: AttachmentKind): number`（`ATTACHMENT_MAX_BYTES_BY_KIND[kind]`）
  - `export interface PrecheckIssue { name: string; reason: 'too_many' | 'too_large_aggregate' | 'size_limit' | 'unsupported_type' }`
  - `export function precheckFiles(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; issues: PrecheckIssue[] }`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/attachment-policy.spec.ts`

```typescript
// tests/unit/attachment-policy.spec.ts
// Task 6:纯校验策略（spec §4.5/§3.2 D-04）——kind 矩阵、魔数嗅探、数量/聚合/单文件限额预检。env=node 无 fs。
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX_BYTES_BY_KIND } from '../../src/shared/contracts/attachments'
import { isKindAcceptable, kindFromMime, precheckFiles, sniffKind } from '../../src/main/attachments/attachment-policy'

describe('kindFromMime / isKindAcceptable（D-03 矩阵）', () => {
  it('白名单 MIME → 对应 kind', () => {
    expect(kindFromMime('image/png')).toBe('image')
    expect(kindFromMime('video/mp4')).toBe('video')
    expect(kindFromMime('audio/mpeg')).toBe('audio')
  })
  it('列表外 → file', () => {
    expect(kindFromMime('application/pdf')).toBe('file')
    expect(kindFromMime('application/octet-stream')).toBe('file')
  })
  it('isKindAcceptable 按 kind 白名单；file 恒真', () => {
    expect(isKindAcceptable('image', 'image/png')).toBe(true)
    expect(isKindAcceptable('image', 'video/mp4')).toBe(false)
    expect(isKindAcceptable('file', 'anything/x')).toBe(true)
  })
})

describe('sniffKind（轻量魔数嗅探）', () => {
  const head = (bytes: number[]) => new Uint8Array(bytes)
  it('PNG / JPEG / GIF / WebP', () => {
    expect(sniffKind(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image')
    expect(sniffKind(head([0xff, 0xd8, 0xff, 0xe0]))).toBe('image')
    expect(sniffKind(head([0x47, 0x49, 0x46, 0x38]))).toBe('image')
    // P1-4：RIFF 分支按 bytes[8..11] 判 WEBP/WAVE——测试用真实 12 字节 RIFF+WEBP 头（裸 RIFF 无法判 kind）
    expect(sniffKind(head([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]))).toBe('image')
  })
  it('MP4（ftyp）/ WebM / OGG', () => {
    expect(sniffKind(head([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]))).toBe('video')
    expect(sniffKind(head([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video')   // EBML → webm
    expect(sniffKind(head([0x4f, 0x67, 0x67, 0x53]))).toBe('audio')   // OggS → ogg（video/audio 以 kind 区分）
  })
  it('MP3（ID3）/ WAV / FLAC / 未知', () => {
    expect(sniffKind(head([0x49, 0x44, 0x33, 0x03]))).toBe('audio')
    expect(sniffKind(head([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe('audio')
    expect(sniffKind(head([0x66, 0x4c, 0x61, 0x43]))).toBe('audio')
    expect(sniffKind(head([0x00, 0x11, 0x22, 0x33]))).toBe('file')
  })
})

describe('precheckFiles（数量/聚合/单文件限额）', () => {
  it('数量 > 10 → too_many', () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1, mediaType: 'image/png' }))
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('too_many')
  })
  it('聚合 > 64MB → too_large_aggregate', () => {
    const files = [{ name: 'a', size: 40 * 1024 * 1024, mediaType: 'video/mp4' }, { name: 'b', size: 30 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('too_large_aggregate')
  })
  it('单文件超 kind 限额 → size_limit', () => {
    const files = [{ name: 'a', size: ATTACHMENT_MAX_BYTES_BY_KIND.image + 1, mediaType: 'image/png' }]
    expect(precheckFiles(files).ok).toBe(false)
    expect(precheckFiles(files).issues[0].reason).toBe('size_limit')
  })
  it('视频超 50MB → size_limit（kind 按 MIME 判定）', () => {
    const files = [{ name: 'v', size: 51 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(precheckFiles(files).ok).toBe(false)
  })
  it('全部通过 → ok:true，无 issues', () => {
    expect(precheckFiles([{ name: 'a', size: 1024, mediaType: 'image/png' }]).ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-policy.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/attachments/attachment-policy.ts`

```typescript
// src/main/attachments/attachment-policy.ts
// 阶段 3 G3（spec §4.5/§3.2 D-04）：纯校验策略——kind 矩阵、魔数嗅探、限额预检。
// 与 Renderer 共用 ATTACHMENT_* 常量（shared/contracts/attachments.ts 单一事实来源）；本模块无 fs 依赖。
import { ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_KIND_MIME, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_MAX_FILES } from '@shared/contracts/attachments'
import type { AttachmentKind } from '@shared/contracts/message'

/** 白名单 MIME → kind；列表外一律 file（spec §4.6 播放矩阵） */
export function kindFromMime(mime: string): AttachmentKind {
  const k = (Object.keys(ATTACHMENT_KIND_MIME) as AttachmentKind[]).find((kk) => kk !== 'file' && kk !== 'link' && ATTACHMENT_KIND_MIME[kk].includes(mime))
  return k ?? 'file'
}

export function isKindAcceptable(kind: AttachmentKind, mime: string): boolean {
  if (kind === 'file') return true
  return ATTACHMENT_KIND_MIME[kind].includes(mime)
}

export function sizeLimitFor(kind: AttachmentKind): number {
  return ATTACHMENT_MAX_BYTES_BY_KIND[kind]
}

/** 轻量魔数嗅探表（小表：常见 image/video/audio 签名；后端魔数为权威，本表用于客户端校验提示） */
function sniff(bytes: Uint8Array): 'image' | 'video' | 'audio' | null {
  const at = (off: number): number => bytes[off] ?? 0
  if (bytes.length < 4) return null
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image'   // PNG
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image'                       // JPEG
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image'     // GIF
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46) {
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image'  // WEBP
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'audio'  // WAV
    return null
  }
  if (at(0) === 0x00 && at(1) === 0x00 && at(2) === 0x00 && bytes[3] !== undefined && at(3) >= 0x08 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video'  // MP4 ftyp
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video'      // EBML(webm)
  if (at(0) === 0x4f && at(1) === 0x67 && at(2) === 0x67 && at(3) === 0x53) return 'audio'      // OggS
  if (at(0) === 0x49 && at(1) === 0x44 && at(2) === 0x33) return 'audio'                       // ID3(mp3)
  if (at(0) === 0x66 && at(1) === 0x4c && at(2) === 0x61 && at(3) === 0x43) return 'audio'      // fLaC
  return null
}

/** 魔数嗅探 → kind（未知 → file，最终以后端魔数真值为准） */
export function sniffKind(head: Uint8Array): AttachmentKind {
  return sniff(head) ?? 'file'
}

export interface PrecheckIssue {
  name: string
  reason: 'too_many' | 'too_large_aggregate' | 'size_limit' | 'unsupported_type'
}

/** 客户端/权威共用的预检：数量 ≤10 / 聚合 ≤64MB / 单文件按 kind 限额（D-04 沿用后端数值） */
export function precheckFiles(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; issues: PrecheckIssue[] } {
  const issues: PrecheckIssue[] = []
  if (files.length > ATTACHMENT_MAX_FILES) issues.push({ name: files[0]?.name ?? '', reason: 'too_many' })
  const aggregate = files.reduce((s, f) => s + f.size, 0)
  if (aggregate > ATTACHMENT_AGGREGATE_BYTES) issues.push({ name: files[0]?.name ?? '', reason: 'too_large_aggregate' })
  for (const f of files) {
    const kind = kindFromMime(f.mediaType)
    if (!isKindAcceptable(kind, f.mediaType) && kind !== 'file') {
      issues.push({ name: f.name, reason: 'unsupported_type' })
    }
    if (f.size > sizeLimitFor(kind)) issues.push({ name: f.name, reason: 'size_limit' })
  }
  return { ok: issues.length === 0, issues }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-policy.spec.ts`
Expected: PASS（13 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/attachments/attachment-policy.ts apps/desktop/tests/unit/attachment-policy.spec.ts
git commit -m "feat(G3 attachment): 纯校验策略——kind 矩阵/魔数嗅探/限额预检（D-04）"
```

---

### Task 7: `UploadService` —— 校验链 + 批量上传 + 取消（spec §4.4/§4.5/§4.8）

> `validateFiles`：precheck（数量/聚合/kind）→ 路径 realpath + 普通文件（复用 safe-open 平台 `existingReadFlags`：posix `O_NOFOLLOW|O_NONBLOCK` 拒 FIFO/socket/设备/目录/symlink；windows preOpenLstat）→ 敏感范围（拒 `expectedUserDataBase()` 内含路径）→ 魔数嗅探逐项结果。`uploadBatch`：上传前 `fs.stat` 复验实际大小与普通文件（防伪造描述符）→ `adapter.uploadAttachments`（batch 原子）→ `AttachmentInfo[]` → 领域 `MessageAttachment[]`（`AttachmentInfo.kind` 权威）；AbortController 挂起，`cancel(uploadId)` 中止。上传 IPC 请求日志脱敏（不记 path/name 原文）。

**Files:**
- Create: `apps/desktop/src/main/attachments/upload-service.ts`
- Test: `apps/desktop/tests/unit/attachment-validate.spec.ts`（validateFiles）、`apps/desktop/tests/unit/upload-service.spec.ts`（uploadBatch/cancel）

**Interfaces:**
- Consumes（Task 2/5/6）：`UploadFileDescriptor`、`FileValidationResult`、`AttachmentInfo`、`BackendAdapter.uploadAttachments`、`attachment-policy` 纯函数、`SafeOpenPlatform`
- Produces（Task 10/17 消费）：
  - `export interface UploadFs { realpath(p: string): Promise<string>; stat(p: string): Promise<{ size: number; isFile(): boolean }>; readFile(p: string): Promise<Uint8Array>; open(p: string, flags: number): Promise<{ close(): Promise<void>; stat(): Promise<{ size: number; isFile(): boolean }>; read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }> }> }`
  - `export interface UploadServiceDeps { backend: Pick<BackendAdapter, 'uploadAttachments'>; userDataBase: () => string; platform: SafeOpenPlatform; fs?: UploadFs }`
  - `export class UploadService { validateFiles(descriptors: UploadFileDescriptor[]): Promise<FileValidationResult[]>; uploadBatch(uploadId: string, descriptors: UploadFileDescriptor[]): Promise<MessageAttachment[]>; cancel(uploadId: string): void; dispose(): void }`

- [ ] **Step 1: 写失败测试（validateFiles）** —— `apps/desktop/tests/unit/attachment-validate.spec.ts`

```typescript
// tests/unit/attachment-validate.spec.ts
// Task 7:UploadService.validateFiles——数量/聚合/单文件限额、kind 矩阵、魔数嗅探、敏感范围/非普通文件拒（spec §2/§4.5）。
// env=node：注入假 UploadFs + posixPlatform，无真实 fs。
import { describe, expect, it } from 'vitest'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
import type { UploadFileDescriptor } from '@shared/contracts'

function fakeFs(over: Partial<UploadFs> = {}): UploadFs {
  return {
    realpath: async (p: string) => p,
    stat: async () => ({ size: 10, isFile: () => true }),
    readFile: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),  // PNG 头
    open: async () => ({
      close: async () => {},
      stat: async () => ({ size: 10, isFile: () => true }),
      read: async (b, _off, len) => { b.set([0x89, 0x50, 0x4e, 0x47]); return { bytesRead: Math.min(len, 4) } }
    }),
    ...over
  }
}

const desc = (p: Partial<UploadFileDescriptor>): UploadFileDescriptor => ({ localId: 'l1', name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', ...p })

function svc(fs: UploadFs = fakeFs(), userDataBase = '/home/u/.cyrene'): UploadService {
  return new UploadService({ backend: { uploadAttachments: async () => [] }, userDataBase: () => userDataBase, platform: posixPlatform, fs })
}

describe('UploadService.validateFiles', () => {
  it('数量 > 10 → 逐项 failed(too_many)', async () => {
    const files = Array.from({ length: 11 }, (_, i) => desc({ localId: `l${i}` }))
    const r = await svc().validateFiles(files)
    expect(r).toHaveLength(11)
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('too_many')
  })
  it('粘贴型（无 path，有 bytes）→ 魔数嗅探 kind + ok', async () => {
    const r = await svc().validateFiles([desc({ source: 'paste', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })])
    expect(r).toEqual([{ localId: 'l1', ok: true, kind: 'image' }])
  })
  it('路径型 → 打开失败（非普通文件）→ failed(not_readable)', async () => {
    const fs = fakeFs({ open: async () => { throw new Error('EISDIR') } })
    const r = await svc(fs).validateFiles([desc({ path: '/home/u/Documents' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('not_readable')
  })
  it('路径在 userData 敏感范围 → failed(forbidden_path)', async () => {
    const fs = fakeFs({ realpath: async () => '/home/u/.cyrene/credentials.json' })
    const r = await svc(fs).validateFiles([desc({ path: '/home/u/.cyrene/credentials.json' })])
    expect(r[0].ok).toBe(false)
    expect(r[0].reason).toBe('forbidden_path')
  })
  it('聚合超 64MB → failed(too_large_aggregate)', async () => {
    const big = 50 * 1024 * 1024
    const r = await svc().validateFiles([
      desc({ localId: 'a', size: big, mediaType: 'video/mp4', bytes: new Uint8Array(2) }),
      desc({ localId: 'b', size: big, mediaType: 'video/mp4', bytes: new Uint8Array(2) })
    ])
    expect(r.every((x) => !x.ok)).toBe(true)
    expect(r[0].reason).toBe('too_large_aggregate')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-validate.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现 `UploadService`（validateFiles 部分）** —— `apps/desktop/src/main/attachments/upload-service.ts`

```typescript
// src/main/attachments/upload-service.ts
// 阶段 3 G3（spec §4.4/§4.5/§4.8）：Main 附件校验链 + 批量上传 + 取消。
// 路径只在 Main 流转（D5）；上传 IPC 日志脱敏（不记 path/name 原文，spec §4.5/§4.8）。
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { FileValidationResult, MessageAttachment, UploadFileDescriptor } from '@shared/contracts'
import type { AttachmentInfo, AttachmentKind } from '@shared/contracts'
import type { BackendAdapter } from '../transport/backend-adapter'
import type { SafeOpenPlatform } from '../persistence/safe-open'
import { kindFromMime, precheckFiles, sniffKind, sizeLimitFor } from './attachment-policy'

export interface UploadFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ size: number; isFile(): boolean }>
  readFile(p: string): Promise<Uint8Array>
  open(p: string, flags: number): Promise<{ close(): Promise<void>; stat(): Promise<{ size: number; isFile(): boolean }>; read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }> }>
}

export interface UploadServiceDeps {
  backend: Pick<BackendAdapter, 'uploadAttachments'>
  userDataBase: () => string
  platform: SafeOpenPlatform
  fs?: UploadFs
}

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const HEAD_LEN = 16

function isInside(root: string, p: string): boolean {
  const rel = p.startsWith(root) ? p.slice(root.length) : p
  return p === root || p.startsWith(root + '/') || (process.platform === 'win32' && p.toLowerCase().startsWith(root.toLowerCase() + '\\'))
}

function toDomainAttachment(a: AttachmentInfo, messageId?: string): MessageAttachment {
  const kind = (['image', 'video', 'audio', 'file'].includes(a.kind) ? a.kind : 'file') as AttachmentKind
  const out: MessageAttachment = { attachmentId: a.attachmentId, kind, mediaType: a.mime, ...(a.filename ? { name: a.filename } : {}), ...(a.size !== undefined ? { size: a.size } : {}) }
  if (messageId) out.messageId = messageId
  return out
}

export class UploadService {
  private readonly fs: UploadFs
  private readonly platform: SafeOpenPlatform
  private readonly backend: UploadServiceDeps['backend']
  private readonly userDataBase: () => string
  private readonly active = new Map<string, AbortController>()

  constructor(deps: UploadServiceDeps) {
    this.backend = deps.backend
    this.userDataBase = deps.userDataBase
    this.platform = deps.platform
    this.fs = deps.fs ?? realFs()
  }

  async validateFiles(descriptors: UploadFileDescriptor[]): Promise<FileValidationResult[]> {
    const pre = precheckFiles(descriptors.map((d) => ({ name: d.name, size: d.size, mediaType: d.mediaType })))
    const results: FileValidationResult[] = []
    for (const d of descriptors) {
      if (!pre.ok) {
        const issue = pre.issues.find((i) => i.reason !== 'too_large_aggregate' && i.reason !== 'too_many' ? i.name === d.name : true)
        results.push({ localId: d.localId, ok: false, reason: issue?.reason ?? 'invalid' })
        continue
      }
      if (d.path) {
        try {
          const real = await this.fs.realpath(d.path)
          if (isInside(this.userDataBase(), real)) {
            results.push({ localId: d.localId, ok: false, reason: 'forbidden_path', message: '拒绝上传应用数据目录内的文件' })
            continue
          }
          const fd = await this.fs.open(d.path, this.platform.existingReadFlags)
          let st
          try { st = await fd.stat() } finally { await fd.close() }
          if (!st.isFile()) {
            results.push({ localId: d.localId, ok: false, reason: 'not_readable', message: '不是普通文件（目录/管道/设备）' })
            continue
          }
          const head = new Uint8Array(HEAD_LEN)
          const hfd = await this.fs.open(d.path, this.platform.existingReadFlags)
          let bytesRead = 0
          try { bytesRead = (await hfd.read(head, 0, HEAD_LEN)).bytesRead } finally { await hfd.close() }
          const kind = sniffKind(head.subarray(0, bytesRead))
          const fsStat = await this.fs.stat(d.path)
          if (fsStat.size > sizeLimitFor(kind)) {
            results.push({ localId: d.localId, ok: false, reason: 'size_limit', message: '超过该类型大小上限' })
            continue
          }
          results.push({ localId: d.localId, ok: true, kind })
        } catch {
          results.push({ localId: d.localId, ok: false, reason: 'not_readable', message: '无法读取文件' })
        }
      } else if (d.bytes) {
        results.push({ localId: d.localId, ok: true, kind: sniffKind(d.bytes.subarray(0, HEAD_LEN)) })
      } else {
        results.push({ localId: d.localId, ok: false, reason: 'invalid', message: '缺少 bytes/path' })
      }
    }
    return results
  }
```

（`realFs` 用 `fs/promises` 的 `realpath/stat/readFile/open` 实现 `UploadFs`；`existingReadFlags` 复用 safe-open 平台常量——posix 含 `O_NOFOLLOW|O_NONBLOCK`。）

- [ ] **Step 4: 追加 uploadBatch/cancel 实现与测试**

`upload-service.ts` 追加：

```typescript
  async uploadBatch(uploadId: string, descriptors: UploadFileDescriptor[]): Promise<MessageAttachment[]> {
    const controller = new AbortController()
    this.active.set(uploadId, controller)
    try {
      const uploads = []
      for (const d of descriptors) {
        if (d.path) {
          // 上传前 fs.stat 复验：实际大小与普通文件（防 Renderer 伪造描述符/队列状态漂移，spec §4.5）
          const st = await this.fs.stat(d.path)
          if (!st.isFile()) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件不是普通文件: ${d.localId}`)
          const kind = kindFromMime(d.mediaType)
          if (st.size > sizeLimitFor(kind)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件超过大小上限: ${d.localId}`)
          uploads.push({ name: d.name, mediaType: d.mediaType, size: st.size, kind: d.kind, path: d.path, bytes: new Uint8Array(await this.fs.readFile(d.path)) })
        } else if (d.bytes) {
          uploads.push({ name: d.name, mediaType: d.mediaType, size: d.size, kind: d.kind, bytes: d.bytes })
        } else {
          throw new CyreneError(CyreneErrorCode.INVALID_INPUT, `附件缺少 bytes/path: ${d.localId}`)
        }
      }
      // P1-1：把 active controller 的 signal 传给 backend——cancel(uploadId) abort 后，RealBackend 经
      // AbortSignal.any 组合信号令 fetch 终止并以 cancelled 错误 reject（IPC 层 → 条目 cancelled，spec §4.1 D10/§5 验收#4）
      const infos = await this.backend.uploadAttachments(uploads, { signal: controller.signal })   // batch 原子（全成或全不成）
      return infos.map((a) => toDomainAttachment(a))
    } finally {
      this.active.delete(uploadId)
    }
  }

  cancel(uploadId: string): void {
    const c = this.active.get(uploadId)
    if (c) c.abort()
  }

  dispose(): void {
    for (const c of this.active.values()) c.abort()
    this.active.clear()
  }
}
```

`apps/desktop/tests/unit/upload-service.spec.ts`：

```typescript
// tests/unit/upload-service.spec.ts
// Task 7:UploadService.uploadBatch/cancel——fs.stat 复验、batch 原子、AbortController 取消（spec §4.5/§4.8/§5）。
import { describe, expect, it, vi } from 'vitest'
import { posixPlatform } from '../../src/main/persistence/safe-open'
import { UploadService, type UploadFs } from '../../src/main/attachments/upload-service'
import type { AttachmentInfo } from '@shared/contracts'

function fakeFs(): UploadFs {
  return {
    realpath: async (p: string) => p,
    stat: async () => ({ size: 4, isFile: () => true }),
    readFile: async () => new Uint8Array([1, 2, 3, 4]),
    open: async () => ({ close: async () => {}, stat: async () => ({ size: 4, isFile: () => true }), read: async (b, _o, len) => { b.set([1, 2, 3]); return { bytesRead: Math.min(len, 3) } } })
  }
}

describe('UploadService.uploadBatch / cancel', () => {
  it('成功批量 → MessageAttachment[]（AttachmentInfo.kind 权威）', async () => {
    const uploadAttachments = vi.fn(async (): Promise<AttachmentInfo[]> => [
      { attachmentId: 'att_1', kind: 'image', mime: 'image/png', size: 4, url: '/api/attachments/att_1', filename: 'a.png' }
    ])
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    const out = await svc.uploadBatch('u1', [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'picker', kind: 'image', bytes: new Uint8Array([1, 2, 3, 4]) }])
    expect(out).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png', size: 4 }])
    expect(uploadAttachments).toHaveBeenCalledTimes(1)
  })
  it('batch 失败 → 整体 reject（原子，不部分成功）', async () => {
    const uploadAttachments = vi.fn(async () => { throw new Error('upload failed') })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    await expect(svc.uploadBatch('u1', [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'paste', bytes: new Uint8Array(1) }])).rejects.toThrow('upload failed')
  })
  it('cancel 中止在途上传（controller.signal 已接入 backend → abort 触发 reject，取消闭环，P1-1）', async () => {
    const uploadAttachments = vi.fn(async (_files: unknown, opts?: { signal?: AbortSignal }): Promise<AttachmentInfo[]> => {
      // 等价于真实 backend：经 AbortSignal.any 组合信号，abort 事件触发上传 reject（不再「尚不可见」，P1-1）
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener('abort', () => rej(new Error('cancelled')))
      })
    })
    const svc = new UploadService({ backend: { uploadAttachments }, userDataBase: () => '/ud', platform: posixPlatform, fs: fakeFs() })
    const p = svc.uploadBatch('u1', [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'paste', bytes: new Uint8Array(1) }])
    await vi.waitFor(() => expect(uploadAttachments).toHaveBeenCalledTimes(1))   // 已进入 in-flight（bytes 型不经 fs）
    svc.cancel('u1')                                                              // 批量终止（IPC attachments:cancel 同路径）
    await expect(p).rejects.toThrow('cancelled')                                  // uploadBatch reject → IPC 层 → 条目 cancelled
  })
})
```

> **P1-1**：取消闭环本任务已闭环——`cancel(uploadId)` abort active controller 的 signal → backend.uploadAttachments 经传入 signal 终止并 reject（上方测试覆盖 in-flight abort→reject）；IPC `attachmentsCancel` 经 `UploadService.cancel` 走同一路径，store 层条目转 cancelled（Task 14 测试覆盖）。不再引用任何「Task 18」（本 plan 无此任务）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-validate.spec.ts tests/unit/upload-service.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/attachments/upload-service.ts apps/desktop/tests/unit/attachment-validate.spec.ts apps/desktop/tests/unit/upload-service.spec.ts
git commit -m "feat(G3 attachment): UploadService 校验链 + 批量上传 + 取消（spec §4.5/§4.8）"
```

---

### Task 8: `MediaService` —— 签名缓存/重签 + 流式代理 + checkStatus + sticker 静态代理（D1/D6）

> `resolveSignedUrl`（缓存 `{url, expiresAt}`，到期前 5min 重签）；`stream(mediaType, id, request)`（attachment：格式校验 + Range/Accept 透传 + 401/403 重签一次重试、仍失败返 410、404 返 404；sticker：stickerId 白名单 `^st_[A-Za-z0-9-]+$` + MIME 白名单 image/png + 静态代理无签名/无缓存签名）；`checkStatus(attachmentId)`（重签后 Range-0 探测分类 ok/expired/not_found/revoked/error）；`isDocumentRequest` 拒 `Sec-Fetch-Dest: document`；日志脱敏（只记 mediaType+id+status）。

**Files:**
- Create: `apps/desktop/src/main/attachments/media-service.ts`
- Test: `apps/desktop/tests/unit/media-service.spec.ts`

**Interfaces:**
- Consumes（Task 2/5）：`AttachmentSignResult`、`BackendAdapter.signAttachmentUrl`、`AttachmentCheckResult`
- Produces（Task 9/10/17 消费）：
  - `export type MediaRouteType = 'attachment' | 'sticker'`；`export const MEDIA_PATH_PREFIX = '/__cyrene-media/'`
  - `export function parseMediaPath(pathname: string): { mediaType: MediaRouteType; id: string } | null`
  - `export function isDocumentRequest(request: Request): boolean`
  - `export class MediaService { constructor(deps: { backend: Pick<BackendAdapter, 'signAttachmentUrl'>; baseUrl: () => string | undefined; now?: () => number; fetchImpl?: typeof fetch }); resolveSignedUrl(attachmentId: string, opts?: { force?: boolean }): Promise<{ url: string; expiresAt: number }>; stream(mediaType: MediaRouteType, id: string, request: Request): Promise<Response>; checkStatus(attachmentId: string): Promise<AttachmentCheckResult> }`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/media-service.spec.ts`

```typescript
// tests/unit/media-service.spec.ts
// Task 8:MediaService（spec D1/D6，§4.4/§4.5）——签名缓存/过期重签、Range/206 透传、401/403 重签重试、410 映射、
// checkStatus 分类、attachmentId/stickerId 白名单、Sec-Fetch-Dest 拒绝、sticker 静态代理无签名。env=node。
import { describe, expect, it, vi } from 'vitest'
import { isDocumentRequest, MediaService, parseMediaPath } from '../../src/main/attachments/media-service'

const now = () => 1_752_000_000_000   // 固定时钟（2026-07 起）
const NEW_FETCH = { fetchImpl: undefined as undefined, fetch: globalThis.fetch.bind(globalThis) }

function mkService(opts: {
  sign?: (id: string) => Promise<{ url: string; expiresAt: string }>
  fetchImpl?: typeof fetch
  baseUrl?: () => string | undefined
} = {}): MediaService {
  return new MediaService({
    backend: { signAttachmentUrl: opts.sign ?? (async (id) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: new Date(now() + 60 * 60 * 1000).toISOString() })) },
    baseUrl: opts.baseUrl ?? (() => 'http://127.0.0.1:9'),
    now,
    fetchImpl: opts.fetchImpl
  })
}

describe('parseMediaPath / isDocumentRequest', () => {
  it('解析 /__cyrene-media/{mediaType}/{id}', () => {
    expect(parseMediaPath('/__cyrene-media/attachment/att_1')).toEqual({ mediaType: 'attachment', id: 'att_1' })
    expect(parseMediaPath('/__cyrene-media/sticker/st_1')).toEqual({ mediaType: 'sticker', id: 'st_1' })
  })
  it('非媒体路径/缺段/未知 mediaType → null', () => {
    expect(parseMediaPath('/index.html')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/bogus/att_1')).toBeNull()
    expect(parseMediaPath('/__cyrene-media/attachment/att_1/x')).toBeNull()
  })
  it('Sec-Fetch-Dest: document → 拒绝（防媒体字节作顶层文档，spec §4.9）', () => {
    expect(isDocumentRequest(new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'document' } }))).toBe(true)
    expect(isDocumentRequest(new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).toBe(false)
  })
})

describe('MediaService.resolveSignedUrl（缓存/重签）', () => {
  it('首次签发入缓存；5min 内命中不重签', async () => {
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=s`, expiresAt: new Date(now() + 60 * 60 * 1000).toISOString() }))
    const svc = mkService({ sign })
    const a = await svc.resolveSignedUrl('att_1')
    const b = await svc.resolveSignedUrl('att_1')
    expect(a.url).toBe(b.url)
    expect(sign).toHaveBeenCalledTimes(1)
  })
  it('到期前 5min 内视为过期 → 重签（force 或自然过期）', async () => {
    let count = 0
    const sign = vi.fn(async (id: string) => ({ url: `https://cdn.x/${id}?sig=${++count}`, expiresAt: new Date(now() + 4 * 60 * 1000).toISOString() }))  // 距过期 <5min
    const svc = mkService({ sign })
    await svc.resolveSignedUrl('att_1')
    await svc.resolveSignedUrl('att_1')
    expect(sign).toHaveBeenCalledTimes(2)
  })
})

describe('MediaService.stream attachment 分支', () => {
  it('Range 请求 → 透传 Range/Accept，后端 206 直通', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://cdn.x/att_1?sig=s')
      expect(init?.headers).toMatchObject({ range: 'bytes=0-1023' })
      return new Response(new Uint8Array(64), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-63/1024', 'accept-ranges': 'bytes' } })
    })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { range: 'bytes=0-1023', 'sec-fetch-dest': 'video' } }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-63/1024')
  })
  it('后端 403 → 重签一次重试 → 仍 403 → 410（Gone）', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => { calls++; return new Response('denied', { status: calls === 1 ? 403 : 403 }) })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)   // 初次 + 重签重试
    expect(res.status).toBe(410)
  })
  it('attachmentId 格式不符 → 403（白名单）', async () => {
    const svc = mkService()
    const res = await svc.stream('attachment', 'evil', new Request('cyrene://renderer/__cyrene-media/attachment/evil', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(403)
  })
  it('Sec-Fetch-Dest: document → 403', async () => {
    const svc = mkService()
    const res = await svc.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'document' } }))
    expect(res.status).toBe(403)
  })
  it('后端网络失败/5xx → 502（transient，非 404，避免占位误标 not_found，P2-4）', async () => {
    const svcNet = mkService({ fetchImpl: async () => { throw new Error('net down') } })
    expect((await svcNet.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(502)
    const svc5xx = mkService({ fetchImpl: async () => new Response('boom', { status: 500 }) })
    expect((await svc5xx.stream('attachment', 'att_1', new Request('cyrene://renderer/__cyrene-media/attachment/att_1', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(502)
  })
})

describe('MediaService.stream sticker 分支（G4 边界，spec §4.4/§2）', () => {
  it('stickerId 白名单 + MIME 白名单 + 静态代理（无签名）', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:9/static/stickers/st_1.png')
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const svc = mkService({ fetchImpl })
    const res = await svc.stream('sticker', 'st_1', new Request('cyrene://renderer/__cyrene-media/sticker/st_1', { headers: { 'sec-fetch-dest': 'img' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
  })
  it('stickerId 非法（非 ^st_[A-Za-z0-9-]+$）→ 403', async () => {
    const svc = mkService()
    expect((await svc.stream('sticker', '../st_1', new Request('cyrene://renderer/__cyrene-media/sticker/x', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(403)
    expect((await svc.stream('sticker', 'ST_1', new Request('cyrene://renderer/__cyrene-media/sticker/x', { headers: { 'sec-fetch-dest': 'img' } }))).status).toBe(403)
  })
})

describe('MediaService.checkStatus（D6 分类）', () => {
  it('Range-0 探测 200/206 → ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    const svc = mkService({ fetchImpl })
    expect((await svc.checkStatus('att_1')).status).toBe('ok')
  })
  it('404 → not_found；403（重签后仍）→ expired；其他 → error', async () => {
    const svc404 = mkService({ fetchImpl: async () => new Response('', { status: 404 }) })
    expect((await svc404.checkStatus('att_1')).status).toBe('not_found')
    const svc403 = mkService({ fetchImpl: async () => new Response('', { status: 403 }) })
    expect((await svc403.checkStatus('att_1')).status).toBe('expired')
    const svcErr = mkService({ fetchImpl: async () => { throw new Error('net') } })
    expect((await svcErr.checkStatus('att_1')).status).toBe('error')
  })
  it('签发表失败 → error（reason sign_failed）；格式非法 → error', async () => {
    const svc = mkService({ sign: async () => { throw new Error('boom') } })
    expect((await svc.checkStatus('att_1')).status).toBe('error')
    const svcBad = mkService()
    expect((await svcBad.checkStatus('evil')).status).toBe('error')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/attachments/media-service.ts`

```typescript
// src/main/attachments/media-service.ts
// 阶段 3 G3（spec D1/D6，§4.4/§4.5）：通用媒体代理——签名 URL 持有/缓存/过期重签（attachment 流式代理）、
// sticker 静态白名单代理（G4 复用）、checkStatus 分类。签名 URL 不落 Renderer；日志脱敏（只记 mediaType+id+status）。
import type { AttachmentCheckResult, AttachmentSignResult } from '@shared/contracts'
import type { BackendAdapter } from '../transport/backend-adapter'

export type MediaRouteType = 'attachment' | 'sticker'
export const MEDIA_PATH_PREFIX = '/__cyrene-media/'

const ATTACHMENT_ID_PATTERN = /^att_[A-Za-z0-9_-]+$/
const STICKER_ID_PATTERN = /^st_[A-Za-z0-9-]+$/
const STICKER_MIME = 'image/png'
const RE_SIGN_LEEWAY_MS = 5 * 60 * 1000

/** 解析协议路径 /__cyrene-media/{mediaType}/{id}；非法/未知 → null（spec §4.4） */
export function parseMediaPath(pathname: string): { mediaType: MediaRouteType; id: string } | null {
  if (!pathname.startsWith(MEDIA_PATH_PREFIX)) return null
  const rest = pathname.slice(MEDIA_PATH_PREFIX.length)
  const segs = rest.split('/')
  if (segs.length !== 2 || segs.some((s) => s.length === 0)) return null
  const [mt, id] = segs as [string, string]
  if (mt !== 'attachment' && mt !== 'sticker') return null
  return { mediaType: mt, id }
}

/** 拒绝媒体字节作顶层文档（spec §4.9 双保险之一） */
export function isDocumentRequest(request: Request): boolean {
  return request.headers.get('sec-fetch-dest') === 'document'
}

export interface ResolvedSignedUrl { url: string; expiresAt: number }

export class MediaService {
  private readonly cache = new Map<string, ResolvedSignedUrl>()
  private readonly backend: Pick<BackendAdapter, 'signAttachmentUrl'>
  private readonly baseUrl: () => string | undefined
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch

  constructor(deps: { backend: Pick<BackendAdapter, 'signAttachmentUrl'>; baseUrl: () => string | undefined; now?: () => number; fetchImpl?: typeof fetch }) {
    this.backend = deps.backend
    this.baseUrl = deps.baseUrl
    this.now = deps.now ?? Date.now
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  /** 签名缓存：exp−5min 视为过期经 /sign 重签（D6） */
  async resolveSignedUrl(attachmentId: string, opts: { force?: boolean } = {}): Promise<ResolvedSignedUrl> {
    const cached = this.cache.get(attachmentId)
    if (!opts.force && cached && cached.expiresAt - this.now() > RE_SIGN_LEEWAY_MS) return cached
    const sign: AttachmentSignResult = await this.backend.signAttachmentUrl(attachmentId)
    const entry: ResolvedSignedUrl = { url: sign.url, expiresAt: Date.parse(sign.expiresAt) }
    this.cache.set(attachmentId, entry)
    return entry
  }

  async stream(mediaType: MediaRouteType, id: string, request: Request): Promise<Response> {
    if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
    if (mediaType === 'sticker') return this.streamSticker(id)
    return this.streamAttachment(id, request)
  }

  private async proxyFetch(signedUrl: string, request: Request, headers: Record<string, string>): Promise<Response> {
    try {
      const res = await this.fetchImpl(signedUrl, { headers, signal: request.signal })
      const out = new Headers()
      const ct = res.headers.get('content-type')
      if (ct) out.set('Content-Type', ct)
      const cr = res.headers.get('content-range')
      if (cr) out.set('Content-Range', cr)
      const ar = res.headers.get('accept-ranges')
      if (ar) out.set('Accept-Ranges', ar)
      if (res.status >= 500) return new Response('Bad Gateway', { status: 502 })   // P2-4：5xx 上游视为 transient（加载失败），不当作 not_found
      return new Response(res.body, { status: res.status, headers: out })
    } catch {
      // P2-4：网络失败（DNS/连接/超时）→ 502 transient，区别于 404 not_found——避免占位误标「附件不存在」
      return new Response('Bad Gateway', { status: 502 })
    }
  }

  private async streamAttachment(attachmentId: string, request: Request): Promise<Response> {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return new Response('Forbidden', { status: 403 })
    const headers: Record<string, string> = {}
    const range = request.headers.get('range')
    if (range) headers['range'] = range
    const accept = request.headers.get('accept')
    if (accept) headers['accept'] = accept
    let signed = await this.resolveSignedUrl(attachmentId)
    let res = await this.proxyFetch(signed.url, request, headers)
    if (res.status === 401 || res.status === 403) {
      // 签名过期：重签一次重试（spec §4.8）
      signed = await this.resolveSignedUrl(attachmentId, { force: true })
      res = await this.proxyFetch(signed.url, request, headers)
    }
    if (res.status === 401 || res.status === 403) return new Response('Gone', { status: 410 })
    return res
  }

  /** sticker 静态代理：stickerId 白名单 + MIME 白名单 image/png + 无签名/不缓存签名 URL（G4 边界，spec §2/§4.4） */
  private async streamSticker(stickerId: string): Promise<Response> {
    if (!STICKER_ID_PATTERN.test(stickerId)) return new Response('Forbidden', { status: 403 })
    const base = this.baseUrl()
    if (!base) return new Response('Not Found', { status: 404 })
    const url = `${base.replace(/\/$/, '')}/static/stickers/${encodeURIComponent(stickerId)}.png`
    try {
      const res = await this.fetchImpl(url)
      if (res.status !== 200 || (res.headers.get('content-type') ?? '').split(';')[0] !== STICKER_MIME) {
        return new Response('Unsupported Media Type', { status: 415 })
      }
      return new Response(res.body, { status: 200, headers: { 'Content-Type': STICKER_MIME, 'Cache-Control': 'public, max-age=86400' } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }

  /** 媒体状态分类：重签后 Range-0 探测后端（仅 attachment 分支使用；sticker 无签名/无过期不查） */
  async checkStatus(attachmentId: string): Promise<AttachmentCheckResult> {
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) return { status: 'error', reason: 'invalid_id' }
    let signed: ResolvedSignedUrl
    try {
      signed = await this.resolveSignedUrl(attachmentId, { force: true })
    } catch {
      return { status: 'error', reason: 'sign_failed' }
    }
    try {
      const res = await this.fetchImpl(signed.url, { headers: { range: 'bytes=0-0' } })
      if (res.status === 200 || res.status === 206) return { status: 'ok' }
      if (res.status === 404) return { status: 'not_found' }
      if (res.status === 401 || res.status === 403) return { status: 'expired' }
      return { status: 'error' }
    } catch {
      return { status: 'error', reason: 'probe_failed' }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/media-service.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（约 15 tests）+ typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/attachments/media-service.ts apps/desktop/tests/unit/media-service.spec.ts
git commit -m "feat(G3 attachment): MediaService 签名代理/重签/checkStatus + sticker 静态代理（D1/D6）"
```

---

### Task 9: 协议 handler 媒体分支 + CSP 最小增量 + 导航 deny（D1，spike 验证）

> `registerCyreneProtocolHandler` 改为 `{ rendererRoot?, resolveMedia? }`，**dev/prod 都注册**（spec 3.1 行：当前仅非 dev 注册）；回调内先判媒体分支（`parseMediaPath` + `isDocumentRequest` + resolveMedia），否则渲染根文件服务。CSP：prod `buildRendererCsp()` 增 `media-src 'self'`；dev `buildDevCsp()` 三处加 `cyrene:`（`media-src`、`img-src`）与 index.html meta 同步（G-9）；`classifyNavigation` 增 `__cyrene-media/*` 前缀 deny（防媒体字节作顶层文档，双保险）。**spike 验证**：`<img>/<video>` 经 cyrene:// 加载在 dev/prod 均可用。

**Files:**
- Modify: `apps/desktop/src/main/protocol/handler.ts`
- Modify: `apps/desktop/src/main/protocol/csp.ts`
- Modify: `apps/desktop/src/main/config/dev-csp.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Modify: `apps/desktop/src/main/windows/navigation.ts`
- Test: `apps/desktop/tests/unit/protocol-csp.spec.ts`、`apps/desktop/tests/unit/dev-csp.spec.ts`、`apps/desktop/tests/unit/navigation.spec.ts`（各追加）

**Interfaces:**
- Consumes（Task 8）：`parseMediaPath`、`isDocumentRequest`、`MediaRouteType`、`MEDIA_PATH_PREFIX`
- Produces（Task 17 消费）：
  - `export type MediaResolver = (mediaType: MediaRouteType, id: string, request: Request) => Promise<Response>`
  - `export interface CyreneProtocolOptions { rendererRoot?: string; resolveMedia?: MediaResolver }`
  - `export async function registerCyreneProtocolHandler(opts: CyreneProtocolOptions): Promise<void>`
  - prod CSP 含 `media-src 'self'`；dev CSP 含 `media-src 'self' cyrene:` 与 `img-src ... cyrene:`
  - `classifyNavigation('cyrene://renderer/__cyrene-media/...') === 'deny'`

- [ ] **Step 1: 写失败测试** —— 追加到三个 spec 文件

`apps/desktop/tests/unit/protocol-csp.spec.ts` 追加：

```typescript
  it('prod 含 media-src self（视频/音频经同源 cyrene:// 放行，spec D1）', () => {
    expect(csp).toContain("media-src 'self'")
  })
  it('prod img-src 不含裸 host / 不加任意 host（同源 'self' 即放行）', () => {
    expect(csp).not.toContain('cyrene:')
    expect(csp).not.toContain('http://')
  })
```

`apps/desktop/tests/unit/dev-csp.spec.ts` 追加：

```typescript
  it('dev 三处加 cyrene:（media-src + img-src；connect-src 不动）', () => {
    const csp = buildDevCsp(resolveTrustedDevOrigins({}))
    expect(csp).toContain("media-src 'self' cyrene:")
    expect(csp).toContain("img-src 'self' data: blob: cyrene:")
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).not.toContain('cyrene:')
  })
```

`apps/desktop/tests/unit/navigation.spec.ts` 追加：

```typescript
  it('非 dev server：cyrene://renderer/__cyrene-media/* 前缀 deny（防媒体字节作顶层文档，spec §4.4/§4.9）', () => {
    expect(classifyNavigation('cyrene://renderer/__cyrene-media/attachment/att_1', undefined, false)).toBe('deny')
    expect(classifyNavigation('cyrene://renderer/__cyrene-media/sticker/st_1', undefined, false)).toBe('deny')
    expect(classifyNavigation('cyrene://renderer/index.html', undefined, false)).toBe('app')  // 普通渲染根文件仍 app
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/protocol-csp.spec.ts tests/unit/dev-csp.spec.ts tests/unit/navigation.spec.ts`
Expected: FAIL——`media-src` 缺失 / dev 无 `cyrene:` / media 前缀被判 `app`。

- [ ] **Step 3: 实现 CSP 三文件 + navigation**

`apps/desktop/src/main/protocol/csp.ts`：在 `img-src` 后插入 `"media-src 'self'"`。

`apps/desktop/src/main/config/dev-csp.ts`：
- `"img-src 'self' data: blob: cyrene:",`（cyrene: 追加）
- 在 `img-src` 后插入 `"media-src 'self' cyrene:",`

`apps/desktop/src/renderer/index.html` meta CSP（`img-src`/`media-src` 同步，connect-src 不动）：

```
content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: cyrene:; media-src 'self' cyrene:; font-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'"
```

`apps/desktop/src/main/windows/navigation.ts`：`cyrene:` 分支改为：

```typescript
    if (!usingDevServer && url.protocol === 'cyrene:' && url.host === RENDERER_HOST) {
      // G3：媒体字节禁止作顶层文档——__cyrene-media/* 前缀 deny（attachment/sticker 均 deny，双保险之一，spec §4.9）
      if (url.pathname.startsWith('/__cyrene-media/')) return 'deny'
      return 'app' // 路径包含性已由 protocol handler 强制（handler 对越界 403）
    }
```

- [ ] **Step 4: 实现 handler 媒体分支**

`apps/desktop/src/main/protocol/handler.ts` 整体替换为：

```typescript
// apps/desktop/src/main/protocol/handler.ts
import { net, protocol } from 'electron'
import { realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { PROTOCOL_SCHEME, RENDERER_HOST } from './scheme'
import { resolveRendererPath } from './path'
import { buildRendererCsp } from './csp'
import { mimeOf } from './mime'
import { isDocumentRequest, MEDIA_PATH_PREFIX, parseMediaPath, type MediaRouteType } from '../attachments/media-service'

const RENDERER_CSP = buildRendererCsp()

export type MediaResolver = (mediaType: MediaRouteType, id: string, request: Request) => Promise<Response>

export interface CyreneProtocolOptions {
  /** 渲染根（缺省时非媒体一律 404；media 分支不依赖 rendererRoot） */
  rendererRoot?: string
  /** 媒体分支分派器（Main 注入 MediaService.stream；缺省时媒体路径 404） */
  resolveMedia?: MediaResolver
}

export async function registerCyreneProtocolHandler(opts: CyreneProtocolOptions): Promise<void> {
  const { rendererRoot, resolveMedia } = opts
  let realRoot: string | undefined
  let rootLower = ''
  let rootPrefix = ''
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  if (rendererRoot) {
    // P1-5：realpath 失败（如 dev 下 out/renderer 未构建）→ 置 realRoot=undefined，非媒体一律 404，不向上抛错阻断 main()
    try {
      realRoot = await realpath(rendererRoot)
      rootLower = lower(realRoot)
      rootPrefix = rootLower + sep
    } catch {
      realRoot = undefined
    }
  }
  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (url.host !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
    // G3：媒体分支（spec D1）——/__cyrene-media/{mediaType}/{id}；mediaType 白名单 + id 格式 + Sec-Fetch-Dest 由 MediaService 执行
    if (url.pathname.startsWith(MEDIA_PATH_PREFIX)) {
      const parsed = parseMediaPath(url.pathname)
      if (!parsed) return new Response('Forbidden', { status: 403 })
      if (!resolveMedia) return new Response('Not Found', { status: 404 })
      if (isDocumentRequest(request)) return new Response('Forbidden', { status: 403 })
      return resolveMedia(parsed.mediaType, parsed.id, request)
    }
    if (!realRoot) return new Response('Not Found', { status: 404 })
    const candidate = resolveRendererPath(realRoot, url.pathname)
    if (!candidate) return new Response('Forbidden', { status: 403 })
    let realCand: string
    try {
      realCand = await realpath(candidate)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    const inside = lower(realCand) === rootLower || lower(realCand).startsWith(rootPrefix)
    if (!inside) return new Response('Forbidden', { status: 403 })
    let target = realCand
    const st = await stat(target).catch(() => null)
    if (st && st.isDirectory()) {
      const idxPath = join(realCand, 'index.html')
      let realIdx: string | null
      try {
        realIdx = await realpath(idxPath)
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      if (!(lower(realIdx) === rootLower || lower(realIdx).startsWith(rootPrefix))) {
        return new Response('Forbidden', { status: 403 })
      }
      target = realIdx
    }
    try {
      const res = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(res.headers)
      const mime = mimeOf(target)
      if (mime) headers.set('Content-Type', mime)
      headers.set('Content-Security-Policy', RENDERER_CSP)
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
```

> 注意：`resolveRendererPath` 入参改为 `realRoot`（realpath 后），与既有语义一致（原入参即 realpath 结果）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/protocol-csp.spec.ts tests/unit/dev-csp.spec.ts tests/unit/navigation.spec.ts tests/unit/media-service.spec.ts && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 6: spike 验证（spec §3.2）——dev 与 prod 媒体栈实测**

1. `xvfb-run -a pnpm -F @cyrene/desktop dev`（dev 页面在 Vite http），用 Playwright MCP `browser_navigate` 打开后 `browser_evaluate`：
   ```js
   () => {
     const img = new Image()
     img.src = 'cyrene://renderer/__cyrene-media/sticker/st_demo.png'
     return new Promise((resolve) => {
       img.onload = () => resolve({ ok: true })
       img.onerror = () => resolve({ ok: false })
       setTimeout(() => resolve({ ok: false, timeout: true }), 3000)
     })
   }
   ```
   预期 `ok: true` 需后端 `/static/stickers/st_demo.png` 可达；无后端时预期 `ok: false` 但**不抛 CSP 报错**（console 无 `Refused to load the image ... because it violates CSP`）。`browser_console_messages` 检查无 CSP violation。
2. `pnpm -F @cyrene/desktop package && pnpm -F @cyrene/desktop verify:artifact --smoke`（prod 同源 `media-src 'self'` 路径），冒烟不回归。
3. 结果记录到 `docs/review/2026-08-14-G3-media-spike.md`（spike 只验证媒体栈可用性；真实附件签名链路待联调）。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/protocol/handler.ts apps/desktop/src/main/protocol/csp.ts apps/desktop/src/main/config/dev-csp.ts apps/desktop/src/renderer/index.html apps/desktop/src/main/windows/navigation.ts apps/desktop/tests/unit/protocol-csp.spec.ts apps/desktop/tests/unit/dev-csp.spec.ts apps/desktop/tests/unit/navigation.spec.ts docs/review/2026-08-14-G3-media-spike.md
git commit -m "feat(G3 attachment): 协议 handler 媒体分支 + CSP 最小增量 + 导航 deny（D1/spike）"
```

---

### Task 10: attachments IPC handlers + 装配（Main）

**Files:**
- Create: `apps/desktop/src/main/attachments/attachments-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`、`apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/unit/attachments-handlers.spec.ts`

**Interfaces:**
- Consumes（Task 3/7/8）：四 request schema、响应 schema、`UploadService`、`MediaService`、`createIpcHandler`、`registerHandler`
- Produces（Task 17 消费）：`registerAttachmentsHandlers(deps: { svc: UploadService; media: MediaService; sanitize: MessageSanitizer; logger: Logger }): void`；`registerCyreneProtocolHandler` 在 dev 也注册

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/attachments-handlers.spec.ts`

```typescript
// tests/unit/attachments-handlers.spec.ts
// Task 10:attachments 四通道 handler 接线——request 校验、响应 schema、结构化错误（沿用 createIpcHandler 模式）。
// env=node：直接调用注册的 handler 函数（不经 ipcMain）。
import { describe, expect, it, vi } from 'vitest'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { attachmentsCheckSchema, attachmentsUploadSchema, attachmentsValidateSchema } from '../../src/main/ipc/channels'
import { AttachmentCheckResultSchema, AttachmentsUploadResponseSchema } from '../../src/shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

const sanitize: MessageSanitizer = (m) => m
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never

describe('attachments handler（createIpcHandler 接线）', () => {
  it('attachments:check 成功 → ok:true 带 AttachmentCheckResult', async () => {
    const h = createIpcHandler(attachmentsCheckSchema, AttachmentCheckResultSchema, async () => ({ status: 'ok' }), { sanitize, channel: 'attachments:check', logger })
    const res = await h({ attachmentId: 'att_1' })
    expect(res).toEqual({ ok: true, data: { status: 'ok' } })
  })
  it('attachments:upload 成功 → ok:true 带 AttachmentsUploadResponse', async () => {
    const h = createIpcHandler(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async () => ({ uploadId: 'u1', attachments: [] }), { sanitize, channel: 'attachments:upload', logger })
    const res = await h({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a', size: 1, mediaType: 'x', source: 'picker', path: '/tmp/a' }] })
    expect(res.ok).toBe(true)
  })
  it('request 非法 → ok:false SCHEMA_VALIDATION_FAILED', async () => {
    const h = createIpcHandler(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async () => ({ uploadId: 'u1', attachments: [] }), { sanitize, channel: 'attachments:upload', logger })
    const res = await h({ files: [] })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
  it('服务层 CyreneError → ok:false 结构化错误（code/message 公开白名单）', async () => {
    const h = createIpcHandler(attachmentsCheckSchema, AttachmentCheckResultSchema, async () => { throw new CyreneError(CyreneErrorCode.NOT_FOUND, '附件不存在') }, { sanitize, channel: 'attachments:check', logger })
    const res = await h({ attachmentId: 'att_missing' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toEqual({ code: 'NOT_FOUND', message: '附件不存在' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-handlers.spec.ts`
Expected: FAIL——`attachmentsCheckSchema` 等未实现时模块存在但引用失败（本任务先测 createIpcHandler 接线，模块引用在 Step 3 才建，故预期报 import 不存在）。

> 说明：本测试直接复用 `createIpcHandler` 验证接线形状；实际四通道注册函数在 `attachments-handlers.ts` 定义，Step 3 建文件后 import 通过。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/main/attachments/attachments-handlers.ts`

```typescript
// src/main/attachments/attachments-handlers.ts
// 阶段 3 G3（spec §4.5 IPC 注册）：attachments:validate/upload/cancel/check 四通道。
// 沿用 P0 校验/脱敏/审计模式（createIpcHandler）；上传取消经 UploadService.cancel（AbortController）。
import { z } from 'zod'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import { AttachmentCheckResultSchema, AttachmentsUploadResponseSchema, FileValidationResultSchema } from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { attachmentsCancelSchema, attachmentsCheckSchema, attachmentsUploadSchema, attachmentsValidateSchema } from '../ipc/channels'
import type { UploadService } from './upload-service'
import type { MediaService } from './media-service'

export function registerAttachmentsHandlers(deps: { svc: UploadService; media: MediaService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { svc, media, sanitize, logger } = deps
  const handle = <TReq, TRes>(
    requestSchema: z.ZodType<TReq>,
    responseSchema: z.ZodType<TRes>,
    fn: (req: TReq) => TRes | Promise<TRes>,
    channel: IpcChannelName
  ): ((raw: unknown) => Promise<IpcResult<TRes>>) =>
    createIpcHandler(requestSchema, responseSchema, fn, { sanitize, channel, logger })

  registerHandler(IpcChannels.attachmentsValidate, handle(attachmentsValidateSchema, z.array(FileValidationResultSchema), (req) => svc.validateFiles(req.files), IpcChannels.attachmentsValidate), 1)
  registerHandler(IpcChannels.attachmentsUpload, handle(attachmentsUploadSchema, AttachmentsUploadResponseSchema, async (req) => ({ uploadId: req.uploadId, attachments: await svc.uploadBatch(req.uploadId, req.files) }), IpcChannels.attachmentsUpload), 1)
  registerHandler(IpcChannels.attachmentsCancel, handle(attachmentsCancelSchema, z.undefined(), (req) => { svc.cancel(req.uploadId) }, IpcChannels.attachmentsCancel), 1)
  registerHandler(IpcChannels.attachmentsCheck, handle(attachmentsCheckSchema, AttachmentCheckResultSchema, (req) => media.checkStatus(req.attachmentId), IpcChannels.attachmentsCheck), 1)
}
```

`apps/desktop/src/main/ipc/handlers.ts`：`registerHandlers` 签名追加 `attachments: { svc: UploadService; media: MediaService }` 依赖，内部调 `registerAttachmentsHandlers({ svc: deps.attachments.svc, media: deps.attachments.media, sanitize, logger: deps.logger })`。

`apps/desktop/src/main/index.ts`：
1. import `MediaService`、`UploadService`、`registerCyreneProtocolHandler`（带 options）、`defaultSafeOpenPlatform`（`../persistence/safe-open`）。
2. adapter 构造后装配：

```typescript
    const attachmentsBackend = adapter
    const uploadSvc = new UploadService({
      backend: attachmentsBackend,
      userDataBase: expectedUserDataBase,
      platform: defaultSafeOpenPlatform()
    })
    const mediaSvc = new MediaService({
      backend: attachmentsBackend,
      baseUrl: () => connConfig.getEndpoint()?.baseUrl
    })
```

> 装配时序：`mediaSvc` 需引用 `connConfig.getEndpoint()`，故两服务装配放在 `connConfig` 创建之后、`registerHandlers(...)` 调用之前（当前 index.ts 中 connConfig 在 chatSvc 之前创建，registerHandlers 在其后——在 chatSvc 装配块附近插入即可）。

3. `registerHandlers({ ..., attachments: { svc: uploadSvc, media: mediaSvc } })`。
4. protocol 注册改为**无条件**（dev/prod 都注册）——dev（Vite）**省略 rendererRoot**（P1-5：媒体分支不依赖渲染根；dev 页面在 Vite http、out/renderer 未必构建，传了会 realpath ENOENT）：

```typescript
    await registerCyreneProtocolHandler({
      // P1-5：dev（shouldUseViteDevServer）省略 rendererRoot——媒体分支不依赖它，避免 out/renderer 未构建时 realpath 抛错
      ...(!shouldUseViteDevServer(app.isPackaged, process.env) ? { rendererRoot: join(__dirname, '../renderer') } : {}),
      resolveMedia: (mediaType, id, request) => mediaSvc.stream(mediaType, id, request)
    })
```

（移除 `if (!shouldUseViteDevServer(...))` 包裹；dev/prod 都注册——dev 页面在 Vite http、媒体 URL 在 cyrene://，故媒体分支需 dev 也注册，spec §3.1 行。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachments-handlers.spec.ts && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: PASS + typecheck + build 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/attachments/attachments-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/attachments-handlers.spec.ts
git commit -m "feat(G3 attachment): attachments 四通道 IPC handler + Main 装配（dev 也注册 protocol）"
```

---

### Task 11: Preload 四方法 + DesktopApiLike（D5 路径隔离）

> Preload `webUtils.getPathForFile(file)` 注入 path；path 为空串视为 pathless（要求已传 bytes）；**path 不进入 contextBridge 返回面**（仅 ipcRenderer.invoke 入参）。

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`
- Test: `apps/desktop/tests/unit/desktop-api-attachments.spec.ts`

**Interfaces:**
- Consumes（Task 2/3）：`UploadFileDescriptor`、响应 schema
- Produces（Task 13-16 消费）：
  - `desktopApi.attachmentsValidate(input: { files: Array<{ localId; name; size; mediaType; source; kind?; file?: File; bytes?: ArrayBuffer }> }): Promise<FileValidationResult[]>`
  - `desktopApi.attachmentsUpload(input: { uploadId: string; files: Array<{ localId; name; size; mediaType; source; kind?; file?: File; bytes?: ArrayBuffer }> }): Promise<AttachmentsUploadResponse>`
  - `desktopApi.attachmentsCancel(uploadId: string): Promise<void>`
  - `desktopApi.attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult>`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/desktop-api-attachments.spec.ts`

```typescript
// tests/unit/desktop-api-attachments.spec.ts
// Task 11:preload attachments 面（spec §4.2/§3.2，D5）——webUtils.getPathForFile 注入 path、pathless 走 bytes、
// path 不入返回面。env=node：mock 'electron' 的 ipcRenderer + webUtils。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/contracts'

const { mockIpc, mockWebUtils } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    mockIpc: {
      invoke: vi.fn(),
      on: vi.fn((c: string, h: (...a: unknown[]) => void) => { handlers.set(c, [...(handlers.get(c) ?? []), h]) }),
      removeListener: vi.fn(),
      emit: (c: string, ...args: unknown[]): void => { for (const h of handlers.get(c) ?? []) h({}, ...args) }
    },
    mockWebUtils: { getPathForFile: vi.fn() }
  }
})

vi.mock('electron', () => ({ ipcRenderer: mockIpc, webUtils: mockWebUtils }))
vi.spyOn(console, 'warn').mockImplementation(() => {})

async function importApi() {
  const mod = await import('../../src/preload/desktop-api')
  return mod.desktopApi
}

beforeEach(() => {
  mockIpc.invoke.mockReset()
  mockWebUtils.getPathForFile.mockReset()
})

describe('desktopApi attachments 面', () => {
  it('attachmentsValidate：真实文件经 webUtils 注入 path（path 在 invoke 入参，不在返回面）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/tmp/a.png')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [{ localId: 'l1', ok: true, kind: 'image' }] })
    const res = await api.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'picker', file: {} as File }] })
    expect(res).toEqual([{ localId: 'l1', ok: true, kind: 'image' }])
    expect(mockWebUtils.getPathForFile).toHaveBeenCalledTimes(1)
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsValidate, {
      files: [{ localId: 'l1', name: 'a.png', size: 1, mediaType: 'image/png', source: 'picker', path: '/tmp/a.png' }]
    })
  })
  it('attachmentsValidate：pathless 文件（getPathForFile 返回空串）→ 走 bytes，path 缺省', async () => {
    // P1-2：f.file 为 JS 构造 File（粘贴项）时 getPathForFile 返 ''，但 bytes 必须保留（两个独立 if）——
    // 断言 bytes 为 Uint8Array 且 length 正确；旧 else-if 实现下此断言必挂（descriptor 无 path 无 bytes）
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: [{ localId: 'l1', ok: true, kind: 'file' }] })
    const bytes = new ArrayBuffer(2)
    await api.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.bin', size: 2, mediaType: 'application/octet-stream', source: 'paste', file: {} as File, bytes }] })
    const payload = mockIpc.invoke.mock.calls[0][1] as { files: Array<{ path?: string; bytes?: Uint8Array }> }
    expect(payload.files[0].path).toBeUndefined()
    expect(payload.files[0].bytes).toBeInstanceOf(Uint8Array)
    expect((payload.files[0].bytes as Uint8Array).length).toBe(2)
  })
  it('attachmentsUpload：invoke 带 uploadId + files（path/bytes 二选一）', async () => {
    const api = await importApi()
    mockWebUtils.getPathForFile.mockReturnValue('/tmp/v.mp4')
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'video', mediaType: 'video/mp4' }] } })
    const res = await api.attachmentsUpload({ uploadId: 'u1', files: [{ localId: 'l1', name: 'v.mp4', size: 1, mediaType: 'video/mp4', source: 'picker', file: {} as File }] })
    expect(res.attachments).toHaveLength(1)
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsUpload, expect.objectContaining({ uploadId: 'u1' }))
  })
  it('attachmentsCancel / attachmentsCheck 单参数', async () => {
    const api = await importApi()
    mockIpc.invoke.mockResolvedValue({ ok: true, data: undefined })
    await api.attachmentsCancel('u1')
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsCancel, { uploadId: 'u1' })
    mockIpc.invoke.mockResolvedValue({ ok: true, data: { status: 'expired' } })
    const r = await api.attachmentsCheck('att_1')
    expect(r).toEqual({ status: 'expired' })
    expect(mockIpc.invoke).toHaveBeenCalledWith(IpcChannels.attachmentsCheck, { attachmentId: 'att_1' })
  })
  it('ok:false → 抛 [code] message（结构化错误）', async () => {
    const api = await importApi()
    mockIpc.invoke.mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND', message: '附件不存在' } })
    await expect(api.attachmentsCheck('att_1')).rejects.toThrow('[NOT_FOUND] 附件不存在')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/desktop-api-attachments.spec.ts`
Expected: FAIL——`api.attachmentsValidate` 不存在（undefined）。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/preload/desktop-api.ts`

import 区补 `webUtils`（`import { ipcRenderer, webUtils } from 'electron'`）、`AttachmentCheckResult/AttachmentsUploadResponse/FileValidationResult/UploadFileDescriptor` 类型、`AttachmentCheckResultSchema/AttachmentsUploadResponseSchema/FileValidationResultSchema`，然后追加：

```typescript
// —— attachments 面（spec §4.2，D5：path 仅 Preload 注入，不入返回面）——
interface AttachmentInputFile { localId: string; name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; kind?: 'image' | 'video' | 'audio' | 'file' | 'link'; file?: File; bytes?: ArrayBuffer }

function toIpcDescriptor(f: AttachmentInputFile): Omit<import('@shared/contracts').UploadFileDescriptor, 'path' | 'bytes'> & { path?: string; bytes?: Uint8Array } {
  const out: Record<string, unknown> = { localId: f.localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source }
  if (f.kind) out.kind = f.kind
  // P1-2：两个独立 if（不互斥）——file 注入 path（getPathForFile 空串视为 pathless），bytes 独立保留。
  // 旧 else-if：粘贴项 f.file 为 JS 构造 File（getPathForFile 返 ''），bytes 分支永不达 → descriptor 无 path 无 bytes
  // → Task 3 schema refine（path/bytes 二选一）判 SCHEMA_VALIDATION_FAILED，粘贴路径端到端断。
  if (f.file) {
    const p = webUtils.getPathForFile(f.file)
    if (p) out.path = p          // 空串视为 pathless（JS 构造 File 无真实路径，安全属性）
  }
  if (f.bytes) out.bytes = new Uint8Array(f.bytes)
  return out as ReturnType<typeof toIpcDescriptor>
}

async function attachmentsValidate(input: { files: AttachmentInputFile[] }): Promise<FileValidationResult[]> {
  return unwrap(await invokeWithArgs<FileValidationResult[]>(IpcChannels.attachmentsValidate, { files: input.files.map(toIpcDescriptor) }), z.array(FileValidationResultSchema))
}
async function attachmentsUpload(input: { uploadId: string; files: AttachmentInputFile[] }): Promise<AttachmentsUploadResponse> {
  return unwrap(await invokeWithArgs<AttachmentsUploadResponse>(IpcChannels.attachmentsUpload, { uploadId: input.uploadId, files: input.files.map(toIpcDescriptor) }), AttachmentsUploadResponseSchema)
}
async function attachmentsCancel(uploadId: string): Promise<void> {
  unwrap(await invokeWithArgs<void>(IpcChannels.attachmentsCancel, { uploadId }), z.undefined())
}
async function attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult> {
  return unwrap(await invokeWithArgs<AttachmentCheckResult>(IpcChannels.attachmentsCheck, { attachmentId }), AttachmentCheckResultSchema)
}
```

`desktopApi` 对象追加 `attachmentsValidate, attachmentsUpload, attachmentsCancel, attachmentsCheck`。

`apps/desktop/src/renderer/src/stores/desktop-api.types.ts` 追加 import 与接口方法：

```typescript
import type { AttachmentCheckResult, AttachmentsUploadResponse, FileValidationResult, UploadFileDescriptor } from '@shared/contracts'

export interface DesktopAttachmentInputFile { localId: string; name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; kind?: 'image' | 'video' | 'audio' | 'file' | 'link'; file?: File; bytes?: ArrayBuffer }
// DesktopApiLike 内：
  attachmentsValidate(input: { files: DesktopAttachmentInputFile[] }): Promise<FileValidationResult[]>
  attachmentsUpload(input: { uploadId: string; files: DesktopAttachmentInputFile[] }): Promise<AttachmentsUploadResponse>
  attachmentsCancel(uploadId: string): Promise<void>
  attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult>
```

> `UploadFileDescriptor` import 用于类型一致性注释；`DesktopAttachmentInputFile` 是 Renderer 面形状（含 `file?: File`），Preload 消费。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/desktop-api-attachments.spec.ts tests/unit/desktop-api-chat.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/preload/desktop-api.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/tests/unit/desktop-api-attachments.spec.ts
git commit -m "feat(G3 attachment): preload attachments 四方法 + DesktopApiLike（D5 路径隔离）"
```

---

### Task 12: message.store 发送携带附件（D3 发送编排前置）

> `send(text, opts?: { attachments?: MessageAttachment[] })`：乐观消息带 `attachments`；`api.send` 带 refs（kind/mime 提示值）；ack 后 migrateKey（既有路径）。`chatSendSchema`/RealBackend payload 已含 attachments（Task 3/5）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Test: `apps/desktop/tests/unit/message.store.spec.ts`（追加）

**Interfaces:**
- Consumes（Task 1）：`MessageAttachment`/`MessageAttachmentRef`
- Produces（Task 14/17 消费）：`send(text: string, opts?: { attachments?: MessageAttachment[] }): Promise<void>`

- [ ] **Step 1: 写失败测试** —— 追加到 `apps/desktop/tests/unit/message.store.spec.ts`

```typescript
  // ---------- G3（附件发送编排，spec §4.4/§5）----------

  it('send 携带附件 → 乐观消息带 attachments + api.send 带 refs（kind/mime 提示值）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1', serverMessageId: 'msg-srv' })
    const store = useMessageStore()
    await store.send('hi', { attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] })
    const msgs = Object.values(store.byId)
    const user = msgs.find((m) => m.role === 'user')
    expect(user?.attachments).toEqual([{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }])
    expect(mockApi.send).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{ attachmentId: 'att_1', kind: 'image', mime: 'image/png' }]
    }))
    expect(user?.status).toBe('acknowledged')
    expect(store.byId['msg-srv']).toBeDefined()   // migrateKey 后正式 ID
  })

  it('send 失败（附件已上传）→ 乐观消息 failed，附件不重复回退', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockRejectedValueOnce(new Error('[BACKEND_REJECTED] 队列已满'))
    const store = useMessageStore()
    await store.send('hi', { attachments: [{ attachmentId: 'att_1', kind: 'file', mediaType: 'application/pdf' }] })
    const user = Object.values(store.byId).find((m) => m.role === 'user')
    expect(user?.status).toBe('failed')
    expect(user?.attachments?.[0]?.attachmentId).toBe('att_1')
  })

  it('无附件时 send 行为不变（attachments 缺省）', async () => {
    const conv = useConversationStore()
    conv.$patch({ currentId: 'conv-1' })
    mockApi.send.mockResolvedValueOnce({ clientRequestId: 'c1' })
    const store = useMessageStore()
    await store.send('hi')
    expect(mockApi.send).toHaveBeenCalledWith(expect.not.objectContaining({ attachments: expect.anything() }))
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts`
Expected: FAIL——`send` 不接受第二个参数（ts 层面测试编译失败/运行报 `attachments` undefined）。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/message.store.ts`

```typescript
  async function send(text: string, opts?: { attachments?: MessageAttachment[] }): Promise<void> {
    const conversationId = useConversationStore().currentId
    if (!conversationId) return
    lastError.value = undefined
    const clientRequestId = crypto.randomUUID()
    const key = `local-${clientRequestId}`
    const optimistic: Message = {
      messageId: key,
      conversationId,
      role: 'user',
      content: text,
      status: 'pending',
      clientMessageId: clientRequestId,
      createdAt: nowIso(),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {})
    }
    upsertMessage(optimistic)
    sending.value = true
    try {
      const ref = await api.send({
        conversationId,
        text,
        clientRequestId,
        ...(opts?.attachments?.length
          ? { attachments: opts.attachments.map((a) => ({ attachmentId: a.attachmentId, kind: a.kind, mime: a.mediaType })) }
          : {})
      })
      if (ref?.serverMessageId) migrateKey(key, ref.serverMessageId, optimistic)
      optimistic.status = 'acknowledged'
    } catch (e) {
      optimistic.status = 'failed'
      lastError.value = parsePublicError(messageOf(e))
    } finally {
      sending.value = false
    }
  }
```

import `MessageAttachment`（`@shared/contracts` 已有 `Message` import，补 `MessageAttachment`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/message.store.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/message.store.ts apps/desktop/tests/unit/message.store.spec.ts
git commit -m "feat(G3 attachment): messageStore.send 携带附件（乐观消息 + refs，D3）"
```

---

### Task 13: Renderer 纯逻辑层 —— attachment-state（D4 状态机）+ media 工具（D9 播放矩阵）+ media-url

> 状态机为纯函数 `attachmentQueueReducer`（selected→validating→ready→uploading→failed/cancelled，省略 uploaded 瞬态；拖拽/粘贴/点击仅 source 不同；uploading 禁止移除）+ `canSendQueue`（发送条件：无 failed/validating/uploading）+ `clientPrecheck`（Renderer 侧 UX 预检，用 shared 常量）。`media.ts` 播放矩阵（PLAYABLE_MEDIA 可测纯常量）+ `formatFileSize`；`media-url.ts` 构造 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`。

**Files:**
- Create: `apps/desktop/src/renderer/src/attachments/attachment-state.ts`
- Create: `apps/desktop/src/renderer/src/utils/media.ts`
- Create: `apps/desktop/src/renderer/src/utils/media-url.ts`
- Test: `apps/desktop/tests/unit/attachment-state.spec.ts`、`apps/desktop/tests/unit/media-utils.spec.ts`

**Interfaces:**
- Consumes（Task 2）：`PendingSendItem`/`PendingAttachment`/`PendingSticker`、限额常量
- Produces（Task 14 store、Task 16 组件消费）：
  - `export interface PendingQueueState { pendingById: Record<string, PendingSendItem>; order: string[] }`
  - `export const emptyQueue = (): PendingQueueState`
  - `export type AttachmentQueueAction = { type: 'add'; item: PendingSendItem } | { type: 'validate'; localId: string } | { type: 'validate-ok'; localId: string } | { type: 'validate-fail'; localId: string; reason: string; message?: string } | { type: 'upload'; localIds: string[] } | { type: 'upload-fail'; localId: string; reason: string; message?: string } | { type: 'cancel' } | { type: 'remove'; localId: string } | { type: 'clear' }`
  - `export function attachmentQueueReducer(state: PendingQueueState, action: AttachmentQueueAction): PendingQueueState`
  - `export function canSendQueue(state: PendingQueueState): { canSend: boolean; blockReason?: string }`
  - `export function clientPrecheck(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; reasons: string[] }`
  - `media.ts`: `PLAYABLE_MEDIA: Record<AttachmentKind, readonly string[]>`、`isPlayable(kind, mime): boolean`、`formatFileSize(bytes?: number): string`
  - `media-url.ts`: `export function mediaUrlFor(type: 'attachment' | 'sticker', id: string): string`

- [ ] **Step 1: 写失败测试** —— 两个新 spec

`apps/desktop/tests/unit/attachment-state.spec.ts`：

```typescript
// tests/unit/attachment-state.spec.ts
// Task 13:附件状态机（spec §4.3，D4）——全转移 + source 不变性 + 发送阻断 + 省略 uploaded 态。纯函数无 Vue。
import { describe, expect, it } from 'vitest'
import type { PendingAttachment, PendingSendItem } from '@shared/contracts'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type PendingQueueState } from '../../src/renderer/src/attachments/attachment-state'

function item(localId: string, over: Partial<PendingAttachment> = {}): PendingSendItem {
  return { kind: 'attachment', localId, name: 'a.png', size: 10, mediaType: 'image/png', source: 'drag_drop', status: 'selected', ...over }
}
function withItem(state: PendingQueueState, i: PendingSendItem): PendingQueueState {
  return attachmentQueueReducer(state, { type: 'add', item: i })
}

describe('attachmentQueueReducer（D4 状态机）', () => {
  it('selected → validating → ready（validate-ok）', () => {
    let s = emptyQueue()
    s = withItem(s, item('l1'))
    s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('validating')
    s = attachmentQueueReducer(s, { type: 'validate-ok', localId: 'l1' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('ready')
  })
  it('validating → failed（validate-fail，reason 逐项解释）', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
    s = attachmentQueueReducer(s, { type: 'validate-fail', localId: 'l1', reason: 'too_large', message: '超过大小上限' })
    const a = s.pendingById['l1'] as PendingAttachment
    expect(a.status).toBe('failed')
    expect(a.reason).toBe('too_large')
  })
  it('ready → uploading →（upload-fail → failed）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'ready' }))
    s = attachmentQueueReducer(s, { type: 'upload', localIds: ['l1'] })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('uploading')
    s = attachmentQueueReducer(s, { type: 'upload-fail', localId: 'l1', reason: 'network', message: '网络错误' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('failed')
  })
  it('uploading → cancel → cancelled（终态）', () => {
    let s = withItem(emptyQueue(), item('l1', { status: 'uploading' }))
    s = attachmentQueueReducer(s, { type: 'cancel' })
    expect((s.pendingById['l1'] as PendingAttachment).status).toBe('cancelled')
  })
  it('remove 删除条目（order 同步）', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = withItem(s, item('l2'))
    s = attachmentQueueReducer(s, { type: 'remove', localId: 'l1' })
    expect(s.pendingById['l1']).toBeUndefined()
    expect(s.order).toEqual(['l2'])
  })
  it('clear 清空', () => {
    let s = withItem(emptyQueue(), item('l1'))
    s = attachmentQueueReducer(s, { type: 'clear' })
    expect(s).toEqual(emptyQueue())
  })
  it('状态枚举省略 uploaded 瞬态（D4，对齐 docs/06 §7）', () => {
    const statuses: ReadonlyArray<string> = ['selected', 'validating', 'ready', 'uploading', 'failed', 'cancelled']
    expect(statuses).not.toContain('uploaded')
  })
  it('source 不变性：picker/drag_drop/paste 只影响 source 字段，状态流转一致', () => {
    for (const source of ['picker', 'drag_drop', 'paste'] as const) {
      let s = withItem(emptyQueue(), item('l1', { source }))
      s = attachmentQueueReducer(s, { type: 'validate', localId: 'l1' })
      s = attachmentQueueReducer(s, { type: 'validate-ok', localId: 'l1' })
      expect((s.pendingById['l1'] as PendingAttachment).status).toBe('ready')
      expect((s.pendingById['l1'] as PendingAttachment).source).toBe(source)
    }
  })
})

describe('canSendQueue（发送阻断条件，spec §4.3）', () => {
  it('全 ready 或空 → 可发送', () => {
    expect(canSendQueue(withItem(emptyQueue(), item('l1', { status: 'ready' }))).canSend).toBe(true)
    expect(canSendQueue(emptyQueue()).canSend).toBe(true)
  })
  it('存在 failed → 阻断 + 提示', () => {
    const r = canSendQueue(withItem(emptyQueue(), item('l1', { status: 'failed', reason: 'too_large' })))
    expect(r.canSend).toBe(false)
    expect(r.blockReason).toContain('失败')
  })
  it('存在 validating → 阻断 + 等待提示', () => {
    const r = canSendQueue(withItem(emptyQueue(), item('l1', { status: 'validating' })))
    expect(r.canSend).toBe(false)
  })
  it('存在 uploading → 阻断', () => {
    expect(canSendQueue(withItem(emptyQueue(), item('l1', { status: 'uploading' }))).canSend).toBe(false)
  })
})

describe('clientPrecheck（Renderer UX 预检，D-04 数值共用）', () => {
  it('数量/聚合/单文件超限 → reasons', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1, mediaType: 'image/png' }))
    expect(clientPrecheck(many).ok).toBe(false)
    const huge = [{ name: 'v', size: 60 * 1024 * 1024, mediaType: 'video/mp4' }]
    expect(clientPrecheck(huge).ok).toBe(false)
  })
  it('合法 → ok', () => {
    expect(clientPrecheck([{ name: 'a', size: 1024, mediaType: 'image/png' }]).ok).toBe(true)
  })
})
```

`apps/desktop/tests/unit/media-utils.spec.ts`：

```typescript
// tests/unit/media-utils.spec.ts
// Task 13:播放矩阵 + 媒体 URL（spec §4.6/§4.4，D9）——PLAYABLE_MEDIA 纯常量、isPlayable、formatFileSize、mediaUrlFor。
import { describe, expect, it } from 'vitest'
import { formatFileSize, isPlayable, PLAYABLE_MEDIA } from '../../src/renderer/src/utils/media'
import { mediaUrlFor } from '../../src/renderer/src/utils/media-url'

describe('PLAYABLE_MEDIA（D-03 播放矩阵，spec §4.6）', () => {
  it('video 可播 mp4/webm/ogg；mkv/mov/h265 不在列表（标暂不支持）', () => {
    expect(PLAYABLE_MEDIA.video).toContain('video/mp4')
    expect(PLAYABLE_MEDIA.video).toContain('video/webm')
    expect(PLAYABLE_MEDIA.video).toContain('video/ogg')
    expect(PLAYABLE_MEDIA.video).not.toContain('video/x-matroska')
    expect(PLAYABLE_MEDIA.video).not.toContain('video/quicktime')
  })
  it('audio 可播 mp3/wav/ogg/flac/m4a', () => {
    for (const m of ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4']) expect(PLAYABLE_MEDIA.audio).toContain(m)
  })
  it('isPlayable 按 kind 白名单', () => {
    expect(isPlayable('video', 'video/mp4')).toBe(true)
    expect(isPlayable('video', 'video/x-matroska')).toBe(false)
    expect(isPlayable('audio', 'audio/wav')).toBe(true)
    expect(isPlayable('image', 'image/png')).toBe(true)
  })
})

describe('formatFileSize / mediaUrlFor', () => {
  it('字节 → 可读大小（B/KB/MB）', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(undefined)).toBe('')
  })
  it('mediaUrlFor 构造同源媒体 URL', () => {
    expect(mediaUrlFor('attachment', 'att_1')).toBe('cyrene://renderer/__cyrene-media/attachment/att_1')
    expect(mediaUrlFor('sticker', 'st_1')).toBe('cyrene://renderer/__cyrene-media/sticker/st_1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-state.spec.ts tests/unit/media-utils.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— 三个文件

`apps/desktop/src/renderer/src/attachments/attachment-state.ts`：

```typescript
// src/renderer/src/attachments/attachment-state.ts
// 阶段 3 G3（spec §4.3，D4）：附件状态机纯函数——selected→validating→ready→uploading→(发送编排)/failed/cancelled，
// 省略 uploaded 瞬态（docs/06 §7 枚举一致）；拖拽/粘贴/点击仅 source 不同；uploading 禁止移除。
// 信任边界：Renderer 纯逻辑层不得 import Main——kindFromMime 从本进程 utils/media.ts 取（同 shared 常量实现）。
import type { PendingAttachment, PendingSendItem } from '@shared/contracts'
import { ATTACHMENT_AGGREGATE_BYTES, ATTACHMENT_MAX_BYTES_BY_KIND, ATTACHMENT_MAX_FILES } from '@shared/contracts/attachments'
import { kindFromMime } from '../utils/media'

export interface PendingQueueState {
  pendingById: Record<string, PendingSendItem>
  order: string[]
}

export const emptyQueue = (): PendingQueueState => ({ pendingById: {}, order: [] })

export type AttachmentQueueAction =
  | { type: 'add'; item: PendingSendItem }
  | { type: 'validate'; localId: string }
  | { type: 'validate-ok'; localId: string }
  | { type: 'validate-fail'; localId: string; reason: string; message?: string }
  | { type: 'upload'; localIds: string[] }
  | { type: 'upload-fail'; localId: string; reason: string; message?: string }
  | { type: 'cancel' }
  | { type: 'remove'; localId: string }
  | { type: 'clear' }

function patchAttachment(state: PendingQueueState, localId: string, updater: (a: PendingAttachment) => PendingAttachment): PendingQueueState {
  const cur = state.pendingById[localId]
  if (!cur || cur.kind !== 'attachment') return state
  const next = updater(cur)
  if (next === cur) return state
  return { pendingById: { ...state.pendingById, [localId]: next }, order: state.order }
}

export function attachmentQueueReducer(state: PendingQueueState, action: AttachmentQueueAction): PendingQueueState {
  switch (action.type) {
    case 'add': {
      if (state.pendingById[action.item.localId]) return state
      return { pendingById: { ...state.pendingById, [action.item.localId]: action.item }, order: [...state.order, action.item.localId] }
    }
    case 'validate':
      return patchAttachment(state, action.localId, (a) => (a.status === 'selected' ? { ...a, status: 'validating' } : a))
    case 'validate-ok':
      return patchAttachment(state, action.localId, (a) => (a.status === 'validating' ? { ...a, status: 'ready', reason: undefined } : a))
    case 'validate-fail':
      return patchAttachment(state, action.localId, (a) => (a.status === 'validating' ? { ...a, status: 'failed', reason: action.reason, ...(action.message ? { message: action.message as never } : {}) } : a))
    case 'upload': {
      let s = state
      for (const id of action.localIds) {
        s = patchAttachment(s, id, (a) => (a.status === 'ready' || a.status === 'selected' ? { ...a, status: 'uploading' } : a))
      }
      return s
    }
    case 'upload-fail':
      return patchAttachment(state, action.localId, (a) => (a.status === 'uploading' ? { ...a, status: 'failed', reason: action.reason } : a))
    case 'cancel': {
      let s = state
      for (const id of s.order) {
        s = patchAttachment(s, id, (a) => (a.status === 'uploading' ? { ...a, status: 'cancelled', reason: 'cancelled' } : a))
      }
      return s
    }
    case 'remove': {
      if (!state.pendingById[action.localId]) return state
      const pendingById = { ...state.pendingById }
      delete pendingById[action.localId]
      return { pendingById, order: state.order.filter((id) => id !== action.localId) }
    }
    case 'clear':
      return emptyQueue()
  }
}

/** 发送条件：无 failed/validating/uploading；附件全 ready 或已移除（batch 原子，D3） */
export function canSendQueue(state: PendingQueueState): { canSend: boolean; blockReason?: string } {
  const atts = state.order.map((id) => state.pendingById[id]).filter((i): i is PendingAttachment => i?.kind === 'attachment')
  if (atts.some((a) => a.status === 'failed')) return { canSend: false, blockReason: '请移除失败附件后再发送' }
  if (atts.some((a) => a.status === 'validating')) return { canSend: false, blockReason: '附件校验中，请稍候' }
  if (atts.some((a) => a.status === 'uploading')) return { canSend: false, blockReason: '附件上传中' }
  return { canSend: true }
}

/** Renderer UX 预检（数量/聚合/单文件按 kind 限额；Main validateFiles 为权威） */
export function clientPrecheck(files: Array<{ name: string; size: number; mediaType: string }>): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (files.length > ATTACHMENT_MAX_FILES) reasons.push('一次最多选择 10 个文件')
  const aggregate = files.reduce((s, f) => s + f.size, 0)
  if (aggregate > ATTACHMENT_AGGREGATE_BYTES) reasons.push('附件总大小超过 64MB')
  for (const f of files) {
    const kind = kindFromMime(f.mediaType)
    if (kind !== 'file' && f.size > ATTACHMENT_MAX_BYTES_BY_KIND[kind]) reasons.push(`「${f.name}」超过该类型大小上限`)
  }
  return { ok: reasons.length === 0, reasons }
}
```

> 注：Renderer 纯逻辑层只依赖 `@shared` 与本进程 `utils/media`——`kindFromMime` 在 `media.ts` 提供（与 Main `attachment-policy.kindFromMime` 同源实现、同 shared 常量），不跨进程 import。

`apps/desktop/src/renderer/src/utils/media.ts`：

```typescript
// src/renderer/src/utils/media.ts
// 阶段 3 G3（spec §4.6，D9）：播放矩阵纯常量（D-03 参考表）——可播 MIME 白名单、isPlayable、formatFileSize、kindFromMime（Renderer 侧，与 Main attachment-policy 同源实现）。
import type { AttachmentKind } from '@shared/contracts'
import { ATTACHMENT_KIND_MIME } from '@shared/contracts/attachments'

/** 可播放 MIME 矩阵（视频 mp4/webm/ogv 可播；mkv/mov/h265 标「暂不支持播放」图标卡；列表外一律 file 图标卡） */
export const PLAYABLE_MEDIA: Record<AttachmentKind, readonly string[]> = {
  image: ATTACHMENT_KIND_MIME.image,
  video: ATTACHMENT_KIND_MIME.video,
  audio: ATTACHMENT_KIND_MIME.audio,
  file: [],
  link: []
}

export function isPlayable(kind: AttachmentKind, mime: string): boolean {
  return PLAYABLE_MEDIA[kind]?.includes(mime) ?? false
}

/** MIME → kind 白名单匹配，列表外一律 file（Renderer 侧同源实现，与 Main attachment-policy 一致） */
export function kindFromMime(mime: string): AttachmentKind {
  const k = (Object.keys(ATTACHMENT_KIND_MIME) as AttachmentKind[]).find((kk) => kk !== 'file' && kk !== 'link' && ATTACHMENT_KIND_MIME[kk].includes(mime))
  return k ?? 'file'
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
```

`apps/desktop/src/renderer/src/utils/media-url.ts`：

```typescript
// src/renderer/src/utils/media-url.ts
// 阶段 3 G3（spec §4.4，D1）：Renderer 媒体 URL 构造——同源自定义协议 cyrene://renderer/__cyrene-media/{mediaType}/{id}。
// mediaType ∈ {attachment, sticker}（G4 贴图复用 sticker 分支）。
export type MediaRouteType = 'attachment' | 'sticker'
export const MEDIA_URL_BASE = 'cyrene://renderer/__cyrene-media'

export function mediaUrlFor(type: MediaRouteType, id: string): string {
  return `${MEDIA_URL_BASE}/${type}/${encodeURIComponent(id)}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment-state.spec.ts tests/unit/media-utils.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/attachments/attachment-state.ts apps/desktop/src/renderer/src/utils/media.ts apps/desktop/src/renderer/src/utils/media-url.ts apps/desktop/tests/unit/attachment-state.spec.ts apps/desktop/tests/unit/media-utils.spec.ts
git commit -m "feat(G3 attachment): 附件状态机纯函数 + 播放矩阵 + 媒体 URL（D4/D9/D1）"
```

---

### Task 14: `attachment.store.ts` —— Pinia 附件 store（add/validate/upload/cancel/remove/clearOnSent）

> store 包装 `attachmentQueueReducer`（纯状态）+ IPC 编排：`addFiles`（clientPrecheck → 追加 selected → 异步 validateAll）；`validateAll`（selected→validating→api.attachmentsValidate→ready/failed + kindByLocalId）；`send(text)` 编排（ready→api.attachmentsUpload→messageStore.send(text,{attachments})→clearOnSent；取消→cancelled；失败→failed）；`cancelUpload()`（api.attachmentsCancel）；`remove`（uploading 期间禁止）。队列内存态（重启不恢复）；File 引用/粘贴 bytes 不落 store 序列化面。

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/attachment.store.ts`
- Test: `apps/desktop/tests/unit/attachment.store.spec.ts`

**Interfaces:**
- Consumes（Task 13）：`attachmentQueueReducer`/`canSendQueue`/`clientPrecheck`/`PendingQueueState`；Task 11 `DesktopApiLike`；Task 12 `messageStore.send`
- Produces（Task 15-17 消费）：
  - `export const useAttachmentStore = defineStore('attachment', ...)`
  - State：`pendingById: Ref<Record<string, PendingSendItem>>`、`order: Ref<string[]>`、`kindByLocalId: Ref<Record<string, string>>`、`uploading: Ref<boolean>`、`uploadId: Ref<string | undefined>`
  - Getters：`items: ComputedRef<PendingSendItem[]>`、`hasFailed/hasValidating/hasReady: ComputedRef<boolean>`、`canSend: ComputedRef<{ canSend: boolean; blockReason?: string }>`
  - Actions：`addFiles(files: Array<{ name; size; mediaType; source }>): string[]`（返回加入的 localIds）、`addSticker(sticker: PendingSticker): void`、`validateAll(): Promise<void>`、`send(text: string, messageStore: { send(text, opts?): Promise<void> }): Promise<void>`、`cancelUpload(): Promise<void>`、`remove(localId: string): void`、`clearOnSent(): void`、`clear(): void`

- [ ] **Step 1: 写失败测试** —— `apps/desktop/tests/unit/attachment.store.spec.ts`

```typescript
// tests/unit/attachment.store.spec.ts
// Task 14:attachmentStore（spec §4.3/§4.4）——addFiles→validateAll→send 编排（upload→messageStore.send→清出）、
// 取消、失败逐项 failed、uploading 禁移除。env=node：注入 mock desktopApi（DesktopApiLike）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAttachmentStore } from '../../src/renderer/src/stores/attachment.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import type { FileValidationResult } from '@shared/contracts'

const mockApi = {
  connect: vi.fn(), disconnect: vi.fn(), listConversations: vi.fn(), getMessages: vi.fn(),
  send: vi.fn(), cancel: vi.fn(), activate: vi.fn(), createConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), getConnectionState: vi.fn(),
  getCredentialStatus: vi.fn(), setBackendToken: vi.fn(), clearBackendToken: vi.fn(),
  setEndpoint: vi.fn(), getEndpoint: vi.fn(), getRuntimeInfo: vi.fn(),
  onChatEvent: vi.fn(() => () => {}), onChatState: vi.fn(() => () => {}), onChatReplay: vi.fn(() => () => {}), onChatError: vi.fn(() => () => {}),
  attachmentsValidate: vi.fn(), attachmentsUpload: vi.fn(), attachmentsCancel: vi.fn(), attachmentsCheck: vi.fn()
}

vi.spyOn(console, 'warn').mockImplementation(() => {})

beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(mockApi); vi.clearAllMocks() })

describe('attachmentStore', () => {
  it('addFiles 建 selected 条目 + 自动 validateAll → ready（附 kind）', async () => {
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: true, kind: 'image' }] satisfies FileValidationResult[])
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'drag_drop', bytes: new ArrayBuffer(2) }])
    expect(store.order[0]).toBeDefined()
    expect(store.pendingById[store.order[0]]?.status).toBe('validating')   // addFiles 同步置 validating（预检通过后）
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    expect(store.kindByLocalId[store.order[0]]).toBe('image')
  })

  it('validate 失败 → failed(reason) 可解释', async () => {
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: false, reason: 'too_large', message: '超过大小上限' }] satisfies FileValidationResult[])
    const store = useAttachmentStore()
    store.addFiles([{ name: 'big.png', size: 999, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('failed') })
    expect((store.pendingById[store.order[0]] as { reason?: string }).reason).toBe('too_large')
  })

  it('send 编排：ready → upload → messageStore.send({attachments}) → 清出队列', async () => {
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: true, kind: 'image' }] satisfies FileValidationResult[])
    mockApi.attachmentsUpload.mockResolvedValue({ uploadId: 'u1', attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] })
    const messageStore = { send: vi.fn(async () => {}) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    await store.send('hi', messageStore)
    expect(mockApi.attachmentsUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadId: expect.any(String) }))
    expect(messageStore.send).toHaveBeenCalledWith('hi', { attachments: [{ attachmentId: 'att_1', kind: 'image', mediaType: 'image/png', name: 'a.png' }] })
    expect(store.order).toHaveLength(0)   // 已发送清出
  })

  it('上传失败 → 逐文件 failed(reason)；发送未触发', async () => {
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: true, kind: 'image' }] satisfies FileValidationResult[])
    mockApi.attachmentsUpload.mockRejectedValue(new Error('[BACKEND_REJECTED] 上传失败'))
    const messageStore = { send: vi.fn(async () => {}) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    await store.send('hi', messageStore)
    expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('failed')
    expect(messageStore.send).not.toHaveBeenCalled()
  })

  it('cancelUpload → 条目 cancelled + api.attachmentsCancel(uploadId)', async () => {
    // P2-8：deferred 手动 reject 消除竞态——固定 5ms 定时 vs cancel 并发时，vi.waitFor 轮询 >5ms 可能先触发 reject 使旧版挂
    let rejectUpload!: (e: Error) => void
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: true, kind: 'video' }] satisfies FileValidationResult[])
    mockApi.attachmentsUpload.mockImplementation(() => new Promise((_res, rej) => { rejectUpload = rej }))
    mockApi.attachmentsCancel.mockResolvedValue(undefined)
    const messageStore = { send: vi.fn(async () => {}) }
    const store = useAttachmentStore()
    store.addFiles([{ name: 'v.mp4', size: 10, mediaType: 'video/mp4', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('ready') })
    const p = store.send('hi', messageStore)
    await vi.waitFor(() => { expect(store.uploading).toBe(true) })
    await store.cancelUpload()
    expect(mockApi.attachmentsCancel).toHaveBeenCalledWith(expect.any(String))
    rejectUpload(new Error('[CANCELLED] 已取消'))   // 确定性时序：手动 reject 触发 send 取消分支（cancelUpload 已置 uploading=false）
    await p
    expect((store.pendingById[store.order[0]] as { status: string }).status).toBe('cancelled')
    expect(messageStore.send).not.toHaveBeenCalled()
  })

  it('remove：非 uploading 可移除；uploading 期间禁止', async () => {
    const store = useAttachmentStore()
    store.addFiles([{ name: 'a.png', size: 10, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    const id = store.order[0]!
    store.remove(id)
    expect(store.order).not.toContain(id)
    store.addFiles([{ name: 'b.png', size: 10, mediaType: 'image/png', source: 'paste', bytes: new ArrayBuffer(2) }])
    const id2 = store.order[0]!
    ;(store.pendingById[id2] as { status: string }).status = 'uploading'
    store.uploading = true
    store.remove(id2)
    expect(store.pendingById[id2]).toBeDefined()   // 上传中禁止移除
  })

  it('hasFailed 阻断发送（canSend.blockReason）', async () => {
    mockApi.attachmentsValidate.mockResolvedValue([{ localId: 'l1', ok: false, reason: 'too_large', message: '超限' }] satisfies FileValidationResult[])
    const store = useAttachmentStore()
    store.addFiles([{ name: 'big.png', size: 999, mediaType: 'image/png', source: 'picker', bytes: new ArrayBuffer(2) }])
    await vi.waitFor(() => { expect(store.hasFailed).toBe(true) })
    expect(store.canSend.canSend).toBe(false)
    expect(store.canSend.blockReason).toContain('失败')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment.store.spec.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 最小实现** —— `apps/desktop/src/renderer/src/stores/attachment.store.ts`

```typescript
// src/renderer/src/stores/attachment.store.ts
// 阶段 3 G3（spec §4.3/§4.4）：附件 store——纯状态机（attachment-state）+ IPC 编排。
// 队列内存态（重启不恢复，docs/06 §7）；File 引用/粘贴 bytes 不落 store 序列化面（仅引用与元数据）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AttachmentKind, AttachmentSource, MessageAttachment, PendingAttachment, PendingSendItem, PendingSticker } from '@shared/contracts'
import { api } from './desktop-api'
import { attachmentQueueReducer, canSendQueue, clientPrecheck, emptyQueue, type PendingQueueState } from '../attachments/attachment-state'

export interface AddFileInput { name: string; size: number; mediaType: string; source: 'picker' | 'drag_drop' | 'paste'; file?: File; bytes?: ArrayBuffer }

export const useAttachmentStore = defineStore('attachment', () => {
  const state = ref<PendingQueueState>(emptyQueue())
  const kindByLocalId = ref<Record<string, AttachmentKind>>({})
  /** File/bytes 引用（D5：Renderer 只持有浏览器 File 引用；path 由 Preload 经 webUtils 注入，不落 store 序列化面） */
  const fileByLocalId = ref<Record<string, { file?: File; bytes?: ArrayBuffer }>>({})
  const uploading = ref(false)
  const uploadId = ref<string>()

  const pendingById = computed(() => state.value.pendingById)
  const order = computed(() => state.value.order)
  const items = computed(() => order.value.map((id) => pendingById.value[id]).filter(Boolean))
  const hasFailed = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'failed'))
  const hasValidating = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'validating'))
  const hasReady = computed(() => items.value.some((i) => i.kind === 'attachment' && i.status === 'ready'))
  const canSend = computed(() => canSendQueue(state.value))

  function commit(action: Parameters<typeof attachmentQueueReducer>[1]): void {
    state.value = attachmentQueueReducer(state.value, action)
  }

  // P2-1：source 用字面联合 AttachmentSource（desktop-api.types.ts DesktopAttachmentInputFile.source 为 'picker'|'drag_drop'|'paste'，
  // 宽化为 string 会 typecheck 报错）；PendingAttachment.source 本身即该联合
  function descriptor(f: PendingAttachment): { localId: string; name: string; size: number; mediaType: string; source: AttachmentSource; kind?: AttachmentKind; file?: File; bytes?: ArrayBuffer } {
    const ref = fileByLocalId.value[f.localId]
    const kind = kindByLocalId.value[f.localId]
    return { localId: f.localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source, ...(kind ? { kind } : {}), ...(ref?.file ? { file: ref.file } : {}), ...(ref?.bytes ? { bytes: ref.bytes } : {}) }
  }

  /** 添加（pick/drop/paste 仅 source 不同）；客户端预检 → selected → 异步 validateAll */
  function addFiles(files: AddFileInput[]): string[] {
    const pre = clientPrecheck(files)
    const ids: string[] = []
    for (const f of files) {
      const localId = `loc-${crypto.randomUUID()}`
      ids.push(localId)
      fileByLocalId.value[localId] = f.file || f.bytes ? { file: f.file, bytes: f.bytes } : {}
      commit({ type: 'add', item: { kind: 'attachment', localId, name: f.name, size: f.size, mediaType: f.mediaType, source: f.source, status: pre.ok ? 'selected' : 'failed', ...(pre.ok ? {} : { reason: 'precheck', message: pre.reasons.join('；') }) } })
      if (!pre.ok) continue
      commit({ type: 'validate', localId })
    }
    void validateAll()
    return ids
  }

  /** G4 贴图分支：入队即 ready（spec §2 G4 边界） */
  function addSticker(sticker: PendingSticker): void {
    commit({ type: 'add', item: sticker })
  }

  /** selected/validating → Main 校验 → ready/failed（逐项） */
  async function validateAll(): Promise<void> {
    const files = order.value
      .map((id) => pendingById.value[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && (i.status === 'selected' || i.status === 'validating'))
    if (files.length === 0) return
    let results
    try {
      results = await api.attachmentsValidate({ files: files.map((f) => descriptor(f)) })
    } catch {
      for (const f of files) commit({ type: 'validate-fail', localId: f.localId, reason: 'validate_error', message: '附件校验失败' })
      return
    }
    for (const r of results) {
      if (r.ok && r.kind) {
        commit({ type: 'validate-ok', localId: r.localId })
        kindByLocalId.value[r.localId] = r.kind
      } else {
        commit({ type: 'validate-fail', localId: r.localId, reason: r.reason ?? 'invalid', message: r.message })
      }
    }
  }

  /** 发送编排（spec §4.4）：ready 队列 → 批量上传 → messageStore.send(text,{attachments}) → 清出 */
  async function send(text: string, messageStore: { send(text: string, opts?: { attachments?: MessageAttachment[] }): Promise<void> }): Promise<void> {
    const ready = order.value
      .map((id) => pendingById.value[id])
      .filter((i): i is PendingAttachment => i?.kind === 'attachment' && i.status === 'ready')
    if (ready.length === 0) { await messageStore.send(text); return }
    const blocked = canSendQueue(state.value)
    if (!blocked.canSend) return
    const uid = crypto.randomUUID()
    uploadId.value = uid
    uploading.value = true
    commit({ type: 'upload', localIds: ready.map((f) => f.localId) })
    try {
      const resp = await api.attachmentsUpload({ uploadId: uid, files: ready.map((f) => descriptor(f)) })
      await messageStore.send(text, { attachments: resp.attachments })
      clearOnSent()
    } catch (e) {
      const cancelled = uploading.value === false   // cancelUpload 已置 uploading=false → 走取消分支
      if (cancelled) commit({ type: 'cancel' })
      else for (const f of ready) commit({ type: 'upload-fail', localId: f.localId, reason: 'upload_failed', message: e instanceof Error ? e.message : '上传失败' })
    } finally {
      uploading.value = false
      uploadId.value = undefined
    }
  }

  async function cancelUpload(): Promise<void> {
    if (!uploading.value || !uploadId.value) return
    uploading.value = false
    try { await api.attachmentsCancel(uploadId.value) } catch { /* 取消尽力 */ }
  }

  function remove(localId: string): void {
    if (uploading.value) return   // 上传中禁止移除（spec §4.3）
    commit({ type: 'remove', localId })
  }

  function clearOnSent(): void {
    state.value = attachmentQueueReducer(state.value, { type: 'clear' })
    kindByLocalId.value = {}
    fileByLocalId.value = {}
  }

  function clear(): void {
    state.value = emptyQueue()
    kindByLocalId.value = {}
    fileByLocalId.value = {}
    uploading.value = false
    uploadId.value = undefined
  }

  return { pendingById, order, items, kindByLocalId, fileByLocalId, uploading, uploadId, hasFailed, hasValidating, hasReady, canSend, addFiles, addSticker, validateAll, send, cancelUpload, remove, clearOnSent, clear }
})
```

> 说明：`fileByLocalId` 只持浏览器 `File` 引用 / 粘贴 `ArrayBuffer`（D5：Renderer 只收集 File 对象；真实磁盘路径由 Preload `webUtils.getPathForFile` 注入并在 IPC 入参时替换，path 不落 store、不入返回面）。`descriptor(f)` 产出 Renderer 面形状（`file`/`bytes`），Preload 消费后转 `path`/`bytes`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/attachment.store.spec.ts && pnpm -F @cyrene/desktop typecheck`
Expected: PASS + typecheck 绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/attachment.store.ts apps/desktop/tests/unit/attachment.store.spec.ts
git commit -m "feat(G3 attachment): attachmentStore 状态机 + 上传/发送编排（D3/D4）"
```

---

### Task 15: 呈现组件 —— CyAttachmentMedia 分发 + 子组件 + 队列 + 拖拽覆盖层（D8/D9/D10）

> `CyAttachmentMedia` 按 kind + playable 分发：image→内联 `<img>` 原生预览（error 经 `attachmentsCheck` 分类占位）；video/audio→图标卡收起态 + 点击展开内联 `<video/audio controls>`（不引缩略图库，D9）；file→图标卡；link→`CyLinkAttachment`（label + URL，仅 http/https，复用外部打开策略，D8）；错误/过期/撤销/不支持→`CyAttachmentPlaceholder`（可解释占位 + 重试/刷新）。`CyAttachmentQueue` 渲染输入区上方队列（图标/名称/大小/类型/状态/错误原因/移除；validating/uploading 不确定 spinner；failed 原因 + 移除；G4 `PendingSticker` 经 `__cyrene-media/sticker/{stickerId}` 显示）。`CyDropOverlay` 拖入虚线投放区 + 支持类型说明，离开即恢复。组件无单测基线（spec §6 已知限制），验证以 `typecheck` + `build` 为准。

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyAttachmentMedia.vue`
- Create: `apps/desktop/src/renderer/src/components/CyImageAttachment.vue`
- Create: `apps/desktop/src/renderer/src/components/CyVideoAttachment.vue`
- Create: `apps/desktop/src/renderer/src/components/CyAudioAttachment.vue`
- Create: `apps/desktop/src/renderer/src/components/CyFileAttachment.vue`
- Create: `apps/desktop/src/renderer/src/components/CyLinkAttachment.vue`
- Create: `apps/desktop/src/renderer/src/components/CyAttachmentPlaceholder.vue`
- Create: `apps/desktop/src/renderer/src/components/CyAttachmentQueue.vue`
- Create: `apps/desktop/src/renderer/src/components/CyDropOverlay.vue`

**Interfaces:**
- Consumes（Task 13/14）：`mediaUrlFor`、`isPlayable`、`formatFileSize`、`useAttachmentStore`、`AttachmentMediaStatus`
- Produces（Task 16 消费）：
  - `CyAttachmentMedia props: { attachment?: MessageAttachment; segment?: AssistantSegment; kind: AttachmentKind; mediaType?: string; name?: string; size?: number }`
  - `CyAttachmentQueue`（无 props，消费 store）
  - `CyDropOverlay props: { active: boolean; count: number }`，emit `(e: 'leave')`

- [ ] **Step 1: 创建 `CyAttachmentMedia.vue`（分发 + 状态占位）**

```vue
<script setup lang="ts">
// CyAttachmentMedia:按 kind + playable 分发。image 内联预览；video/audio 图标卡收起 + 点击展开播放（D9，不引缩略图库）；
// file 图标卡；link 卡片（D8，仅 http/https）。元素 error → attachmentsCheck 分类占位（D6，仅出错时查询）。
import { computed, ref } from 'vue'
import type { AssistantSegment, AttachmentMediaStatus, MessageAttachment } from '@shared/contracts'
import { api } from '../stores/desktop-api'
import { formatFileSize, isPlayable } from '../utils/media'
import CyImageAttachment from './CyImageAttachment.vue'
import CyVideoAttachment from './CyVideoAttachment.vue'
import CyAudioAttachment from './CyAudioAttachment.vue'
import CyFileAttachment from './CyFileAttachment.vue'
import CyLinkAttachment from './CyLinkAttachment.vue'
import CyAttachmentPlaceholder from './CyAttachmentPlaceholder.vue'

const props = defineProps<{
  kind: 'image' | 'video' | 'audio' | 'file' | 'link'
  attachmentId?: string
  mediaType?: string
  name?: string
  size?: number
  url?: string
  message?: MessageAttachment
  segment?: AssistantSegment
}>()

const mediaStatus = ref<'loading' | AttachmentMediaStatus>('loading')
const unsupported = computed(() => {
  if (props.kind !== 'video' && props.kind !== 'audio') return false
  const mime = props.mediaType ?? ''
  return mime.length > 0 && !isPlayable(props.kind, mime)
})

async function onMediaError(): Promise<void> {
  if (!props.attachmentId) { mediaStatus.value = 'error'; return }
  try {
    const r = await api.attachmentsCheck(props.attachmentId)
    mediaStatus.value = r.status
  } catch {
    mediaStatus.value = 'error'
  }
}
</script>

<template>
  <div class="cy-attachment-media">
    <CyImageAttachment v-if="kind === 'image' && mediaStatus !== 'error' && mediaStatus !== 'expired' && mediaStatus !== 'not_found' && mediaStatus !== 'revoked'"
      :attachment-id="attachmentId" :media-type="mediaType" @error="onMediaError" @loaded="mediaStatus = 'ok'" />
    <CyVideoAttachment v-else-if="kind === 'video' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" @error="onMediaError" />
    <CyAudioAttachment v-else-if="kind === 'audio' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" @error="onMediaError" />
    <CyLinkAttachment v-else-if="kind === 'link'" :url="url" :name="name" />
    <CyAttachmentPlaceholder v-if="mediaStatus !== 'loading' && mediaStatus !== 'ok'" :status="mediaStatus === 'loading' ? undefined : mediaStatus" :attachment-id="attachmentId" />
    <CyFileAttachment v-else-if="kind === 'file' || unsupported" :name="name" :size="size" :media-type="mediaType" :unsupported="unsupported" />
  </div>
</template>

<style scoped>
.cy-attachment-media { display: block; max-width: 100%; }
</style>
```

> 说明：`attachmentId` 为媒体来源；`CyAttachmentMedia` 同时支持 `message.attachments`（`message` prop）与 assistant 媒体分段（`segment` prop）两种入口，`segment`/`message` 未在本组件直接消费——由 `CyMessageBubble` 解析后以 props 传入（Task 16）。占位状态机：`loading` 正常加载；`ok` 不显示占位；其余按 `AttachmentMediaStatus` 显示可解释文案 + 重试/刷新。

- [ ] **Step 2: 创建子组件（6 个）**

`CyImageAttachment.vue`：

```vue
<script setup lang="ts">
import { mediaUrlFor } from '../utils/media-url'
// P2-6：name prop 已声明（模板 :alt="name ?? '附件图片'" 引用它，缺省会 typecheck 报未声明）
const props = defineProps<{ attachmentId?: string; mediaType?: string; name?: string }>()
const emit = defineEmits<{ error: []; loaded: [] }>()
function src(): string | undefined {
  return props.attachmentId ? mediaUrlFor('attachment', props.attachmentId) : undefined
}
</script>

<template>
  <!-- 原生缩放内联预览；svg 经 <img> 不执行脚本（spec §4.6 安全注记） -->
  <img v-if="src()" :src="src()" class="cy-attachment-image" :alt="name ?? '附件图片'" @error="emit('error')" @load="emit('loaded')" />
</template>

<style scoped>
.cy-attachment-image { display: block; max-width: 100%; max-height: 320px; border-radius: 10px; object-fit: contain; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); }
</style>
```

`CyVideoAttachment.vue`（图标卡收起 + 点击展开播放）：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { formatFileSize } from '../utils/media'
import { mediaUrlFor } from '../utils/media-url'
const props = defineProps<{ attachmentId?: string; mediaType?: string; name?: string; size?: number }>()
const emit = defineEmits<{ error: [] }>()
const playing = ref(false)
function src(): string | undefined {
  return props.attachmentId ? mediaUrlFor('attachment', props.attachmentId) : undefined
}
</script>

<template>
  <div v-if="!playing" class="cy-media-card" role="button" tabindex="0" :aria-label="`播放视频 ${name ?? ''}`" @click="playing = true" @keydown.enter="playing = true">
    <span class="cy-media-icon">🎬</span>
    <span class="cy-media-meta">{{ name ?? '视频' }}<template v-if="size !== undefined"> · {{ formatFileSize(size) }}</template></span>
    <span class="cy-media-action">点击播放</span>
  </div>
  <video v-else-if="src()" :src="src()" controls class="cy-media-video" @error="emit('error')" />
</template>

<style scoped>
.cy-media-card { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); cursor: pointer; max-width: 100%; }
.cy-media-meta { color: var(--cy-text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-media-action { margin-left: auto; color: var(--cy-muted); font-size: 12px; }
.cy-media-video { display: block; max-width: 100%; max-height: 320px; border-radius: 10px; border: 1px solid var(--cy-border); }
</style>
```

`CyAudioAttachment.vue`：同构（图标 🔊 + 点击展开 `<audio controls :src>`）。

`CyFileAttachment.vue`：

```vue
<script setup lang="ts">
import { formatFileSize } from '../utils/media'
const props = defineProps<{ name?: string; size?: number; mediaType?: string; unsupported?: boolean }>()
</script>

<template>
  <div class="cy-file-card" :title="mediaType">
    <span class="cy-file-icon">📄</span>
    <span class="cy-file-meta">{{ name ?? '文件' }}<template v-if="size !== undefined"> · {{ formatFileSize(size) }}</template></span>
    <span v-if="unsupported" class="cy-file-note">此格式暂不支持播放</span>
  </div>
</template>

<style scoped>
.cy-file-card { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); max-width: 100%; }
.cy-file-meta { color: var(--cy-text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-file-note { margin-left: auto; color: var(--cy-warning); font-size: 12px; }
</style>
```

`CyLinkAttachment.vue`（D8：label + URL，仅 http/https；打开经外部浏览器——组件只展示，点击由既有导航策略处理）：

```vue
<script setup lang="ts">
const props = defineProps<{ url?: string; name?: string }>()
function isWeb(u?: string): boolean { return !!u && (u.startsWith('http:') || u.startsWith('https:')) }
</script>

<template>
  <a v-if="isWeb(url)" class="cy-link-card" :href="url" target="_blank" rel="noopener noreferrer">
    <span class="cy-link-label">{{ name ?? url }}</span>
    <span class="cy-link-url">{{ url }}</span>
  </a>
  <div v-else class="cy-link-card"><span class="cy-link-label">{{ name ?? '链接' }}</span></div>
</template>

<style scoped>
.cy-link-card { display: grid; gap: 3px; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); max-width: 100%; }
.cy-link-label { color: var(--cy-accent); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-link-url { color: var(--cy-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
```

`CyAttachmentPlaceholder.vue`（spec §4.7 状态占位表）：

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { AttachmentMediaStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'
const props = defineProps<{ status?: AttachmentMediaStatus; attachmentId?: string }>()
const retrying = ref(false)
const TEXT: Record<AttachmentMediaStatus, string> = {
  ok: '', expired: '附件已过期', not_found: '附件不存在', revoked: '附件已撤销', error: '加载失败'
}
async function retry(): Promise<void> {
  if (!props.attachmentId) return
  retrying.value = true
  try { await api.attachmentsCheck(props.attachmentId) } finally { retrying.value = false }
}
</script>

<template>
  <div v-if="status && status !== 'ok'" class="cy-placeholder" role="status">
    <span>{{ TEXT[status] }}</span>
    <button v-if="status === 'error' || status === 'expired'" class="cy-placeholder-action" :disabled="retrying" @click="retry">
      {{ status === 'expired' ? '刷新' : '重试' }}
    </button>
  </div>
</template>

<style scoped>
.cy-placeholder { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 10px; color: var(--cy-muted); background: var(--cy-surface-soft); border: 1px dashed var(--cy-border); font-size: 12px; }
.cy-placeholder-action { padding: 2px 8px; border-radius: 999px; color: var(--cy-accent-text); background: var(--cy-accent); font-size: 11px; }
</style>
```

- [ ] **Step 3: 创建 `CyAttachmentQueue.vue`（队列条目）**

```vue
<script setup lang="ts">
// CyAttachmentQueue:输入区上方待发送队列（spec §4.3/§4.6）。附件条目显示图标/名称/大小/类型/状态/错误原因/移除；
// validating/uploading 显示不确定 spinner；G4 PendingSticker 经 __cyrene-media/sticker/{stickerId} 显示图片（§2 边界）。
import { computed } from 'vue'
import type { PendingAttachment, PendingSendItem } from '@shared/contracts'
import { useAttachmentStore } from '../stores/attachment.store'
import { formatFileSize } from '../utils/media'
import { mediaUrlFor } from '../utils/media-url'

const store = useAttachmentStore()
const STATUS_TEXT: Record<string, string> = {
  selected: '待校验', validating: '校验中', ready: '就绪', uploading: '上传中', failed: '校验失败', cancelled: '已取消'
}
const atts = computed(() => store.items.filter((i) => i.kind === 'attachment') as PendingAttachment[])
const stickers = computed(() => store.items.filter((i) => i.kind === 'sticker') as Extract<PendingSendItem, { kind: 'sticker' }>[])
</script>

<template>
  <div v-if="store.order.length" class="cy-attachment-queue" aria-label="待发送附件">
    <div v-for="a in atts" :key="a.localId" class="cy-queue-item" :class="a.status">
      <span class="cy-queue-status" v-if="a.status === 'validating' || a.status === 'uploading'" aria-hidden="true" />
      <span class="cy-queue-name">{{ a.name }}</span>
      <span class="cy-queue-meta">{{ formatFileSize(a.size) }} · {{ STATUS_TEXT[a.status] ?? a.status }}</span>
      <span v-if="a.status === 'failed' && a.reason" class="cy-queue-error">{{ a.reason }}</span>
      <button v-if="a.status !== 'uploading'" class="cy-queue-remove" :aria-label="`移除 ${a.name}`" @click="store.remove(a.localId)">✕</button>
    </div>
    <div v-for="s in stickers" :key="s.stickerId" class="cy-queue-item">
      <img class="cy-queue-sticker" :src="mediaUrlFor('sticker', s.stickerId)" :alt="s.name ?? '贴图'" />
      <span class="cy-queue-name">{{ s.name ?? '贴图' }}</span>
    </div>
  </div>
</template>

<style scoped>
.cy-attachment-queue { display: grid; gap: 6px; padding: 6px 14px 0; max-height: 140px; overflow-y: auto; }
.cy-queue-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--cy-border); background: var(--cy-surface-soft); font-size: 12px; }
.cy-queue-item.cy-failed { border-style: dashed; border-color: var(--cy-danger); }
.cy-queue-status { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--cy-border); border-top-color: var(--cy-accent); animation: cy-spin 0.8s linear infinite; }
@keyframes cy-spin { to { transform: rotate(360deg); } }
.cy-queue-name { color: var(--cy-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cy-queue-meta { color: var(--cy-muted); flex: 0 0 auto; }
.cy-queue-error { color: var(--cy-danger); flex: 0 0 auto; }
.cy-queue-remove { flex: 0 0 auto; padding: 1px 6px; color: var(--cy-muted); border-radius: 6px; }
.cy-queue-remove:hover { color: var(--cy-danger); }
.cy-queue-sticker { width: 24px; height: 24px; object-fit: contain; }
</style>
```

- [ ] **Step 4: 创建 `CyDropOverlay.vue`（拖入覆盖式虚线投放区）**

```vue
<script setup lang="ts">
// CyDropOverlay:拖入聊天区时覆盖式虚线投放区 + 支持类型说明（spec §3.2/§4.6，docs/03 §8.3）；离开即恢复。
defineProps<{ active: boolean; count: number }>()
const emit = defineEmits<{ leave: [] }>()
</script>

<template>
  <Transition name="cy-fade">
    <div v-if="active" class="cy-drop-overlay" @dragleave.self="emit('leave')" @drop.prevent="emit('leave')">
      <div class="cy-drop-box">
        <p class="cy-drop-title">松开以添加 {{ count }} 个文件</p>
        <p class="cy-drop-sub">图片 / 视频 / 音频 / 文件（≤10 个，聚合 ≤64MB）</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cy-drop-overlay { position: absolute; inset: 0; z-index: 30; display: grid; place-items: center; background: var(--cy-overlay); pointer-events: auto; }
.cy-drop-box { padding: 26px 40px; border: 2px dashed var(--cy-accent); border-radius: 16px; background: var(--cy-surface); text-align: center; }
.cy-drop-title { margin: 0 0 6px; color: var(--cy-text); font-size: 15px; font-weight: 600; }
.cy-drop-sub { margin: 0; color: var(--cy-muted); font-size: 12px; }
.cy-fade-enter-active, .cy-fade-leave-active { transition: opacity 0.12s ease; }
.cy-fade-enter-from, .cy-fade-leave-to { opacity: 0; }
</style>
```

- [ ] **Step 5: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyAttachmentMedia.vue apps/desktop/src/renderer/src/components/CyImageAttachment.vue apps/desktop/src/renderer/src/components/CyVideoAttachment.vue apps/desktop/src/renderer/src/components/CyAudioAttachment.vue apps/desktop/src/renderer/src/components/CyFileAttachment.vue apps/desktop/src/renderer/src/components/CyLinkAttachment.vue apps/desktop/src/renderer/src/components/CyAttachmentPlaceholder.vue apps/desktop/src/renderer/src/components/CyAttachmentQueue.vue apps/desktop/src/renderer/src/components/CyDropOverlay.vue
git commit -m "feat(G3 attachment): 媒体呈现组件 + 队列 + 拖拽覆盖层（D8/D9）"
```

---

### Task 16: `CyChatInput` 接线（文件按钮/拖拽/粘贴/队列/发送编排）+ `CyMessageBubble` 媒体分段

> `CyChatInput`：加「添加文件」`<input type=file multiple>`、`dragover/drop` 收集（覆盖层 `CyDropOverlay`）、`paste` 收集 `clipboardData.files`；队列区 `CyAttachmentQueue`；发送按钮编排——文本 + `attachmentStore.canSend` + `attachmentStore.send(text, messageStore)`（附件存在时先上传再发送，spec §4.4）；拖拽/粘贴只建条目不自动上传/发送。`CyMessageBubble`：user 消息 `message.attachments` 渲染 `CyAttachmentMedia` 列表；assistant 媒体分段（非 text/markdown 且有 attachmentId）渲染同组件，不再落 `[kind 分段]` 占位。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyMessageBubble.vue`

**Interfaces:**
- Consumes（Task 14/15）：`useAttachmentStore`、`CyAttachmentQueue`、`CyDropOverlay`、`CyAttachmentMedia`、`mediaUrlFor`、`isPlayable`

- [ ] **Step 1: 改 `CyChatInput.vue`（script 区）**

```typescript
import { computed, ref } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useAttachmentStore } from '../stores/attachment.store'
import CyAttachmentQueue from './CyAttachmentQueue.vue'
import CyDropOverlay from './CyDropOverlay.vue'

const attachmentStore = useAttachmentStore()
const fileInput = ref<HTMLInputElement>()
const dragActive = ref(false)
let dragDepth = 0

const canSend = computed(() =>
  (draft.value.trim().length > 0 || attachmentStore.hasReady) &&
  !messageStore.sending && !attachmentStore.canSend.blockReason &&
  !!conversationStore.currentId && connectionStore.state.status === 'connected' && conversationStore.ready
)

function send(): void {
  if (!canSend.value) return
  void attachmentStore.send(draft.value.trim(), { send: (t, o) => messageStore.send(t, o) }).then(() => {
    draft.value = ''
  })
}

function onFilePick(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files) attachmentStore.addFiles(Array.from(input.files).map((f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'picker', file: f })))
  input.value = ''
}
function onDrop(e: DragEvent): void {
  dragActive.value = false
  dragDepth = 0
  if (e.dataTransfer?.files?.length) {
    attachmentStore.addFiles(Array.from(e.dataTransfer.files).map((f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'drag_drop', file: f })))
  }
}
function onDragEnter(e: DragEvent): void {
  if (e.dataTransfer?.types?.includes('Files')) { dragDepth += 1; dragActive.value = true }
}
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}
async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length) {
    // 粘贴文件 pathless（webUtils.getPathForFile 返回空串）→ 预读 bytes 一并交 store（D5 粘贴 bytes 型）
    const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'paste' as const, file: f, bytes: await f.arrayBuffer() })))
    attachmentStore.addFiles(inputs)
    e.preventDefault()   // 有粘贴附件时不进文本草稿
  }
}
```

template 区（`.cy-composer` 内、`.cy-composer-box` 前）：

```html
    <CyAttachmentQueue />
    <CyDropOverlay :active="dragActive" :count="attachmentStore.order.length" @leave="dragActive = false" />
```

`.cy-composer-box` 内 textarea 前加按钮：

```html
      <button class="cy-attach-btn" title="添加文件" aria-label="添加文件" @click="fileInput?.click()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <input ref="fileInput" type="file" multiple class="cy-hidden-input" @change="onFilePick" />
```

`.cy-composer` 根元素加拖拽事件 + `position: relative`：`@dragenter="onDragEnter" @dragleave="onDragLeave" @dragover.prevent @drop.prevent="onDrop" @paste="onPaste"`。style 加 `.cy-hidden-input { display: none; }`、`.cy-attach-btn`（复用 send/stop 尺寸与圆角）。`canSend` 用 `attachmentStore.canSend.blockReason` 阻断并展示提示（.cy-banner 复用）。

- [ ] **Step 2: 改 `CyMessageBubble.vue`**

script 区追加：

```typescript
import CyAttachmentMedia from './CyAttachmentMedia.vue'
import { isPlayable } from '../utils/media'

/** user 消息附件列表；assistant 媒体分段（attachmentId 存在时）→ CyAttachmentMedia */
function userAttachments(): Array<{ attachmentId: string; kind: 'image'|'video'|'audio'|'file'|'link'; mediaType?: string; name?: string; size?: number; url?: string }> {
  return (props.message.attachments ?? []).map((a) => ({ attachmentId: a.attachmentId, kind: a.kind, mediaType: a.mediaType, name: a.name, size: a.size }))
}
```

user 消息模板（`<p>{{ message.content }}</p>` 后追加）：

```html
      <div v-for="a in userAttachments()" :key="a.attachmentId" class="cy-user-attachments">
        <CyAttachmentMedia :kind="a.kind" :attachment-id="a.attachmentId" :media-type="a.mediaType" :name="a.name" :size="a.size" />
      </div>
```

assistant 分段模板（替换 `[{{ seg.kind }} 分段]` 分支）：

```html
            <CyAttachmentMedia
              v-else-if="seg.attachmentId"
              :key="seg.segmentId"
              class="cy-segment"
              :kind="(seg.kind as 'image' | 'video' | 'audio' | 'file' | 'link')"
              :attachment-id="seg.attachmentId"
              :media-type="seg.mediaType"
              :name="seg.name"
              :size="seg.size"
            />
            <span v-else class="cy-media-placeholder">[{{ seg.kind }} 分段]</span>
```

> **已知限制（P2-5，wire 契约，不当作完成）**：流式（WS generation 事件）assistant 媒体分段 raw schema 无 `attachmentId` 字段——实时到达的媒体分段无附件标识，走上方 `v-else` 的 `[kind 分段]` 占位；历史/回放（session/REST content）经 `mapContentToEntries` 携带 `attachment_id` 可正常渲染。补齐需后端在流式帧提供附件标识，属联调/后端适配项，记录于文末开放项。

style 追加 `.cy-user-attachments { display: grid; gap: 6px; margin-top: 6px; max-width: 100%; }`。

- [ ] **Step 3: typecheck + build 验证**

Run: `pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop build`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/CyChatInput.vue apps/desktop/src/renderer/src/components/CyMessageBubble.vue
git commit -m "feat(G3 attachment): CyChatInput 文件/拖拽/粘贴/发送编排 + 消息气泡媒体分段"
```

---

### Task 17: 集成测试（MockBackend 往返 + 媒体代理） + 门禁全量 + 文档同步

**Files:**
- Create: `apps/desktop/tests/integration/ipc-attachments.spec.ts`
- Create: `apps/desktop/tests/integration/protocol-media-handler.spec.ts`
- Modify: `apps/desktop/tests/integration/helpers/app.ts`（`launchApp(opts?: { env?: Record<string,string> })` 允许附加 env，向后兼容）
- Modify: `docs/02`、`docs/06`、`docs/16`、`README.md`、`CLAUDE.md`

- [ ] **Step 1: 扩展 `launchApp` 支持附加 env**

`apps/desktop/tests/integration/helpers/app.ts`：签名改为 `export async function launchApp(opts: { env?: Record<string, string> } = {}): Promise<LaunchedApp>`，env 构造末尾合并 `...(opts.env ?? {})`。

- [ ] **Step 2: 写 `ipc-attachments.spec.ts`（经 MockBackend 往返）**

```typescript
// tests/integration/ipc-attachments.spec.ts
// Task 17:attachments 四通道经 MockBackend 往返（validate/upload/cancel/check）+ 结构化错误（spec §4.5/§4.10 集成）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { if (launched) await closeApp(launched) })

describe('attachments IPC 往返（MockBackend）', () => {
  it('attachmentsValidate 经 IPC 返回 per-file 结果（粘贴 bytes 型）', async () => {
    const res = await launched.page.evaluate(async () => {
      return window.desktopApi.attachmentsValidate({ files: [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'paste', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer }] })
    })
    expect(Array.isArray(res)).toBe(true)
    expect(res[0]).toMatchObject({ localId: 'l1', ok: true })
  })
  it('attachmentsUpload 经 IPC + MockBackend → AttachmentsUploadResponse（AttachmentInfo.kind 权威）', async () => {
    const res = await launched.page.evaluate(async () => {
      return window.desktopApi.attachmentsUpload({ uploadId: 'u1', files: [{ localId: 'l1', name: 'a.png', size: 4, mediaType: 'image/png', source: 'paste', kind: 'image', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer }] })
    })
    expect(res.uploadId).toBe('u1')
    expect(res.attachments).toHaveLength(1)
    expect(res.attachments[0].attachmentId).toMatch(/^att_/)
    expect(res.attachments[0].kind).toBe('image')
    expect(res.attachments[0].mediaType).toBe('image/png')
  })
  it('attachmentsCheck 经 IPC 返回合法 AttachmentMediaStatus（不崩）', async () => {
    const res = await launched.page.evaluate(async () => window.desktopApi.attachmentsCheck('att_1'))
    expect(['ok', 'expired', 'not_found', 'revoked', 'error']).toContain(res.status)
  })
  it('attachmentsCancel 经 IPC 不抛（Mock 无在途上传时 no-op）', async () => {
    await expect(launched.page.evaluate(async () => window.desktopApi.attachmentsCancel('u-none'))).resolves.toBeUndefined()
  })
  it('request 非法 → 结构化错误（SCHEMA_VALIDATION_FAILED）', async () => {
    const err = await launched.page.evaluate(async () => {
      try { await window.desktopApi.attachmentsUpload({ uploadId: 'u', files: [] }); return null }
      catch (e) { return (e as Error).message }
    })
    expect(err).toMatch(/SCHEMA_VALIDATION_FAILED|IPC_ERROR/)
  })
})
```

- [ ] **Step 3: 写 `protocol-media-handler.spec.ts`（媒体代理分支：Range/206、重签重试、document 拒绝、sticker 白名单）**

```typescript
// tests/integration/protocol-media-handler.spec.ts
// Task 17:协议 handler 媒体分支实测（spec §4.4/D1）——launchApp + main 进程 net.fetch 直接命中真实 protocol.handle。
// P2-7：本文件改真集成（不再与 Task 8 media-service.spec 单测重复）——断言的 403/404 决策（host/parseMediaPath/
// MediaService 白名单）都经真实 handler 媒体分支执行；MediaService.stream 的 Range/重签/206 细节由 Task 8 单测覆盖。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { if (launched) await closeApp(launched) })

const fetchStatus = (url: string): Promise<number> =>
  launched.app.evaluate(async ({ net }, u) => {
    try { return (await net.fetch(u)).status } catch { return -1 }
  }, url)

describe('protocol.handle 媒体分支（spec §4.4/D1）', () => {
  it('非 renderer host 的媒体前缀仍 404（host 校验先于媒体路由）', async () => {
    expect(await fetchStatus('cyrene://evil/__cyrene-media/attachment/att_1')).toBe(404)
  })
  it('畸形媒体路径 → 403（parseMediaPath 拒，不落到文件服务）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/att_1/x')).toBe(403)
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/bogus/att_1')).toBe(403)
  })
  it('attachment 分支经 MediaService 决策（非法 attachmentId → 403，非文件服务 404）', async () => {
    // 若媒体分支未接线，该路径会按渲染根文件 404；403 证明 resolveMedia→MediaService.stream 已执行
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/evil')).toBe(403)
  })
  it('sticker id 白名单外 → 403（MediaService.sticker 白名单经 handler 生效）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/sticker/ST_1')).toBe(403)
  })
})
```

> 说明：合法 `attachment/att_1` 在 Mock 装配下签名 URL 指向不可达 `mock.local` → proxyFetch 网络失败 502（P2-4），但其网络耗时依赖环境、不作集成断言（Task 8 单测已覆盖 transient 映射）；happy-path 流式链（Range/206/重签）同样由 Task 8 单测与真实联调兜底。

- [ ] **Step 4: 门禁全量复跑**

Run:
```bash
pnpm -F @cyrene/desktop typecheck
pnpm -F @cyrene/desktop lint
pnpm -F @cyrene/desktop test
xvfb-run -a pnpm -F @cyrene/desktop test:integration
pnpm -F @cyrene/desktop build
pnpm -F @cyrene/desktop check:contract
pnpm -F @cyrene/desktop package
pnpm -F @cyrene/desktop verify:artifact --smoke
```
Expected: 全绿。记录：`check:contract` 13/13（schema 结构不变——`content` 保持 `unknown`，`rawSchemasFingerprintFor` 不下探嵌套元素，实施时实测确认；若指纹意外变化，回查 raw-schemas/rest-schemas 是否被误改）。单测新数字（最终以实际为准）：attachments-contracts 17 + content-part 9 + attachment-policy 13 + attachment-validate 5 + upload-service 3 + media-service 16（含 P2-4 transient 502 用例）+ attachments-handlers 4 + desktop-api-attachments 5 + attachment-state 13 + attachment.store 6 + media-utils 5 ≈ **+96 断言 / 11 新 spec 文件**（rest-mapper/raw-schemas/protocol-csp/dev-csp/navigation/message.store 为既有文件追加）。`test:integration`：23 + 2 新增 = 25（`ipc-attachments` + `protocol-media-handler`——后者为**真集成**，P2-7：launchApp + `net.fetch` 命中真实 `protocol.handle` 媒体分支，不再是与 Task 8 重复的单测）。

- [ ] **Step 5: 文档同步（spec §7）**

1. `docs/02` §19 附件映射行加注：「阶段 3 G3 已开发、未联调（2026-08-14）：上传/签发/媒体代理主路径落地，真实后端附件联调未进行；ContentPart 映射见 spec 2026-08-14-phase3-attachments-media-design」。
2. `docs/06` §7 草稿节：附件状态机枚举确认（selected|validating|ready|uploading|failed|cancelled，省略 uploaded 瞬态），附件队列为内存态。
3. `docs/16` §6：勾选阶段 3 附件相关项 + 追加 G3 落地数字（527 + ~95 断言、23→25 集成、typecheck/lint/build/check:contract 13/13/package/verify:artifact 全绿，标「已开发、未联调」）。
4. `README.md` / `CLAUDE.md`：三态状态源更新——G3 附件与多媒体标「**已开发、未联调**」（真实后端附件联调未进行）；G4 贴图复用本组媒体代理与队列的边界记录。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/tests/integration/helpers/app.ts apps/desktop/tests/integration/ipc-attachments.spec.ts apps/desktop/tests/integration/protocol-media-handler.spec.ts docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md docs/06-Cyrene-前端状态管理与本地存储设计-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md
git commit -m "test(G3 attachment): 集成往返 + 媒体代理决策链 + 门禁全量 + 文档同步（已开发、未联调）"
```

---

## 门禁汇总与三态状态源

- **门禁**（Task 17 已列）：`typecheck` / `lint` / `test`（527 + ~96 新增，11 新 spec + 6 既有追加）/ `test:integration`（23 → 25，`protocol-media-handler` 为真集成——P2-7 改 launchApp + net.fetch 命中 `protocol.handle` 媒体分支）/ `build` / `check:contract`（13/13）/ `package` + `verify:artifact --smoke`（protocol/CSP/装配改动波及打包路径，复跑）。
- **三态状态源**：G3 无真实后端附件联调对象（上传/签发/媒体真实链路未联调）→ 本地门禁全绿 + spike 记录后标「**已开发、未联调**」；不得标「已完成」。真实后端附件联调（docs/16 D-01/D-02/D-03/D-04）通过后再提升三态。
- **开放项（spec §6，不在本组）**：历史/回放附件 name/size/尺寸由 ContentPart 承诺（本批 mapper 已映射）；媒体 `ContentPart.src` 的 id 与 `attachmentId` 一致性待联调确认（适配层优先 attachment_id、src 尾段兜底）；撤销（revoked）wire 指示待联调（以 not_found + 消息删除上下文近似）；上传非幂等（重试产生新 attachmentId，孤儿待后端 GC，P2）；文件保存到磁盘（D-08 P2）；断点续传（后端无续传语义）；上传字节级进度（undici/fetch 无进度事件，D10 阶段态 + 不确定 spinner）；队列内存态（重启不恢复）；**流式 assistant 媒体分段无 attachmentId（raw 流式 schema 无该字段，P2-5，wire 契约）→ 实时媒体分段退化为 `[kind 分段]` 占位，待后端在流式帧提供附件标识后补齐（联调项，不当作完成）**。

---

## Spec 覆盖对照表（自审 1）

| Spec 条目 | 任务 |
|---|---|
| §2 范围（点击/拖拽/粘贴共用状态机、上传、媒体代理、呈现、模型扩展） | Task 4/7/8/13/14/15/16 |
| §3.1 缺口表 12 行 | Task 1（message）、2（ipc/contracts）、4（content-part/mapper）、7（UploadService）、8（MediaService）、9（handler/CSP/导航）、11（preload） |
| §3.2 技术约束（CSP G-9 / 信任边界 D5 / webUtils / 后端契约 / spike） | Task 9（CSP/spike）、11（webUtils/path 隔离）、5（后端契约）、8（sticker 白名单） |
| §4.1 D1 通用媒体代理 + CSP 最小增量 | Task 8/9 |
| §4.1 D2 附件内嵌 Message | Task 1 |
| §4.1 D3 上传/发送两段 IPC + batch 原子 | Task 3/5/7/10/12/14 |
| §4.1 D4 状态机（省略 uploaded） | Task 2/13/14 |
| §4.1 D5 路径隔离 | Task 11 |
| §4.1 D6 签名与媒体状态 | Task 8/15（checkStatus 分类占位） |
| §4.1 D7 ContentPart 建模 + mapper | Task 1/4（schema 保持 unknown，映射层建模） |
| §4.1 D8 链接卡（复用既有策略） | Task 15（CyLinkAttachment，无新 IPC） |
| §4.1 D9 呈现（图片/视频音频图标卡/文件） | Task 15 |
| §4.1 D10 进度与取消 | Task 7/14/15（spinner + AbortController） |
| §4.2 领域模型/队列/IPC 契约 | Task 1/2/3 |
| §4.3 状态机 + 发送阻断 | Task 13/14 |
| §4.4 数据流（添加校验/发送编排/媒体加载） | Task 7/14/15/16 |
| §4.5 Main 服务与 IPC | Task 6/7/8/10 |
| §4.6 Renderer 侧（store/队列/覆盖层/媒体分发/输入区/气泡） | Task 13/14/15/16 |
| §4.7 呈现与状态占位表 | Task 15（CyAttachmentPlaceholder） |
| §4.8 错误处理与取消 | Task 7/8/14 |
| §4.9 安全要点 | Task 8/9/11 |
| §4.10 测试计划 | Task 1-17 各单测 + Task 17 集成 |
| §5 验收 5 项 | Task 13/14（状态机）、15（呈现）、11/17（路径不泄漏断言）、7/14（取消）、17（门禁 + 三态标记） |
| §6 已知限制（记录） | 开放项清单见上（不实现，文档记录） |
| §7 文档同步 | Task 17 Step 5 |
| G4 边界（贴图复用媒体代理/队列） | Task 2（PendingSticker）、8（sticker 分支）、14（addSticker）、15（队列渲染）、16（非目标记录） |
