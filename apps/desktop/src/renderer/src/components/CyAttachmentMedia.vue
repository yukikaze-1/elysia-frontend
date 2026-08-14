<script setup lang="ts">
// CyAttachmentMedia:按 kind + playable 分发。image 内联预览；video/audio 图标卡收起 + 点击展开播放（D9，不引缩略图库）；
// file 图标卡；link 卡片（D8，仅 http/https）。元素 error → attachmentsCheck 分类占位（D6，仅出错时查询）。
import { computed, ref } from 'vue'
import type { AssistantSegment, AttachmentMediaStatus, MessageAttachment } from '@shared/contracts'
import { api } from '../stores/desktop-api'
import { isPlayable } from '../utils/media'
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
      :attachment-id="attachmentId" :media-type="mediaType" :name="name" @error="onMediaError" @loaded="mediaStatus = 'ok'" />
    <CyVideoAttachment v-else-if="kind === 'video' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" @error="onMediaError" />
    <CyAudioAttachment v-else-if="kind === 'audio' && !unsupported" :attachment-id="attachmentId" :media-type="mediaType" :name="name" :size="size" @error="onMediaError" />
    <CyLinkAttachment v-else-if="kind === 'link'" :url="url" :name="name" />
    <CyAttachmentPlaceholder v-if="mediaStatus !== 'loading' && mediaStatus !== 'ok'" :status="mediaStatus" :attachment-id="attachmentId" />
    <CyFileAttachment v-else-if="kind === 'file' || unsupported" :name="name" :size="size" :media-type="mediaType" :unsupported="unsupported" />
  </div>
</template>

<style scoped>
.cy-attachment-media { display: block; max-width: 100%; }
</style>
