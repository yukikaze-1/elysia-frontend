<script setup lang="ts">
// CyAttachmentMedia:按 kind + playable 分发。image 内联预览；video/audio 图标卡收起 + 点击展开播放（D9，不引缩略图库）；
// file 图标卡；link 卡片（D8，仅 http/https）。元素 error → attachmentsCheck 分类占位（D6，仅出错时查询）。
// P1-2：占位「重试/刷新」emit 结果 → 重查 ok 时重挂载媒体（mediaStatus 回 loading + nonce 换 URL，Main 重新 resolve/重签）。
// P2-8：媒体元素与占位互斥——mediaStatus 出错即卸载（占位显示），对齐 image 分支。
import { computed, ref } from 'vue'
import type { AssistantSegment, AttachmentCheckResult, AttachmentMediaStatus, MessageAttachment } from '@shared/contracts'
import { api } from '../stores/desktop-api'
import { isPlayable } from '../utils/media'
import { retryDecision } from '../attachments/attachment-media'
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
const retryNonce = ref(0)
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

/** P1-2：占位「重试/刷新」——重查 ok → 重挂载（mediaStatus 回 loading + nonce 换 URL 强制重新请求，Main 重新 resolve/重签）；
 *  仍非 ok → 更新为最新状态文案 */
function onPlaceholderRetry(result: AttachmentCheckResult): void {
  const d = retryDecision(result)
  if (d === 'remount') {
    mediaStatus.value = 'loading'
    retryNonce.value++
  } else {
    mediaStatus.value = d
  }
}
</script>

<template>
  <div class="cy-attachment-media">
    <CyAttachmentPlaceholder v-if="mediaStatus !== 'loading' && mediaStatus !== 'ok'" :status="mediaStatus" :attachment-id="attachmentId" @retry="onPlaceholderRetry" />
    <template v-else>
      <CyImageAttachment v-if="kind === 'image'" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :nonce="retryNonce" @error="onMediaError" @loaded="mediaStatus = 'ok'" />
      <CyVideoAttachment v-else-if="kind === 'video' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" :nonce="retryNonce" @error="onMediaError" />
      <CyAudioAttachment v-else-if="kind === 'audio' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" :nonce="retryNonce" @error="onMediaError" />
      <CyLinkAttachment v-else-if="kind === 'link'" :url="url" :name="name" />
      <CyFileAttachment v-else-if="kind === 'file' || unsupported" :name="name" :size="size" :media-type="mediaType" :unsupported="unsupported" />
    </template>
  </div>
</template>

<style scoped>
.cy-attachment-media { display: block; max-width: 100%; }
</style>
