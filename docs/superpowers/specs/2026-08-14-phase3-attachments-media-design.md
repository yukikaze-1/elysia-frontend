# Cyrene 阶段 3 G3 spec：附件与多媒体设计

**日期：** 2026-08-14
**依据：** docs/02 §11/§19（附件契约：AttachmentInfo / AttachmentRef / 上传 / 签名下载 / sha256 后端不回传）、docs/03 §8.2/§8.3（附件条目与输入区）、docs/06 §7（拖拽附件 PendingAttachment）、docs/01 §6.2/§6.3（DesktopApi 面 / 拖拽文件进程边界）、docs/07（Renderer 信任边界与 CSP）、docs/12 §4.4（D-01~D-04）、docs/16 §6（阶段 3 验收门槛）
**范围：** Electron 阶段 3「G3 附件与多媒体」——点击/拖拽/粘贴共用附件校验与待发送队列、上传（Main BackendAdapter 中转）、媒体加载（CSP 约束下的呈现/播放）、错误/过期/撤销占位、上传取消
**目的：** 落地「拖拽只进待发送队列不自动上传/发送」「图片/视频/音频可预览/播放、失败/过期可解释」「绝对本地路径不泄漏」「上传取消/撤销路径完整」四项验收门槛，形成可实施的附件与多媒体设计。完成后仍按三态状态源标记（真实后端附件联调未进行前为「已开发、未联调」）。
**决策：** 本批决策由我按推荐定案并记录（用户已授权自主执行）——D1（媒体加载 = **通用媒体代理** 同源自定义协议 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（mediaType ∈ {attachment, sticker}）由 Main 按类型分派（attachment 流式签名代理 / sticker 静态代理）+ CSP 最小增量）、D2（附件领域模型内嵌 Message）、D3（上传与发送分离两段 IPC + batch 原子 + 每文件 kind）、D4（附件状态机全源统一，省略 `uploaded` 瞬态）、D5（上传传输路径隔离：webUtils 路径型 + 粘贴 bytes 型）、D6（签名 URL 由 Main 持有/按需签发/过期重签 + `attachments:check` IPC 分类状态）、D7（ContentPart 建模 + mapper 映射为主路径，修正「`.strict()` 整条拒绝」前提）、D8（链接复用既有导航策略，无新 IPC）、D9（图片原生预览 / 视频音频图标卡+点击展开播放 / 文件图标卡，不引入缩略图库）、D10（上传进度不确定化 + AbortController 取消）。
**文档状态：** v2 定稿（code-review 视角自审两轮闭环：第一轮发现并修正——dev 跨源下 Renderer `fetch(cyrene://)` 探针因 `corsEnabled:false` 得 opaque/status 0 而分类失效 → 改用 `attachments:check` IPC（D6/4.4/4.7 全同步）、dev CSP 去多余的 `connect-src cyrene:`；第二轮全文重读修正——D6 摘要与 4.8/§6 残留「探针」术语、窄接口方法数 3→4、UploadService 补 `fs.stat` 复验与日志脱敏）。**v3 评审修订轮次（2026-08-14，独立评审 1 P1 契约前提 + 1 P1 协议冲突 + 4 P2）**：P1-1 修正 D7 契约前提——两 schema `content` 均为 `z.unknown().optional()`，媒体 ContentPart 本可过 `.strict()` 解析，不存在「整条拒绝」缺口，真实缺口是映射层 `extractText` 丢媒体；D7 改为 ContentPart 建模 + mapper 映射为主路径，schemaHash/check:contract 13/13 结论保留但改为正确推理（指纹不下探嵌套元素）。P1-2 媒体协议统一（用户已锁定）：`cyrene://renderer/__cyrene-media/{mediaType}/{id}` 通用机制（mediaType ∈ {attachment, sticker}），G4 贴图为消费方，复用既有 `cyrene://` 注册（无新 scheme）+ 导航 deny + Sec-Fetch-Dest 防护；同步 CSP 设计（prod 同源 img-src `'self'` 即放行、dev 三处加 `cyrene:`）与 §7。P2 四项：历史/回放附件 name/size/尺寸由 ContentPart 承诺（P2-1）、`uploaded` 瞬态省略对齐 docs/06 §7 枚举（P2-2）、批量上传按文件 kind 且 AttachmentInfo.kind 权威（P2-3）、G3 待发送条目类型增 `PendingSticker` 分支供 G4 复用（P2-4）。

---

## 1. 背景与目标

阶段 3 主线自 2026-08-14 起（B-01 已真实联调封口）。本组（G3）覆盖 docs/16 §6 中「点击/拖拽/粘贴共用的附件校验与待发送队列（拖拽不自动上传/发送）」与「图片、视频、音频、文件、链接与错误/过期状态」两块任务，对应后端契约 D-01（上传）/ D-02（签名下载）/ D-03（MIME/编解码矩阵，已确认；**缩略图后端不提供**）/ D-04（拖拽粘贴限额，已确认沿用后端数值）。

**目标**（对照 docs/16 §6 验收门槛）：
- 点击选择、拖拽、粘贴进入**同一附件状态机**，仅 `source` 不同；**拖拽/粘贴只创建待发送附件条目，绝不自动上传或发送**；
- 图片原生缩放内联预览；视频/音频可播放；文件图标卡（名称/大小/类型）；失败/过期/撤销/不支持有**可解释占位**；
- **绝对本地路径永不进后端、永不进 Renderer Store**（Main 转为不透明资源句柄后仅用于读盘上传）；
- 上传取消/撤销路径完整。

**非目标（本批不做，记录）**：缩略图生成（锁定决策：不引入缩略图库）；表情包贴图（另一组 G4；贴图复用本组通用媒体代理 `__cyrene-media/sticker/{stickerId}` 静态分支与待发送队列，非附件、无签名，业务语义由 G4 完成）；资源/附件保存到磁盘（D-08 为 P2）；统一聊天历史查看器（另一组，复用本批附件领域模型）；会话级草稿持久化（另一组「每会话草稿」，本批附件队列为内存态）。

## 2. 范围（本批 vs 后续）

**本批做**：
- 点击/拖拽/粘贴收集浏览器 `File` 对象 → 待发送队列（同一状态机，仅 source 不同）；拖拽覆盖式虚线投放区与逐项解释（目录/超量/不支持类型）；
- Main 校验链：数量/大小/类型 → 路径与符号链接 → 敏感范围 → 生成句柄（docs 01 §6.3）；
- 上传：批量 multipart `POST /api/uploads`（`files[]`，**每文件 kind**，可省略由后端魔数判定；AttachmentInfo.kind 权威），≤10 文件 / 聚合 64MB / 单文件 10/50/20/20MB / 魔数嗅探（后端权威）；取消经 AbortController；
- 发送编排：上传成功后随 WS `text` 消息携带 `attachments: AttachmentRef[]`，复用既有 ack/乐观消息路径；
- 媒体加载：**通用媒体代理** `cyrene://renderer/__cyrene-media/{mediaType}/{id}`（mediaType ∈ {attachment, sticker}）由 Main 按 mediaType 分派——attachment 流式签名代理（签名 URL 持有/按需签发/过期重签，Range/206 透传）、sticker 静态代理（`/static/stickers/{stickerId}.png`，无签名），CSP 最小增量；
- 呈现：图片原生预览；视频/音频图标卡+点击展开内联播放；文件图标卡；链接卡片（复用既有外部打开策略）；错误/过期/撤销/不支持占位；
- 消息/分段附件领域模型扩展与 wire 映射（REST + WS 回放）。

**本批不做**：
- 后端侧改动（后端契约已就绪：`POST /api/uploads`、`GET /api/attachments/{id}/sign`、`GET /api/attachments/{id}?sig=&exp=`）；
- 缩略图/封面（后端不提供，不引库，视频音频恒图标卡）；
- 文件「保存到磁盘」下载交互（D-08，P2）；
- 表情包/贴纸发送（另一组）；
- 会话资源页/历史查看器（另一组，复用 `ConversationResource` 领域模型时再落地 REST `GET /api/sessions/{id}/resources`）；
- 断点续传（后端无续传语义）；
- 上传字节级进度（undici/fetch 无上传进度事件，见 D10）。

**G4 边界（锁定决策，2026-08-14）**：表情包贴图（另一组 G4）**复用本组的通用媒体代理与待发送队列**——贴图不是附件（无 attachmentId/上传/签名），走 `__cyrene-media/sticker/{stickerId}` 静态分支（stickerId 白名单 `^st_[A-Za-z0-9-]+$`、MIME 白名单 image/png、无签名）；本批仅在队列条目类型（4.2 `PendingSticker`）与媒体代理（4.4/4.5 sticker 分支）中预留承载点，贴图业务语义（选包/发送/呈现）由 G4 完成。

## 3. 现状与技术约束

### 3.1 现状（关键位置与缺口证据）

| 位置 | 现状 | 缺口（本批处理） |
|---|---|---|
| `src/renderer/src/components/CyChatInput.vue` | 纯文本 textarea + 发送/停止；无文件按钮、无拖拽、无粘贴、无附件条目 | 需加文件选择按钮、拖拽覆盖层、粘贴收集、待发送队列条目区与发送编排 |
| `src/renderer/src/stores/message.store.ts` | `send(text)` 只造 `content` 乐观用户消息；`Message` 无附件字段 | `send` 需接受附件；乐观消息携带 `attachments` |
| `src/shared/contracts/message.ts` | `Message` 无 `attachments`；`AssistantSegment` 无媒体引用字段 | 扩展领域模型（D2） |
| `src/shared/contracts/backend.ts` / `ipc.ts` | 无上传/附件通道；`SendMessageInput` 无 `attachments` | 新增 IPC 通道与 `SendMessageInput.attachments`（D3） |
| `src/main/transport/real-backend.ts` | `restFetch` 仅 JSON（固定 10s 超时、`content-type: application/json`）；无上传/签发方法 | 新增 multipart 上传与签名 REST 方法；上传需更长超时/取消 |
| `src/main/transport/backend-adapter.ts` | 接口无附件方法 | 扩展 `uploadAttachments` / `signAttachmentUrl` |
| `src/main/transport/protocol-v2/rest-schemas.ts` | `RestMessageSchema` `.strict()`，`content` 为 `unknown`，无 `attachments`/媒体 parts | 媒体 ContentPart 在 `content`（unknown）**本可过 `.strict()` 解析**（不存在「整条拒绝」缺口）；真实缺口在**映射层**——`extractText` 只提取文本，媒体 parts 被丢弃（D7 改为 ContentPart 建模 + mapper 映射） |
| `src/main/transport/protocol-v2/raw-schemas.ts` | `RawSessionMessageItemSchema` `.strict()`，`content` 为 `unknown`，无 `attachments` | 同上——`content` 本可放行媒体 ContentPart，真实缺口为映射层丢媒体（D7） |
| `src/main/transport/protocol-v2/rest-mapper.ts` | `assemble` 只提取文本，忽略媒体 | 映射媒体 parts → 分段 + 附件（D7） |
| `src/main/protocol/handler.ts` | `cyrene://` 只服务渲染根文件，`url.host !== RENDERER_HOST → 404` | 增 `__cyrene-media/{mediaType}/{id}` 分支（D1，dev/prod 都注册）；导航防越界（见 3.2） |
| `src/main/protocol/csp.ts` | `buildRendererCsp()` 无 `media-src`（默认回落到 `default-src 'none'` → 视频/音频全被挡） | 增 `media-src 'self'`（D1）；prod 文档同源 cyrene://renderer，`img-src 'self'` 同源即放行 |
| `src/main/config/dev-csp.ts` + `index.html` meta | dev CSP 无 `media-src`，`img-src` 无 `cyrene:` | dev 三处加 `cyrene:`——`buildDevCsp()` 的 `media-src`、`img-src` 与 index.html meta 同步（AND 取交集，G-9） |
| `src/main/windows/main-window.ts` | `will-navigate` / `setWindowOpenHandler` 已把 http/https 外部链接交给 `shell.openExternal`（deny 内导航） | 链接打开复用；`classifyNavigation` 需把 `__cyrene-media/*` 前缀导航判 deny（attachment/sticker 均 deny，防媒体字节作顶层文档） |
| `src/main/index.ts:194-197` | `registerCyreneProtocolHandler` 仅在非 dev 注册 | 媒体分支需 dev/prod 都注册（dev 页面在 Vite http，媒体 URL 在 cyrene://） |

### 3.2 技术约束

- **CSP（docs 07 §101-102，阶段 1 块 A 已落地）**：prod 严格头由 `buildRendererCsp()` 产出，与 index.html meta **AND 取交集、严格头胜出**（G-9：改 dev meta 会静默改变 prod 有效策略——本批 **prod 头与 meta 必须同步**）。`default-src 'none'`、`img-src 'self' data:`、`connect-src 'self'`、无 `media-src`。**Renderer 不直连带凭据后端**（docs 01/07），远程资源先验证协议/域名/大小/MIME/鉴权再交给 Renderer（docs 07 §101）。由此：
  - Renderer `<img>/<video>` 直连后端签名 URL 需要 `img-src`/`media-src` 放开后端 host（后端地址用户可配、URL 带 `?sig=` 参数）→ 违反「任意 host 不得 CSP 裸放行」与信任边界 → **否决直连方案**（见 D1 论证）。
  - 媒体必须经 Main 代理；自定义协议 `cyrene://` 是 Main 独占的闭集合（非任意 host），可放行。
- **信任边界（docs 01 §6.3 已明确）**：Renderer 的 Drop/Paste 只收集浏览器 `File` 对象与展示待发送 UI；取真实磁盘路径由 Preload `webUtils.getPathForFile(file)` 完成并**立即交 Main 转不透明资源句柄**；Renderer 业务 Store 不保存/不向后端发送绝对路径；不得暴露「路径转文件/按路径读取」接口。浏览器内构造的 pathless `File`（粘贴）只能按内存附件处理。
- **`webUtils` 在 sandbox preload 可用**（Electron `webUtils` 属 preload 白名单模块）；`getPathForFile` 对 JS 构造的 `new File(...)` 返回空串（**只有用户真实选择/拖入的文件才有路径**——安全属性，防注入任意路径）。
- **后端契约（`/home/yomu/elysia-agent/frontend_contract` 已挂载核实）**：
  - `POST /api/uploads`（multipart `files[]` + `kind`?，**kind 按文件携带**，可省略由后端魔数真值判定）→ `AttachmentUploadResponse{attachments: AttachmentInfo[]}`；`AttachmentInfo{attachmentId(att_), kind, mime, size, url(/api/attachments/{id}), signedUrl?(可缺省), filename(脱敏)}`；**sha256 后端不回传**（docs 02 §19 确认）；
  - 签发 `GET /api/attachments/{id}/sign`（Bearer）→ `AttachmentSignResponse{attachmentId, url(短期签名 URL), expiresAt}`；下载 `GET /api/attachments/{id}?sig=&exp=`（免 Bearer，Range/206）；
  - WS 消息携带 `attachments: AttachmentRef{attachmentId, kind, mime}[]`（kind/mime 为**客户端提示值**，服务端以记录为准）；媒体 `ContentPart`（Image/Video/Audio/FilePart）带 `src(/api/attachments/{id})`、`mime`、`attachment_id?`、`width/height/duration_ms/filename/size_bytes?`；
  - **消息级 `AttachmentRef`（WS 发送路径的客户端提示值）仅 attachmentId/kind/mime（无 name/size）**——但发送路径 name/size 由上传响应 `AttachmentInfo` 补全；**历史/回放消息的媒体 ContentPart 携带 `filename`/`size_bytes`/`width`/`height`/`duration_ms`**，历史附件 name/size/尺寸由 mapper 从 ContentPart 映射，不缺失（见 D7）。
  - **G4 贴图（锁定决策，复用本组机制）**：`__cyrene-media/sticker/{stickerId}` 代理后端静态 `/static/stickers/{stickerId}.png`；stickerId 白名单 `^st_[A-Za-z0-9-]+$`、MIME 白名单 image/png、**无签名**（不签发/不缓存签名 URL，无过期重签）。
- **CSP + 媒体方案风险（spike 门）**：`<video>/<audio>` 经自定义 scheme + `protocol.handle`（`stream: true`）播放需在实施首个任务 spike 验证；同源 `__cyrene-media/{mediaType}/{id}` 方案为**锁定决策**（复用既有 `cyrene://` 注册，无新 scheme；原「独立 host `cyrene://media/...`」备选已关闭）。
- **上传无字节级进度**：undici/fetch 无上传进度事件 → 进度用阶段态 + 不确定 spinner（D10）。
- **现有导航策略**：`will-navigate`/`setWindowOpenHandler` 已把 http/https 交给 `shell.openExternal`；`classifyNavigation` 只放行 `cyrene://` 的 `RENDERER_HOST`；markdown 净化已剥 `javascript:/data:/vbscript:`（`renderer/src/utils/markdown.ts`）——链接打开复用，无新 IPC（D8）。
- **MockBackend 需扩展**：本批上传/签发/媒体需 Mock 可测（确定性 AttachmentInfo + 假签名 URL），MockBackend 增加对应方法。

## 4. 设计

### 4.1 决策总表

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 媒体加载路径与 CSP | **通用媒体代理**：Renderer 经**同源自定义协议** `cyrene://renderer/__cyrene-media/{mediaType}/{id}` 加载（mediaType ∈ {attachment, sticker}），Main `protocol.handle` 内新增媒体分支按 mediaType 分派——`attachment/{attachmentId}` 流式代理后端签名下载（Range/206 透传、签名 URL 持有/按需签发/过期重签一次重试）；`sticker/{stickerId}` 代理静态 `/static/stickers/{stickerId}.png`（stickerId 白名单 `^st_[A-Za-z0-9-]+$` + MIME 白名单 image/png，无签名、不缓存签名 URL）。**复用既有 `cyrene://` scheme 注册（无新 scheme）**，继承导航 deny + `Sec-Fetch-Dest` 防护。CSP 增量：prod 文档同源 cyrene://renderer，`img-src 'self'` 同源即放行、增 `media-src 'self'`；dev（http://localhost）`buildDevCsp()` 与 index.html meta 同步**三处加 `cyrene:`**（`media-src`、`img-src` 及 meta；媒体元素加载受 `img-src`/`media-src` 约束，**connect-src 不动**） | 信任边界（Renderer 不直连带凭据后端/不碰签名 URL）；CSP 不放行任意 host、只放行自管 scheme；同源媒体无 CORS/兼容风险最低；签名过期可由 Main 透明刷新；G4 贴图复用本机制（锁定决策） |
| D2 | 附件领域模型 | `Message` 增 `attachments?: MessageAttachment[]`；`AssistantSegment` 增媒体引用字段；附件**内嵌消息**而非独立实体 | 与后端 wire（附件挂在消息 `attachments`/`ContentPart`）一致；渲染只需消息上下文；独立实体会引入二次查询与一致性问题 |
| D3 | 上传与发送编排 | 两段 IPC：`attachments:upload`（批量 multipart → `UploadedAttachment[]`）+ `chatSend` 扩展 `attachments`（**已上传**的 refs）。发送按钮编排：ready 队列 → 批量上传 → 乐观消息带附件 → WS send 带 refs → ack。**batch 原子**（全成或全不成）。**kind 按文件携带**（`files[]` 每文件一个 kind，可省略由后端魔数判定；`AttachmentInfo.kind` 权威） | 复用既有 send/ack/乐观路径；上传可取消/重试；与 `POST /api/uploads files[]` 一次批量契约一致（kind 为可选、后端真值校验）；上传超时不占 ack 15s 窗口；异构批次不被整批单 kind 约束 |
| D4 | 附件状态机 | `PendingAttachment.status: selected → validating → ready → uploading →（上传成功即进入发送编排，乐观消息携带 attachments 后清出队列）`；`failed`（含 reason）/ `cancelled` 终态。**省略 `uploaded` 瞬态**（docs/06 §7 枚举 selected|validating|ready|uploading|failed|cancelled 无此态；上传成功不驻留独立状态，直接衔接发送编排）。点击/拖拽/粘贴仅 `source` 不同；拖拽/粘贴只建条目，不自动上传/发送 | docs 03 §8.3 / docs 06 §7；单源队列满足验收「拖拽只进待发送队列」；状态枚举与既有文档一致 |
| D5 | 上传传输与路径隔离 | 路径型（pick/drop）：Preload `webUtils.getPathForFile` → IPC path → Main 直读磁盘（零拷贝）；粘贴型（pathless）：Renderer 读 `ArrayBuffer` → IPC bytes。**路径只在 Preload/Main 内流转，绝不回传 Renderer、不入 store、不进后端** | docs 01 §6.3 明确；`getPathForFile` 只对真实用户文件有路径，防注入 |
| D6 | 签名 URL 与媒体状态 | Main `MediaService` 缓存 `signedUrl+expiresAt`，到期前 5min 视为过期经 `/sign` 重签；流式 401/403 重签一次重试；仍失败返回 410。Renderer 在媒体元素 `error` 时经 **`attachments:check` IPC**（Main 重签后 Range-0 探测后端）分类 `ok/expired/not_found/revoked/error` 映射可解释占位。**不用 Renderer `fetch(cyrene://...)` 探针**（dev 页面在 http://localhost，cyrene:// 跨源且 scheme `corsEnabled:false` → 探针得 opaque/status 0，分类失效） | 签名 URL 不落 Renderer；过期透明刷新；分类只在出错时跑（成功加载零额外开销）；IPC 分类在 dev/prod 一致可靠 |
| D7 | 契约扩展与 wire 映射 | 主路径 = **ContentPart 建模 + mapper 映射**。挂载契约回放/归档消息**无消息级 `attachments` 字段**（SessionMessageItem 仅 `content: str | list[ContentPart]`；`messages_for_client()` 只发 role/parts/content/message_id/timestamp；REST Message 仅 content: Any），媒体 ContentPart 在 `content`（两 schema 均为 `z.unknown().optional()`）**本可过 `.strict()` 解析——不存在「整条拒绝」缺口**；真实缺口是**映射层丢媒体**（`extractText` 只提取文本）。方案：rest/frame-mapper 从 ContentPart 提取 attachment_id/kind/mime/filename/size_bytes/width/height/duration_ms 映射为领域 `MessageAttachment`/媒体分段（schema 保持 `content: unknown`，建模在映射层，不改 schema 结构）；`SendMessageInput.attachments`。schemaHash 不受影响（`rawSchemasFingerprintFor` 指纹**不下探嵌套元素**——array/record 等嵌套字段只取浅层 `_def` 签名，新增嵌套字段不改变指纹，实施时实测确认）；check:contract 保持 13/13（映射为 optional 消费，fixture 不变） | 对齐真实 wire（无消息级 attachments、content 过解析）；修复映射层丢媒体 |
| D8 | 链接呈现 | `CyLinkAttachment` 卡片（label + URL，仅展示 http/https）；打开外部复用既有 `will-navigate`/`setWindowOpenHandler → shell.openExternal`（deny 内导航），**无新 IPC** | docs 01/07 链接策略已就绪；markdown 净化已剥危险协议 |
| D9 | 呈现（缩略图已锁定） | 图片：内联 `<img>` 原生缩放预览；视频/音频：**图标卡（名称/大小/类型）为收起态，点击展开内联 `<video controls>`/`<audio controls>` 播放**；文件：图标卡展示（P0 不下载，D-08 P2）；错误/过期/撤销/不支持：可解释占位。**不引入缩略图库** | 锁定决策 + docs/16 验收「可预览/播放」的调和（图标卡+按需播放） |
| D10 | 上传进度与取消 | 进度 = per-file 阶段态 + 不确定 spinner（undici 无上传进度事件）；取消 `attachments:cancel {uploadId}` → Main `AbortController.abort()` 批量终止，IPC 以 cancelled 错误 reject | 务实取舍；batch 契约下一次调用 |

### 4.2 领域模型（`src/shared/contracts/message.ts` 扩展）

```ts
/** 附件类别（链接为资源级类别，不参与上传 kind） */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'link'

/** 已发送消息携带的附件（上传响应/媒体分段映射而来）；name/size/尺寸：上传响应与历史/回放 ContentPart 均提供，字段仍 optional 兜底 */
export interface MessageAttachment {
  attachmentId: string            // att_ 前缀（后端权威）
  kind: AttachmentKind
  mediaType: string               // MIME
  name?: string                   // 上传响应 AttachmentInfo.filename 有；历史/回放经 ContentPart.filename 映射（optional 兜底）
  size?: number                   // 上传响应 AttachmentInfo.size 有；历史/回放经 ContentPart.size_bytes 映射（optional 兜底）
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

`Message` 增 `attachments?: MessageAttachment[]`；`AssistantSegment` 增：

```ts
export interface AssistantSegment {
  segmentId: string
  segmentIndex: number
  channel: SegmentChannel
  kind: SegmentKind              // 既有：含 image/video/audio/file/link
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

`SendMessageInput` 增 `attachments?: MessageAttachmentRef[]`。

**待发送队列条目（G3 附件 + G4 贴图复用本队列；见 4.3 与 §2 G4 边界）：**

```ts
export type PendingSendItem = PendingAttachment | PendingSticker

/** G3 附件条目（状态机见 4.3；省略 uploaded 瞬态，见 D4） */
export interface PendingAttachment {
  kind: 'attachment'
  localId: string
  name: string
  size: number
  mediaType: string
  source: 'picker' | 'drag_drop' | 'paste'
  status: 'selected' | 'validating' | 'ready' | 'uploading' | 'failed' | 'cancelled'
}

/** G4 表情包贴图挂入本队列的最小分支（sticker 非附件：无 attachmentId/上传/签名；经本组 __cyrene-media/sticker/{stickerId} 加载，见 §2 边界） */
export interface PendingSticker {
  kind: 'sticker'
  stickerId: string        // ^st_[A-Za-z0-9-]+$（白名单，后端静态 /static/stickers/{stickerId}.png）
  name?: string
  status: 'ready'          // 贴图无校验/上传阶段，入队即 ready
}
```

**IPC 契约（`src/shared/contracts/ipc.ts` + `src/shared/schemas/ipc-response.ts` 镜像）：**

```ts
// IpcChannels 新增
attachmentsValidate: 'attachments:validate',
attachmentsUpload: 'attachments:upload',
attachmentsCancel: 'attachments:cancel',
attachmentsCheck: 'attachments:check',

// 上传文件描述符（Renderer→Preload 携带 file?/bytes?；Preload 以 webUtils 注入 path；IPC 至 Main 时 path?/bytes? 二选一）
interface UploadFileDescriptor {
  localId: string
  name: string
  size: number
  mediaType: string
  source: 'picker' | 'drag_drop' | 'paste'
  path?: string      // 仅 Preload 注入；Renderer 永不构造
  bytes?: Uint8Array // 仅粘贴型（pathless）
}

// 校验结果（per-file）
interface FileValidationResult { localId: string; ok: boolean; kind?: AttachmentKind; reason?: string; message?: string }

// 上传响应
interface AttachmentsUploadResponse { uploadId: string; attachments: MessageAttachment[] }

// 媒体状态分类（元素 error 后按需查询）
type AttachmentMediaStatus = 'ok' | 'expired' | 'not_found' | 'revoked' | 'error'
interface AttachmentCheckResult { status: AttachmentMediaStatus; reason?: string }

// request schema
const attachmentsValidateSchema = z.object({ files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
const attachmentsUploadSchema = z.object({ uploadId: z.string().min(1), files: z.array(UploadFileDescriptorSchema).min(1).max(10) })
const attachmentsCancelSchema = z.object({ uploadId: z.string().min(1) })
const attachmentsCheckSchema = z.object({ attachmentId: z.string().min(1) })
```

Preload `DesktopApi` 新增（Renderer 面）：

```ts
attachmentsValidate(input: { files: Array<{ localId; name; size; mediaType; source; file?: File; bytes?: ArrayBuffer }> }): Promise<FileValidationResult[]>
attachmentsUpload(input: { uploadId: string; files: Array<{ localId; name; size; mediaType; source; file?: File; bytes?: ArrayBuffer }> }): Promise<AttachmentsUploadResponse>
attachmentsCancel(uploadId: string): Promise<void>
attachmentsCheck(attachmentId: string): Promise<AttachmentCheckResult>
```

Preload 实现内部把每个 `file`（真实路径）经 `webUtils.getPathForFile(file)` 换成 `path`；path 为空串的 `file` 视为 pathless，要求渲染层已传 `bytes`。**path 不进入 contextBridge 返回面**（仅作为 ipcRenderer.invoke 入参）。

### 4.3 附件状态机（Renderer `attachment.store.ts`，纯逻辑可单测）

```
add (pick/drop/paste, 仅 source 不同)
  │  metadata(File.name/size/type) + 客户端预检(数量≤10/聚合≤64MB/种类限额)
  ▼
selected ──validate(files)→ validating ──ok──▶ ready
   │                              └──fail──▶ failed(reason, 逐项解释)
   │  remove ────────────▶ cancelled(终态)
ready ──send 编排──▶ uploading(批量) ──ok──▶ (发送编排：乐观消息携带 attachments → 清出队列)
   │                    │
   │                    └──fail──▶ failed / cancel──▶ cancelled
   └──remove──▶ cancelled
```

规则：
- **拖拽/粘贴/点击只创建条目**；上传仅在用户按发送后发生（docs 03 §8.3）；逐项展示名称/类型/大小/状态/错误原因/移除按钮；
- 发送条件：队列全为 `ready`（或已移除）；存在 `validating` 时发送自动等待；存在 `failed` 时发送按钮给出「请移除失败附件」提示并阻断（batch 原子，D3）；`uploading` 期间禁止移除；
- 队列为**内存态**，重启不恢复（docs 06 §7「上传中的临时句柄在重启后不自动恢复」）；File 引用/粘贴 bytes 不落 store 序列化面（Pinia store 仅持引用与元数据）；
- **G4 贴图复用本队列**：`PendingSticker{kind:'sticker'}` 挂入待发送队列（入队即 `ready`，无校验/上传阶段）；发送编排随 WS text 携带 stickerId；呈现经 `__cyrene-media/sticker/{stickerId}`；附件数量/大小/魔数限额与状态转移对贴图分支不适用（见 4.2/§2 G4 边界）；
- 状态机为纯函数（`transition(state, action) → state`），与 Vue 解耦、可单测（docs 16「同源状态机」验收）。

### 4.4 数据流

**添加与校验（添加时）：**
1. `CyChatInput` 统一入口 `onFilesAdd(files, source)`（pick=`<input type=file multiple>`；drop=dragover 覆盖层 + drop；paste=`paste` 事件 `clipboardData.files`）——仅 `source` 不同；
2. `attachment.store.addFiles(files, source)`：客户端预检（数量≤10 / 聚合≤64MB / 按 MIME 估种类限额）→ 建 `selected` 条目（paste 条目预读 `ArrayBuffer` 存引用）；
3. `api.attachmentsValidate`（Preload 注入 path）→ Main `UploadService.validateFiles`：数量/大小/类型 → 路径 realpath + 普通文件（复用 safe-open 平台，拒 FIFO/socket/设备/目录，POSIX `O_NONBLOCK`）→ 敏感范围（拒 `expectedUserDataBase()` 内含路径及凭据文件）→ MIME→kind 矩阵 + 轻量魔数嗅探 → 逐项结果；Renderer 逐项置 `ready`/`failed(reason)`。

**发送编排（发送时，`messageStore.send(text, {attachments})` 前置）：**
1. `attachment.store` 收集 `ready` 条目 → 批量 `api.attachmentsUpload({uploadId: crypto.randomUUID(), files})`（Preload 注入 path / 粘贴 bytes）；
2. Main `UploadService.uploadBatch`：读盘/取 bytes → multipart `POST /api/uploads`（`files[]`，**每文件 kind**，可省略由后端魔数判定）→ `AttachmentInfo[]` → 领域 `MessageAttachment[]`（以 `AttachmentInfo.kind` 权威为准）；超时用上传专用长超时（非 10s）；AbortController 挂起，`attachmentsCancel` 可中止；
3. 成功后：`messageStore.send(text, { attachments })` 造乐观 `Message{content, attachments, status:'pending'}`，`api.send({conversationId, text, clientRequestId, attachments: refs})` → adapter 映射 wire `attachments: [{attachmentId, kind, mime}]` → WS `text` 消息 → `user_message.ack`（既有路径）；ack 后 migrateKey，队列清出；
4. 失败：batch 上传失败 → 逐文件 `failed`（reason 可解释）；WS 发送失败 → 乐观消息 `failed`（既有）；已上传孤儿附件留待后端 GC（P2，记录）。

**媒体加载（渲染）：**
1. 渲染层构造 `cyrene://renderer/__cyrene-media/{mediaType}/{id}`：G3 附件 `attachment/{attachmentId}`；G4 贴图 `sticker/{stickerId}`（队列条目渲染经此 URL）；
2. 图片 `<img>` 直接加载；视频/音频点击图标卡后挂 `<video>/<audio controls>`；元素 `error` 时经 **`api.attachmentsCheck(attachmentId)`**（Main 重签后 Range-0 探测）→ 按返回状态（expired/not_found/revoked/error）→ 对应占位 + 重试/刷新动作；成功加载不产生额外请求（sticker 分支无签名/无过期，不查 checkStatus）；
3. Main 媒体分支：先校验 `mediaType` 白名单（`attachment`/`sticker`）。`attachment/{attachmentId}`：attachmentId 格式校验（`^att_[A-Za-z0-9_-]+$`，解码一次）→ `MediaService.resolveSignedUrl`（缓存/重签）→ `fetch` 后端签名 URL 并透传 `Range`/`Accept`，`request.signal` 接 abort → 后端 200/206 直通；401/403 重签一次重试，仍失败返 410；404 返 404。`sticker/{stickerId}`：stickerId 白名单（`^st_[A-Za-z0-9-]+$`）+ MIME 白名单（image/png）→ 代理静态 `/static/stickers/{stickerId}.png`（无签名、无重签）。两分支均拒绝 `Sec-Fetch-Dest: document`（防媒体字节作顶层文档）。

### 4.5 Main 侧服务与 IPC

- **`UploadService`（`src/main/attachments/upload-service.ts`）**：`validateFiles(descriptors)` / `uploadBatch(uploadId, descriptors, {signal})`；依赖 `AttachmentUploadBackend`（见下）+ `send` 进度回调（本批进度仅为阶段态，push 可选）；魔数嗅探表（小表：常见 image/video/audio 签名）。**uploadBatch 上传前以 `fs.stat` 复验实际大小与限额、路径仍为普通文件（防 Renderer 伪造描述符/队列状态漂移）**；上传 IPC 请求日志脱敏（不记 path/name 原文）。
- **`MediaService`（`src/main/attachments/media-service.ts`）**：`resolveSignedUrl(attachmentId, {force}) → {url, expiresAt}`（缓存，exp−5min 视为过期重签）；`stream(mediaType, id, request) → Response`（attachment 分支：重签重试；sticker 分支：stickerId 白名单 `^st_[A-Za-z0-9-]+$` + MIME 白名单 image/png，静态代理 `/static/stickers/{stickerId}.png`，无签名/无重签）；`checkStatus(attachmentId) → AttachmentCheckResult`（重签后 Range-0 探测后端分类，仅 attachment 分支使用）；不落日志明文 URL（只记 mediaType + id + 状态码，脱敏纪律）。
- **`BackendAdapter` 扩展（`backend-adapter.ts`）**：
  ```ts
  uploadAttachments(files: UploadContent[]): Promise<AttachmentInfo[]>   // multipart；UploadContent = {name, mediaType, size, kind?, path?|bytes}（kind 按文件携带，可省略由后端魔数判定；AttachmentInfo.kind 权威）
  signAttachmentUrl(attachmentId: string): Promise<{ url: string; expiresAt: string }>
  ```
  协议差异（multipart 构造、Bearer、超时、取消）全部收敛在 `RealBackend`；`MockBackend` 实现确定性内存版（固定 AttachmentInfo + 假签名 URL）供测试/E2E。
- **协议 handler 扩展（`src/main/protocol/handler.ts`）**：注册签名改为 `registerCyreneProtocolHandler({ rendererRoot?, resolveMedia? })`，**dev/prod 都注册**；回调内先判 `host===RENDERER_HOST` 且 `pathname` 匹配 `/__cyrene-media/{mediaType}/{id}` → 媒体分支（校验 mediaType 白名单 + id 格式 + `Sec-Fetch-Dest` + resolveMedia），否则走原渲染根文件服务（`rendererRoot` 缺省/realpath 失败时非媒体一律 404）；未知 host 仍 404。装配（`src/main/index.ts`）经 bridge（同 `chatBridge` 模式）注入 MediaService（adapter 构造后挂载）。
- **`classifyNavigation`（`windows/navigation.ts`）**：`cyrene://renderer/__cyrene-media/*` → `deny`（attachment/sticker 均 deny，防导航把媒体字节当页面加载）。
- **IPC 注册**：`src/main/ipc/channels.ts` 增 request schema；`src/main/ipc/handlers.ts` 或新增 `attachments-handlers.ts` 用 `createIpcHandler` 注册四通道（validate/upload/cancel/check，沿用 P0 校验/脱敏/审计模式）。

### 4.6 Renderer 侧

- **`stores/attachment.store.ts`**（新 Pinia store）：`pendingById`/`order`；`addFiles/validate/upload/cancel/remove/clearOnSent`；纯逻辑状态机可测；窄接口类型（`stores/desktop-api.types.ts`）同步补四方法。
- **`components/CyAttachmentQueue.vue`**：输入区上方条目列表（图标/名称/大小/类型/状态/错误原因/移除；validating/uploading 显示不确定 spinner；failed 显示原因与「移除」）。G4 贴图条目（`PendingSticker`）复用本队列渲染，经 `__cyrene-media/sticker/{stickerId}` 显示图片（见 §2 G4 边界）。
- **`components/CyDropOverlay.vue`**：拖入聊天区时覆盖式虚线投放区 + 支持类型说明，离开即恢复（docs 03 §8.3）。
- **`components/CyAttachmentMedia.vue`**（分发）+ `CyImageAttachment/CyVideoAttachment/CyAudioAttachment/CyFileAttachment/CyLinkAttachment/CyAttachmentPlaceholder`：按 kind/playable 分发；图标卡（名称/大小/类型）；点击展开播放；错误/过期/撤销/不支持占位 + 重试/刷新。
- **`CyChatInput.vue`**：加「添加文件」按钮、`dragover/drop`、`paste` 收集、队列渲染与发送编排（见 4.4）。
- **`CyMessageBubble.vue`**：user 消息 `message.attachments` 渲染 `CyAttachmentMedia` 列表；assistant 媒体分段渲染同类组件（`isTextSegment` 之外的 kind 不再落 `[kind 分段]` 占位）。

**播放矩阵（D-03 参考表）**：落 `renderer/src/utils/media.ts` 纯常量（`PLAYABLE_MEDIA: Record<AttachmentKind, string[]>`,可测）：`video`：mp4(h264+aac)/webm(vp8/vp9+opus)/ogv 为可播放；mkv/mov/h265 标「暂不支持播放」图标卡。`audio`：mp3/wav/ogg/flac/m4a 可播放；wma/aiff 标不支持。`image`：png/jpg/gif/webp/svg 内联预览（svg 经 `<img>` 不执行脚本，安全）。列表外一律 `file` 图标卡。

### 4.7 呈现与状态（错误/过期/撤销/不支持）

| 状态 | 触发 | 占位 |
|---|---|---|
| loading | 元素加载中 | spinner / 图标卡 |
| error | `attachments:check` 返回 error（网络/后端 5xx） | 「加载失败」+ 重试 |
| expired | `attachments:check` 返回 expired（重签后仍失败） | 「附件已过期」+ 刷新 |
| revoked | `attachments:check` 返回 revoked（或 not_found 且消息被删上下文） | 「附件已撤销」（wire 指示待联调，见 §6） |
| not_found | `attachments:check` 返回 not_found（非撤销上下文） | 「附件不存在」 |
| unsupported | 矩阵外编解码 | 「此格式暂不支持播放」（文件图标卡） |
| ready | 正常 | 按 kind 呈现 |

### 4.8 错误处理与取消

- 校验失败逐项 `failed(reason)`，可移除后可发送其余文本；发送阻断条件见 4.3；
- 上传取消：`attachmentsCancel` → Main abort 挂起 `fetch`（AbortController）→ 上传 promise 以 `cancelled` 类错误 reject → 条目置 `cancelled` 移除；网络失败 → `failed` + 重试（重试会新上传生成新 attachmentId，孤儿待后端 GC，P2 记录）；
- 过期：Main 透明重签一次；播放中过期（Range 请求 403）重签重试；仍失败经 `attachments:check` 展示过期占位；
- 媒体代理后端 4xx/5xx 不泄漏签名 URL/正文到日志（只记 attachmentId+status）。

### 4.9 安全要点

- Renderer 不直连后端 host、不持有签名 URL（D1）；
- 路径只在 Preload/Main 流转（D5）；无「按路径读取」Renderer 接口；`getPathForFile` 防任意路径注入；
- `__cyrene-media` 前缀导航 deny + `Sec-Fetch-Dest: document` 拒绝（双保险，防媒体字节作顶层文档）；
- CSP 只放行自管 scheme，不放行任意 host（D1 + G-9 同步 meta）；
- markdown 链接危险协议剥离既有；链接打开仅 http/https（D8）。

### 4.10 测试计划

- **单测（新/扩展）**：`attachment-state.spec.ts`（状态机全转移 + source 不变性 + 发送阻断条件 + 省略 uploaded 态）；`attachment-validate.spec.ts`（数量/聚合/单文件限额、kind 矩阵、魔数嗅探、敏感范围/非普通文件拒）；`upload-service.spec.ts`（multipart 构造、**每文件 kind**、取消 abort、错误映射、超时）；`media-service.spec.ts`（签名缓存命中/过期重签、401/403 重签重试、410 映射、`checkStatus` 分类、attachmentId 格式、**sticker 分支：stickerId 白名单 `^st_[A-Za-z0-9-]+$` + MIME 白名单 + 静态代理无签名**、Sec-Fetch-Dest 拒绝、日志脱敏）；`rest-mapper.spec.ts`/`raw-schemas.spec.ts`（媒体 ContentPart → 领域附件/分段映射、name/size/尺寸从 filename/size_bytes 映射；带媒体 ContentPart 消息**可解析**——schema 本就放行 unknown content，断言映射层不丢媒体）；`protocol-csp.spec.ts`/`dev-csp.spec.ts`（prod 含 `media-src 'self'` 且 img-src 不含裸 host——文档同源 cyrene://renderer 下 `'self'` 即放行；dev `buildDevCsp()`/index.html meta 三处含 `cyrene:`（media-src/img-src），**connect-src 不含 cyrene:**）；`navigation.spec.ts`（`__cyrene-media/{mediaType}/{id}` 前缀 deny）；`desktop-api-attachments.spec.ts`（preload 新四通道 schema + path 不入返回面）；`send-with-attachments`（message.store：乐观消息带附件、ack、失败）。
- **集成**：`ipc-attachments.spec.ts`（validate/upload/cancel/check 经 MockBackend 往返 + 结构化错误）；`protocol-media-handler.spec.ts`（注册假 MediaService → attachment 分支 Range 请求 206 透传、重签重试、document 拒绝；sticker 分支白名单/静态代理/无签名路径）；`mock-backend` 上传（每文件 kind）/签发确定性断言。
- **check:contract 13/13 保持**（本方案不改 schema 结构——`content` 保持 `unknown`，建模在映射层，fixture 不变；`schemaHash` 指纹**不下探嵌套元素**，即使新增嵌套字段也不改变指纹——实施时实测确认）。
- **E2E/手工（真实后端联调项）**：上传图片/视频/文件各一次（D-01）；过期资源刷新或失败占位（D-02）；三种资源可播放与不支持样例（D-03）；拖拽不自动上传/发送 + 取消（D-04）。

## 5. 验收标准（docs/16 §6 映射）

- [ ] 点击/拖拽/粘贴共用同一附件状态机；**拖拽只创建待发送条目，不自动上传、不自动发送**（D4 + 输入层单测）；
- [ ] 图片内联预览（原生缩放）；视频/音频图标卡点击可播放；文件图标卡；**失败/过期/撤销状态可解释**（D9 + 呈现单测）；
- [ ] **绝对本地路径不泄漏**：path 不出现于 Renderer store/状态、不随 IPC 返回、不进后端（D5 + 集成断言）；
- [ ] 上传取消/撤销路径完整：`attachmentsCancel` abort + 条目 `cancelled`；撤销占位可展示（D10/D7）；
- [ ] typecheck/lint/单测/集成/build 全绿；check:contract 13/13；`pnpm package` + `verify:artifact --smoke` 不回归；
- [ ] 文档标记：本批完成仍「已开发、未联调」（真实后端附件联调未进行）。

## 6. 已知限制与待联调确认项（记录）

- **历史/回放附件 name/size/尺寸由 ContentPart 承诺**：回放 ContentPart 携带 `filename`/`size_bytes`/`width`/`height`/`duration_ms`，mapper 直接映射为领域字段，图标卡显示这些元数据——不再依赖「kind + ID 尾段」兜底。消息级 `AttachmentRef`（WS 发送路径的客户端提示值）仍无 name/size，但发送路径由上传响应 `AttachmentInfo` 补全。
- **媒体 `ContentPart.src` 的 id 与 `attachmentId` 一致性**：`src=/api/attachments/{id}` 的 {id} 与 `attachment_id`（att_ 前缀）关系**待联调确认**；适配层优先 `attachment_id`，缺失时从 src 尾段解析并校验格式。
- **撤销（revoked）wire 指示**：本批以「`attachments:check` 返回 not_found + 消息删除上下文」近似；后端正式撤销指示**待联调确认**（占位文案与状态字段预留）。
- **自定义协议媒体栈 spike**：`<video>/<audio>` 经 `cyrene://` 需首个实施任务 spike 验证；**锁定决策已定**同源 `__cyrene-media/{mediaType}/{id}`（复用既有 `cyrene://` 注册，无新 scheme），原「独立 host `cyrene://media/...`」备选已关闭。
- **上传无 byte 级进度**：undici/fetch 无上传进度事件 → 阶段态 + 不确定 spinner（D10）。
- **上传非幂等**：重试产生新 attachmentId；孤儿附件待后端 GC（P2）。
- **文件保存到磁盘**（D-08）P2，本批 P0 仅展示图标卡。
- **队列内存态**：重启不恢复（docs 06 §7）；会话草稿持久化属另一组任务。
- **REST 归档中媒体 ContentPart 的精确形状**：`RestMessageSchema.content` 为 `unknown`，媒体 parts 的精确 wire 形状（数组 vs 对象、字段名）**待联调确认**；本批先在**映射层**以 WS ContentPart 形状为准建模（schema 保持 `content: unknown`，映射层判别），REST 侧做 optional 兼容。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-14-phase3-attachments-media-design.md`；
- **G4 已改为复用本组机制（锁定决策，2026-08-14）**：表情包贴图经本组通用媒体代理 `cyrene://renderer/__cyrene-media/sticker/{stickerId}`（静态 `/static/stickers/{stickerId}.png`、stickerId 白名单 `^st_[A-Za-z0-9-]+$`、MIME 白名单 image/png、无签名）加载，`PendingSticker` 挂入本组待发送队列；实施/联调时与 G4 文档同步本协议与队列边界（§2/4.2/4.4/§6 已记录）；
- 实施完成后再更新：docs/02 §19 附件映射（若联调确认字段）、docs/06 附件状态节（若模型变化）、docs/16 阶段 3 任务勾选与测试数字、README/CLAUDE.md（附件能力与三态状态）；
- 保持「已开发、未联调」标记，直至真实后端附件联调通过。
