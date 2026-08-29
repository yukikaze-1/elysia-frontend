<script setup lang="ts">
// CyMessageBubble:单条消息气泡。user 右对齐纯文本;assistant 左对齐,按 assistantSegments(segmentIndex 排序)
// 渲染 inner_voice 折叠(默认收起)+ public_reply CyMarkdown;usage/model/emotion chips(父回复完成后才写入并展示)。
import { computed } from 'vue'
import type { AssistantSegment, Message } from '@shared/contracts'
import { stickerRenderUrl } from '@shared/domain'
import CyMarkdown from './CyMarkdown.vue'
import CyAttachmentMedia from './CyAttachmentMedia.vue'
import CyToolCard from './CyToolCard.vue'   // 阶段 6 批次 B（Task 7）：归档工具卡片（只读）

const props = defineProps<{ message: Message; visible?: boolean }>()   // 不传 = undefined → 视为可见（不延迟）；父级显式传 false 才延迟

/** 7D 视图感知暂停：视口外 completed segment 空 source 延迟渲染（streaming/mock 恒实时）。 */
function needsDeferredRender(seg: AssistantSegment): boolean {
  return props.visible === false && seg.completed === true
}

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

/** 父回复完成后 usage/model/emotion 才写入(messageStore.finalizeAssistant),因此有 meta 即"completed 后" */
const hasMeta = computed(() => !!(props.message.usage || props.message.model || props.message.emotion))

/** 非完成态可见提示(failed/interrupted),streaming/completed 不重复显示 */
const terminalNote = computed(() => {
  const s = props.message.status
  if (s === 'failed') return '回复失败'
  if (s === 'interrupted') return '已中断'
  return ''
})

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
  <!-- user 消息:右对齐;content 纯文本 mustache 转义(不解析 HTML,勿用 v-html)。failed 加错误角标(P2-4) -->
  <div v-if="isUser" class="cy-message-row cy-user-row">
    <div class="cy-message cy-user-message">
      <p v-if="message.content">{{ message.content }}</p>
      <!-- G4：用户贴图消息（wire Message.stickerId；content 可空） -->
      <img v-if="message.stickerId" :src="stickerSrc(message.stickerId)" class="cy-sticker-img" alt="表情" />
      <!-- G3：user 消息附件（内嵌 Message.attachments） -->
      <div v-for="a in userAttachments()" :key="a.attachmentId" class="cy-user-attachments">
        <CyAttachmentMedia :kind="a.kind" :attachment-id="a.attachmentId" :media-type="a.mediaType" :name="a.name" :size="a.size" />
      </div>
      <span v-if="message.status === 'failed'" class="cy-user-error-badge" title="发送失败">发送失败</span>
    </div>
  </div>

  <!-- tool 角色消息：不渲染空气泡（归档工具卡片在 assistant 消息内；tool 消息自身只留空占位） -->
  <div v-else-if="message.role === 'tool'" class="cy-tool-role-placeholder" />

  <!-- assistant 消息:左对齐,avatar + 双通道(inner_voice / public_reply 同属一条消息) -->
  <div v-else class="cy-message-row">
    <span class="cy-message-avatar">Cy</span>
    <div class="cy-dual-message">
      <details v-if="innerVoiceSegments.length" class="cy-inner-voice">
        <summary>
          内心独白
          <span class="cy-muted">inner_voice</span>
        </summary>
        <CyMarkdown
          v-for="seg in innerVoiceSegments"
          :key="seg.segmentId"
          class="cy-inner-voice-text"
          :source="segmentText(seg)"
        />
      </details>

      <div class="cy-public-reply">
        <div class="cy-response-cluster">
          <div class="cy-response-head">
            <strong>Cyrene</strong>
            <span class="cy-muted">· {{ message.status }}</span>
          </div>
          <!-- 阶段 6 批次 B（Task 7）：归档工具卡片（Message.toolCalls，REST 历史 + WS 回放双路径配对产物；只读） -->
          <CyToolCard v-for="tc in message.toolCalls" :key="tc.id" :record="tc" readonly />
          <template v-for="seg in publicSegments" :key="seg.segmentId">
            <!-- UI 问题 2：延迟态仍渲染 .cy-segment（perf-gate ②b/③ 断言「视口外 completed 段空 source」的契约），
                 但加 .cy-segment-deferred 类——视觉上是中性骨架（浅色、无 accent 药丸底），不是误导性空 accent 药丸。
                 滚入真正可见窗口后再渲染实文。 -->
            <CyMarkdown v-if="isTextSegment(seg)" class="cy-segment" :class="{ 'cy-segment-deferred': needsDeferredRender(seg) }" :source="needsDeferredRender(seg) ? '' : segmentText(seg)" />
            <!-- G4：sticker 分段渲染（wire seg.stickerId，复用通用媒体代理） -->
            <img v-else-if="seg.kind === 'sticker' && seg.stickerId" :src="stickerSrc(seg.stickerId)" class="cy-sticker-img" alt="表情" />
            <!-- G3：assistant 媒体分段（attachmentId 存在时渲染媒体组件；实时流式分段无 attachmentId 仍走占位，P2-5 wire 契约） -->
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
          </template>
          <div v-if="hasMeta" class="cy-response-footer">
            <span v-if="message.model" class="cy-meta-chip">{{ message.model }}</span>
            <span v-if="message.usage" class="cy-meta-chip">{{ message.usage.total }} tokens</span>
            <span v-if="message.emotion" class="cy-meta-chip">{{ message.emotion }}</span>
          </div>
          <span v-if="terminalNote" class="cy-status-note">{{ terminalNote }}</span>
        </div>
      </div>
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

.cy-message-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  font-size: 13px;
}

.cy-message {
  max-width: 86%;
  padding: 10px 12px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-message p {
  margin: 0;
}

.cy-user-message {
  background: var(--cy-user);
}

.cy-user-error-badge {
  display: inline-block;
  margin-top: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  color: var(--cy-accent-text);
  background: var(--cy-danger);
  font-size: 10px;
  line-height: 1.6;
}

.cy-dual-message {
  display: grid;
  gap: 9px;
  max-width: 90%;
  padding: 0;
  overflow: hidden;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-inner-voice {
  padding: 10px 12px;
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border-bottom: 1px solid var(--cy-border);
}

.cy-inner-voice summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  color: var(--cy-text);
  font-weight: 500;
}

.cy-inner-voice-text {
  margin-top: 8px;
  font-size: 13px;
  color: var(--cy-muted);
}

.cy-public-reply {
  padding: 0 12px 12px;
}

.cy-response-cluster {
  display: grid;
  gap: 7px;
}

.cy-response-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-segment {
  width: fit-content;
  max-width: 100%;
  padding: 8px 11px;
  border-radius: 5px 13px 13px 13px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border-left: 2px solid var(--cy-accent-strong);
}

/* UI 问题 2：延迟态（completed + 视口外）——保留 .cy-segment 契约（perf-gate ②b/③ 断言空 source），
   但视觉改为中性骨架（surface-soft 底、muted、无 accent 药丸底 + 轻微脉冲），消除空 accent 药丸的误导。
   滚入真正可见窗口后去掉该类，恢复 accent 药丸渲染实文。 */
.cy-segment.cy-segment-deferred {
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border-left-color: var(--cy-border);
  min-height: 20px;
  animation: cy-segment-deferred-pulse 1.4s ease-in-out infinite;
}

@keyframes cy-segment-deferred-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.cy-media-placeholder {
  padding: 8px 11px;
  color: var(--cy-muted);
  font-size: 12px;
  background: var(--cy-surface-soft);
  border-radius: 13px;
}

.cy-response-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.cy-meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  color: var(--cy-muted);
  font-size: 11px;
  white-space: nowrap;
}

.cy-status-note {
  color: var(--cy-danger);
  font-size: 11px;
}

.cy-user-attachments {
  display: grid;
  gap: 6px;
  margin-top: 6px;
  max-width: 100%;
}

/* G4：贴图（user 消息 + assistant sticker 分段共用） */
.cy-sticker-img {
  width: 96px;
  height: 96px;
  object-fit: contain;
}
</style>
