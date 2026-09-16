<script setup lang="ts">
// CyMessageBubble:单条消息气泡。user 右对齐(「我」头像)+纯文本;assistant 左对齐(动态角色头像),
// 按 assistantSegments(segmentIndex 排序)渲染:内心独白 details 折叠(默认收起,标题仅「内心独白」)+
// public_reply 白色气泡 + 工具卡 + 元数据低权重行。UII-QQ 重构:去掉「外层大卡片+状态行+蓝色正文框」
// 多层嵌套;completed 不展示,failed/interrupted 仍明确展示(inner_voice 数据不删,只改展示)。
import { computed, onBeforeUnmount, ref } from 'vue'
import type { AssistantSegment, CharacterBindingSnapshot, CharacterGenerationRef, Message, CharacterPresentation } from '@shared/contracts'
import { stickerRenderUrl } from '@shared/domain'
import { formatFullTime, formatMessageTime } from '../utils/message-time'
import { copyText } from '../utils/clipboard'
import { messageCopyableText } from '../utils/message-copy'
import CyMarkdown from './CyMarkdown.vue'
import CyAttachmentMedia from './CyAttachmentMedia.vue'
import CyToolCard from './CyToolCard.vue'   // 阶段 6 批次 B（Task 7）：归档工具卡片（只读）

/**
 * The message snapshot is the first identity authority.  The two optional
 * fallbacks are display-only inputs supplied by the message list: an exact
 * (characterId, characterRevision) cache entry, then the immutable session
 * binding.  Keeping the resolver here makes it impossible for a current
 * catalog rename to silently rewrite an historical message.
 */
interface RevisionIdentityDisplay {
  characterId: string
  characterRevision: number
  displayName: string
  presentation: CharacterPresentation
}

const props = defineProps<{
  message: Message
  characterBinding?: CharacterBindingSnapshot
  revisionIdentity?: RevisionIdentityDisplay
  userDisplayName?: string
  /** 生成中/发送中：操作行里的重发与重新生成此刻不可用（与输入区禁用发送同一口径）。
   *  动作本身由父层（CyMessageList）执行——本组件不 import store，保持"展示 + 交互"职责。 */
  busy?: boolean
}>()   // UI 问题 1 修复：不再按 visible 延迟渲染——虚拟窗口/overscan 内全量渲染真实内容，消除「完整↔骨架」几何切跳
const emit = defineEmits<{
  resend: [messageId: string]
  regenerate: [messageId: string]
  /** 右键：把坐标交给父层（菜单实例由 CyMessageList 持有——每个气泡各带一个菜单会随虚拟列表放大开销） */
  menu: [payload: { messageId: string; x: number; y: number }]
}>()

// —— UII-QQ 时间戳批次：每条 Message 只显示一次时间（inner_voice/public_reply/工具卡/emotion 共用）——
// 默认可见内容仅本地 HH:mm（h23）；<time datetime> 保留原始 createdAt，title/aria-label 为完整本地时间；
// createdAt 为权威字段、流式期间不变 → 显示时间稳定不跳；非法 createdAt → null → time 整体不渲染（安全隐藏）
const createdAtText = computed(() => formatMessageTime(props.message.createdAt))
const createdAtFull = computed(() => formatFullTime(props.message.createdAt))

/** G4：贴图渲染 URL（复用 G3 通用媒体代理；id 缺失返回 undefined → 占位） */
function stickerSrc(id?: string): string | undefined { return id ? stickerRenderUrl(id) : undefined }

const isUser = computed(() => props.message.role === 'user')

function sameCharacterTuple(
  left: Pick<CharacterGenerationRef, 'characterId' | 'characterInstanceId' | 'characterRevision'>,
  right: Pick<CharacterGenerationRef, 'characterId' | 'characterInstanceId' | 'characterRevision'>
): boolean {
  return left.characterId === right.characterId
    && left.characterInstanceId === right.characterInstanceId
    && left.characterRevision === right.characterRevision
}

function firstCharacter(value: string): string {
  return Array.from(value.trim())[0] ?? '角'
}

/** Resolve a message's immutable assistant identity without consulting the live catalog. */
const assistantIdentity = computed<{
  displayName: string
  presentation?: CharacterPresentation
}>(() => {
  const messageRef = props.message.character
  const cached = messageRef && props.revisionIdentity
    && messageRef.characterId === props.revisionIdentity.characterId
    && messageRef.characterRevision === props.revisionIdentity.characterRevision
      ? props.revisionIdentity
      : undefined
  const binding = messageRef && props.characterBinding && sameCharacterTuple(messageRef, props.characterBinding)
    ? props.characterBinding
    : !messageRef ? props.characterBinding : undefined
  const displayName = messageRef?.displayName?.trim()
    || cached?.displayName?.trim()
    || binding?.displayName?.trim()
    || '角色'
  const presentation = messageRef?.presentation
    || cached?.presentation
    || binding?.presentation
  return { displayName, ...(presentation ? { presentation } : {}) }
})

const assistantName = computed(() => assistantIdentity.value.displayName)
const assistantAvatar = computed(() => firstCharacter(assistantName.value))
const userDisplayName = computed(() => props.userDisplayName?.trim() || '我')

/** 双通道各自按 segmentIndex 全局排序(P0 inner_voice 仅 text/markdown) */
const innerVoiceSegments = computed(() =>
  (props.message.assistantSegments ?? [])
    .filter((s) => s.channel === 'inner_voice')
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
)
const publicSegments = computed(() =>
  (props.message.assistantSegments ?? [])
    .filter((s) => s.channel === 'public_reply')
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
)

/** 父回复完成后 usage/model 才写入(messageStore.finalizeAssistant);emotion 同期写入但独立展示(UII-QQ IA:
 *  心情是人格化旁白,技术元数据是运维信息,两者分行) */
const hasTechMeta = computed(() => !!(props.message.model || props.message.usage))

/** 非完成态可见提示(failed/interrupted/completing);正常 completed 不展示(UII-QQ:状态噪音清零) */
const terminalNote = computed(() => {
  const s = props.message.status
  if (s === 'failed') return '回复失败'
  if (s === 'interrupted') return '已中断'
  // S7-C2（2026-09-15 评审）：`completing` = 「有缺口的不完整回复」。`StreamAccumulator` 的注释写着
  // 「有缺口时进入 completing，**不伪装完整**」，但渲染层此前对它返回空串 —— 用户读到被静默截断的
  // 回答并当作完整回答。这里补上该状态在 UI 上的**第一个也是唯一**的出口。
  if (s === 'completing') return '回复可能不完整（部分内容缺失）'
  return ''
})

/** 纯贴图消息（content 空 + 仅 sticker）：贴图独立渲染,不加文字气泡底 */
const stickerOnly = computed(() => isUser.value && !props.message.content && !!props.message.stickerId)

function segmentText(seg: AssistantSegment): string {
  return seg.text ?? ''
}

/** P0 仅 text/markdown 渲染;其余 kind 留占位(阶段 3 加媒体) */
function isTextSegment(seg: AssistantSegment): boolean {
  return seg.kind === 'text' || seg.kind === 'markdown'
}

/** G3 user 消息附件列表 → CyAttachmentMedia（D2 内嵌 Message.attachments） */
function userAttachments(): Array<{ attachmentId: string; kind: 'image' | 'video' | 'audio' | 'file' | 'link'; mediaType?: string; name?: string; size?: number; url?: string }> {
  return (props.message.attachments ?? []).map((a) => ({ attachmentId: a.attachmentId, kind: a.kind, mediaType: a.mediaType, name: a.name, size: a.size }))
}

// —— H-02（2026-09-11）：消息级复制 ——
// 报告实测：`body { user-select: none }` + 无操作行 + 无右键菜单，使「复制回答」三条路全断。
// 本组件补操作行（选择能力由 CyMessageList 对消息行恢复 user-select 承担）。
// 「复制什么」的判据自 2026-09-13 起收敛到 utils/message-copy（右键菜单的复制项用同一份，防两份副本漂移）。
const copyableText = computed(() => messageCopyableText(props.message))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
// 2026-09-16 审计 P2：卸载标记——定时器建在 `await copyText` 之后，而虚拟列表会频繁挂载/卸载行，
// 卸载发生在 await 期间时定时器照旧被建出来且无人清理（写一个已卸载组件的 ref）。
let unmounted = false
async function onCopy(): Promise<void> {
  if (!copyableText.value) return
  const ok = await copyText(copyableText.value)
  if (!ok || unmounted) return
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 1500)
}
// 虚拟列表会频繁挂载/卸载行——定时器必须随组件销毁清理，否则卸载后仍写 ref
onBeforeUnmount(() => { unmounted = true; if (copiedTimer) clearTimeout(copiedTimer) })

// —— doc 03 §7.5（2026-09-13）：重发 / 重新生成 的**可用性**判据 ——
// 有正文、且没有附件/贴图（重发要重走上传与贴图校验，属独立范围）才给「重新发送」；
// 「重新生成」只对含正文的助手回复给出。
const canResend = computed(() => isUser.value
  && (props.message.content ?? '').length > 0
  && (props.message.attachments?.length ?? 0) === 0
  && !props.message.stickerId)
const busy = computed(() => props.busy === true)
</script>

<template>
  <!-- user 消息:右对齐 + 「我」头像;content 纯文本 mustache 转义(不解析 HTML,勿用 v-html);failed 加错误角标(P2-4) -->
  <div v-if="isUser" class="cy-message-row cy-user-row" @contextmenu.prevent="emit('menu', { messageId: message.messageId, x: $event.clientX, y: $event.clientY })">
    <div class="cy-msg-col cy-user-col">
      <!-- UII-QQ 收尾：时间头部行（右对齐）位于内容上方——与 Assistant「头像+名称时间头部+内容」镜像；
           头像已表达用户身份，头部不重复「我」；时间仍在气泡外、不入蓝色气泡 -->
      <div v-if="createdAtText" class="cy-user-msg-head">
        <time class="cy-msg-time" :datetime="message.createdAt" :title="createdAtFull ?? undefined" :aria-label="createdAtFull ?? undefined">{{ createdAtText }}</time>
      </div>
      <p v-if="message.content" class="cy-bubble cy-user-bubble">{{ message.content }}</p>
      <!-- G4：用户贴图消息（wire Message.stickerId；content 可空）——纯贴图不加气泡底 -->
      <img v-if="message.stickerId" :src="stickerSrc(message.stickerId)" class="cy-sticker-img" :class="{ 'cy-sticker-plain': stickerOnly }" alt="表情" />
      <!-- G3：user 消息附件（内嵌 Message.attachments） -->
      <div v-for="a in userAttachments()" :key="a.attachmentId" class="cy-user-attachments">
        <CyAttachmentMedia :kind="a.kind" :attachment-id="a.attachmentId" :media-type="a.mediaType" :name="a.name" :size="a.size" />
      </div>
      <span v-if="message.status === 'failed'" class="cy-user-error-badge" title="发送失败">发送失败</span>
      <!-- H-02：消息操作行（右对齐随 user 列）；doc 03 §7.5（2026-09-13）补「重新发送」 -->
      <div v-if="copyableText" class="cy-msg-actions">
        <button type="button" class="cy-msg-action" data-testid="message-copy" :aria-label="copied ? '已复制' : '复制消息'" @click="onCopy">{{ copied ? '已复制' : '复制' }}</button>
        <button
          v-if="canResend"
          type="button"
          class="cy-msg-action"
          data-testid="message-resend"
          :disabled="busy"
          :title="busy ? '生成中，暂不可重新发送' : undefined"
          aria-label="重新发送"
          @click="emit('resend', message.messageId)"
        >重新发送</button>
      </div>
    </div>
    <span class="cy-avatar cy-avatar-user" role="img" :title="userDisplayName" :aria-label="userDisplayName">我</span>
  </div>

  <!-- tool 角色消息：不渲染空气泡（归档工具卡片在 assistant 消息内；tool 消息自身只留空占位） -->
  <div v-else-if="message.role === 'tool'" class="cy-tool-role-placeholder" />

  <!-- assistant 消息:左对齐,动态角色头像 + 扁平列(名称一次/内心独白折叠/工具卡/白色气泡/低权重元数据) -->
  <div v-else class="cy-message-row cy-assistant-row" :class="{ 'is-streaming': message.status === 'streaming' }" @contextmenu.prevent="emit('menu', { messageId: message.messageId, x: $event.clientX, y: $event.clientY })">
    <span class="cy-avatar cy-avatar-assistant" role="img" :title="assistantName" :aria-label="assistantName">{{ assistantAvatar }}</span>
    <div class="cy-msg-col">
      <!-- UII-QQ 时间戳批次：名称行升为轻头部「角色 · HH:mm」——时间弱于名称；inner_voice/工具卡/正文/心情共用 -->
      <div class="cy-msg-name">
        <span>{{ assistantName }}</span>
        <time v-if="createdAtText" class="cy-msg-time" :datetime="message.createdAt" :title="createdAtFull ?? undefined" :aria-label="createdAtFull ?? undefined">{{ createdAtText }}</time>
      </div>
      <!-- 内心独白：details 可访问折叠,默认收起,展开/收起高度变化经 ResizeObserver 实测进前缀和 -->
      <details v-if="innerVoiceSegments.length" class="cy-inner-voice">
        <summary>内心独白</summary>
        <CyMarkdown
          v-for="seg in innerVoiceSegments"
          :key="seg.segmentId"
          class="cy-inner-voice-text"
          :source="segmentText(seg)"
        />
      </details>

      <!-- 阶段 6 批次 B（Task 7）：归档工具卡片（Message.toolCalls，REST 历史 + WS 回放双路径配对产物；只读）——独立内容块，不压进气泡 -->
      <CyToolCard v-for="tc in message.toolCalls" :key="tc.id" :record="tc" readonly />
      <template v-for="seg in publicSegments" :key="seg.segmentId">
        <!-- UI 问题 1 修复：全量渲染真实内容（虚拟窗口/overscan 已限制 DOM 行数），不再有「完整↔骨架」几何切跳。
             .cy-segment 类名保留（perf-gate ②/③ 计数契约），视觉升为白色助手气泡 -->
        <CyMarkdown v-if="isTextSegment(seg)" class="cy-segment cy-bubble cy-assistant-bubble" :source="segmentText(seg)" />
        <!-- G4：sticker 分段渲染（wire seg.stickerId，复用通用媒体代理） -->
        <img v-else-if="seg.kind === 'sticker' && seg.stickerId" :src="stickerSrc(seg.stickerId)" class="cy-sticker-img" alt="表情" />
        <!-- G3：assistant 媒体分段（attachmentId 存在时渲染媒体组件；实时流式分段无 attachmentId 仍走占位，P2-5 wire 契约） -->
        <CyAttachmentMedia
          v-else-if="seg.attachmentId"
          class="cy-segment"
          :kind="(seg.kind as 'image' | 'video' | 'audio' | 'file' | 'link')"
          :attachment-id="seg.attachmentId"
          :media-type="seg.mediaType"
          :name="seg.name"
          :size="seg.size"
        />
        <span v-else class="cy-media-placeholder cy-bubble">[{{ seg.kind }} 分段]</span>
      </template>
      <!-- UII-QQ IA：心情独立行（人格化旁白，♡ 轻量字符不使用彩色 Emoji；自然换行不挤出消息列）；
           技术元数据（model/tokens）单独一行低权重展示，数据与后端契约不变 -->
      <span v-if="message.emotion" class="cy-msg-emotion"><span class="cy-msg-emotion-heart" aria-hidden="true">♡</span>{{ message.emotion }}</span>
      <div v-if="hasTechMeta" class="cy-msg-meta">
        <span v-if="message.model">{{ message.model }}</span>
        <span v-if="message.usage">{{ message.usage.total }} tokens</span>
      </div>
      <span v-if="terminalNote" class="cy-status-note">{{ terminalNote }}</span>
      <!-- H-02：消息操作行（复制回答——本产品最高频操作，此前三条路全断）；doc 03 §7.5（2026-09-13）补「重新生成」 -->
      <div v-if="copyableText" class="cy-msg-actions">
        <button type="button" class="cy-msg-action" data-testid="message-copy" :aria-label="copied ? '已复制' : '复制回答'" @click="onCopy">{{ copied ? '已复制' : '复制' }}</button>
        <button
          type="button"
          class="cy-msg-action"
          data-testid="message-regenerate"
          :disabled="busy"
          :title="busy ? '生成中，暂不可重新生成' : undefined"
          aria-label="重新生成"
          @click="emit('regenerate', message.messageId)"
        >重新生成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* H-02：消息操作行——默认低权重，hover/focus-within 才显形；不改变行高契约（虚拟列表按实测高自适应） */
.cy-msg-actions { display: flex; gap: var(--cy-space-4); opacity: 0; transition: opacity var(--cy-motion-fast) ease; }
.cy-message-row:hover .cy-msg-actions,
.cy-message-row:focus-within .cy-msg-actions { opacity: 1; }
/* 键盘/触屏可达性：聚焦在按钮上时必须可见（不能只靠 hover） */
.cy-msg-actions:focus-within { opacity: 1; }
.cy-msg-action {
  padding: var(--cy-space-1) var(--cy-space-4);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-pill);
  background: var(--cy-surface);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  cursor: pointer;
}
.cy-msg-action:hover { color: var(--cy-text); background: var(--cy-surface-hover); }
/* 消息正文可选中（H-02）：全局 body 为 user-select:none，此前连 Ctrl+A/Ctrl+C 都无效 */
.cy-bubble,
.cy-inner-voice-text,
.cy-msg-emotion { user-select: text; }

.cy-message-row {
  display: flex;
  align-items: flex-start;
  gap: var(--cy-space-4-5);
}

.cy-user-row {
  justify-content: flex-end;
}

/* 头像：assistant 浅蓝方圆角 / user 中性（QQ 左右双头像结构） */
.cy-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--cy-radius-5);
  font-size: var(--cy-font-md);
  user-select: none;
}

.cy-avatar-assistant {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-avatar-user {
  color: var(--cy-muted);
  background: var(--cy-surface-hover);
}

.cy-msg-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--cy-space-3);
  min-width: 0;
  max-width: min(72%, 620px);
}

.cy-user-col {
  align-items: flex-end;
}

.cy-msg-name {
  display: flex;
  align-items: baseline;
  gap: var(--cy-space-3);
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
  line-height: 1.2;
  padding-left: var(--cy-space-1);
  user-select: none;
}

/* UII-QQ 时间戳批次：时间弱于名称（同 --cy-muted、11px、低 opacity、tabular-nums）；
   user/assistant 共用同一视觉权重；不与技术元数据行（.cy-msg-meta）混排 */
.cy-msg-time {
  flex: none;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}

/* UII-QQ 收尾：用户时间头部行——右对齐、位于内容上方（col gap 6px 提供头行与气泡间距）；
   行 flex-start 顶对齐使头像与时间行自然构成 Assistant 头部结构的镜像 */
.cy-user-msg-head {
  display: flex;
  justify-content: flex-end;
}

/* 气泡基座：白底 + 轻阴影（不叠多层描边）；user 用浅蓝。近头像角收窄（QQ 朝向感）。
   margin: 0——user 气泡本身是 <p>，清 UA 默认外边距（否则气泡与头像基线错位） */
.cy-bubble {
  margin: 0;
  max-width: 100%;
  padding: var(--cy-space-4-5) var(--cy-space-6);
  background: var(--cy-surface);
  border-radius: 4px var(--cy-radius-7) var(--cy-radius-7) var(--cy-radius-7);
  box-shadow: var(--cy-shadow-soft);
}

.cy-user-bubble {
  color: var(--cy-text);
  background: var(--cy-user);
  border-radius: var(--cy-radius-7) 4px var(--cy-radius-7) var(--cy-radius-7);
  box-shadow: none;
}

.cy-bubble :deep(p:first-child) {
  margin-top: 0;
}

.cy-bubble :deep(p:last-child) {
  margin-bottom: 0;
}

/* 流式空段（80ms 防抖窗口内）不显示空气泡壳 */
.cy-assistant-bubble:empty {
  display: none;
}

.cy-user-error-badge {
  display: inline-block;
  padding: var(--cy-space-0-5) var(--cy-space-3-5);
  border-radius: var(--cy-radius-pill);
  color: var(--cy-accent-text);
  background: var(--cy-danger);
  font-size: var(--cy-font-xs);
  line-height: 1.6;
}

/* 内心独白：轻量次级区，弱于正式回复；标题仅「内心独白」 */
.cy-inner-voice {
  align-self: stretch;
  padding: var(--cy-space-3-5) var(--cy-space-5);
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border-radius: var(--cy-radius-5);
  font-size: var(--cy-font-md);
}

.cy-inner-voice summary {
  cursor: pointer;
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
  user-select: none;
}

.cy-inner-voice-text {
  margin-top: var(--cy-space-3-5);
  font-size: var(--cy-font-md);
  color: var(--cy-muted);
}

.cy-media-placeholder {
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
}

/* UII-QQ IA：心情旁白——独立于技术元数据，小字斜体、柔和但可读，自然换行不挤出消息列 */
.cy-msg-emotion {
  max-width: 100%;
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
  font-style: italic;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.cy-msg-emotion-heart {
  margin-right: var(--cy-space-2-5);
  color: var(--cy-accent-strong);
  font-style: normal;
}

/* 技术元数据：仅 model/tokens，低权重灰色单行；多项间以中点分隔 */
.cy-msg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cy-space-4);
  padding-left: var(--cy-space-1);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  opacity: 0.85;
}

.cy-msg-meta span + span::before {
  content: '·';
  margin-right: var(--cy-space-4);
}

.cy-status-note {
  color: var(--cy-danger);
  font-size: var(--cy-font-sm);
}

.cy-user-attachments {
  display: grid;
  gap: var(--cy-space-3);
  max-width: 100%;
}

/* G4：贴图（user 消息 + assistant sticker 分段共用）；纯贴图消息无气泡底 */
.cy-sticker-img {
  width: 96px;
  height: 96px;
  object-fit: contain;
}

.cy-sticker-plain {
  margin-right: var(--cy-space-1);
}
</style>
