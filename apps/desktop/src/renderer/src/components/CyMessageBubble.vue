<script setup lang="ts">
// CyMessageBubble:单条消息气泡。user 右对齐(「我」头像)+纯文本;assistant 左对齐(Cyrene 头像),
// 按 assistantSegments(segmentIndex 排序)渲染:内心独白 details 折叠(默认收起,标题仅「内心独白」)+
// public_reply 白色气泡 + 工具卡 + 元数据低权重行。UII-QQ 重构:去掉「外层大卡片+状态行+蓝色正文框」
// 多层嵌套;completed 不展示,failed/interrupted 仍明确展示(inner_voice 数据不删,只改展示)。
import { computed } from 'vue'
import type { AssistantSegment, Message } from '@shared/contracts'
import { stickerRenderUrl } from '@shared/domain'
import { formatFullTime, formatMessageTime } from '../utils/message-time'
import CyMarkdown from './CyMarkdown.vue'
import CyAttachmentMedia from './CyAttachmentMedia.vue'
import CyToolCard from './CyToolCard.vue'   // 阶段 6 批次 B（Task 7）：归档工具卡片（只读）

const props = defineProps<{ message: Message }>()   // UI 问题 1 修复：不再按 visible 延迟渲染——虚拟窗口/overscan 内全量渲染真实内容，消除「完整↔骨架」几何切跳

// —— UII-QQ 时间戳批次：每条 Message 只显示一次时间（inner_voice/public_reply/工具卡/emotion 共用）——
// 默认可见内容仅本地 HH:mm（h23）；<time datetime> 保留原始 createdAt，title/aria-label 为完整本地时间；
// createdAt 为权威字段、流式期间不变 → 显示时间稳定不跳；非法 createdAt → null → time 整体不渲染（安全隐藏）
const createdAtText = computed(() => formatMessageTime(props.message.createdAt))
const createdAtFull = computed(() => formatFullTime(props.message.createdAt))

/** G4：贴图渲染 URL（复用 G3 通用媒体代理；id 缺失返回 undefined → 占位） */
function stickerSrc(id?: string): string | undefined { return id ? stickerRenderUrl(id) : undefined }

const isUser = computed(() => props.message.role === 'user')

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

/** 非完成态可见提示(failed/interrupted);正常 completed 不展示(UII-QQ:状态噪音清零) */
const terminalNote = computed(() => {
  const s = props.message.status
  if (s === 'failed') return '回复失败'
  if (s === 'interrupted') return '已中断'
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
</script>

<template>
  <!-- user 消息:右对齐 + 「我」头像;content 纯文本 mustache 转义(不解析 HTML,勿用 v-html);failed 加错误角标(P2-4) -->
  <div v-if="isUser" class="cy-message-row cy-user-row">
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
    </div>
    <span class="cy-avatar cy-avatar-user" aria-hidden="true">我</span>
  </div>

  <!-- tool 角色消息：不渲染空气泡（归档工具卡片在 assistant 消息内；tool 消息自身只留空占位） -->
  <div v-else-if="message.role === 'tool'" class="cy-tool-role-placeholder" />

  <!-- assistant 消息:左对齐,Cyrene 头像 + 扁平列(名称一次/内心独白折叠/工具卡/白色气泡/低权重元数据) -->
  <div v-else class="cy-message-row cy-assistant-row" :class="{ 'is-streaming': message.status === 'streaming' }">
    <span class="cy-avatar cy-avatar-assistant" aria-hidden="true">Cy</span>
    <div class="cy-msg-col">
      <!-- UII-QQ 时间戳批次：名称行升为轻头部「Cyrene · HH:mm」——时间弱于名称；inner_voice/工具卡/正文/心情共用 -->
      <div class="cy-msg-name">
        <span>Cyrene</span>
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
    </div>
  </div>
</template>

<style scoped>
.cy-message-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
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
  border-radius: 10px;
  font-size: 12px;
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
  gap: 6px;
  min-width: 0;
  max-width: min(72%, 620px);
}

.cy-user-col {
  align-items: flex-end;
}

.cy-msg-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: var(--cy-muted);
  font-size: 12px;
  line-height: 1.2;
  padding-left: 2px;
  user-select: none;
}

/* UII-QQ 时间戳批次：时间弱于名称（同 --cy-muted、11px、低 opacity、tabular-nums）；
   user/assistant 共用同一视觉权重；不与技术元数据行（.cy-msg-meta）混排 */
.cy-msg-time {
  flex: none;
  color: var(--cy-muted);
  font-size: 11px;
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
  padding: 9px 12px;
  background: var(--cy-surface);
  border-radius: 4px 14px 14px 14px;
  box-shadow: var(--cy-shadow-soft);
}

.cy-user-bubble {
  color: var(--cy-text);
  background: var(--cy-user);
  border-radius: 14px 4px 14px 14px;
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
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--cy-accent-text);
  background: var(--cy-danger);
  font-size: 10px;
  line-height: 1.6;
}

/* 内心独白：轻量次级区，弱于正式回复；标题仅「内心独白」 */
.cy-inner-voice {
  align-self: stretch;
  padding: 7px 10px;
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border-radius: 10px;
  font-size: 12px;
}

.cy-inner-voice summary {
  cursor: pointer;
  color: var(--cy-muted);
  font-size: 12px;
  user-select: none;
}

.cy-inner-voice-text {
  margin-top: 7px;
  font-size: 12px;
  color: var(--cy-muted);
}

.cy-media-placeholder {
  color: var(--cy-muted);
  font-size: 12px;
}

/* UII-QQ IA：心情旁白——独立于技术元数据，小字斜体、柔和但可读，自然换行不挤出消息列 */
.cy-msg-emotion {
  max-width: 100%;
  color: var(--cy-muted);
  font-size: 12px;
  font-style: italic;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.cy-msg-emotion-heart {
  margin-right: 5px;
  color: var(--cy-accent-strong);
  font-style: normal;
}

/* 技术元数据：仅 model/tokens，低权重灰色单行；多项间以中点分隔 */
.cy-msg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 2px;
  color: var(--cy-muted);
  font-size: 11px;
  opacity: 0.85;
}

.cy-msg-meta span + span::before {
  content: '·';
  margin-right: 8px;
}

.cy-status-note {
  color: var(--cy-danger);
  font-size: 11px;
}

.cy-user-attachments {
  display: grid;
  gap: 6px;
  max-width: 100%;
}

/* G4：贴图（user 消息 + assistant sticker 分段共用）；纯贴图消息无气泡底 */
.cy-sticker-img {
  width: 96px;
  height: 96px;
  object-fit: contain;
}

.cy-sticker-plain {
  margin-right: 2px;
}
</style>
