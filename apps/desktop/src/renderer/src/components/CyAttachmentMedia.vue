<script setup lang="ts">
// CyAttachmentMedia:按 kind + playable 分发。image 内联预览；video/audio 图标卡收起 + 点击展开播放（D9，不引缩略图库）；
// file 图标卡；link 卡片（D8，仅 http/https）。元素 error → attachmentsCheck 分类占位（D6，仅出错时查询）。
// P1-2：占位「重试/刷新」emit 结果 → 重查 ok 时重挂载媒体（mediaStatus 回 loading + nonce 换 URL，Main 重新 resolve/重签）。
// P2-8：媒体元素与占位互斥——mediaStatus 出错即卸载（占位显示），对齐 image 分支。
// 2026-09-10 修复：把「附件状态」与「本机渲染结果」拆成两个信号。原实现把 attachmentsCheck 的
// ok 直接写回 mediaStatus，于是「字节完好但浏览器解不开（截断图片/不支持的容器）」时元素保持损坏、
// 占位永不出现——用户面对一个静默损坏的媒体元素，既无解释也无重试入口。现在 ok 只表示附件可用，
// 渲染失败由独立的 mediaRenderFailed 表达，并渲染可重试的失败占位。
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

/** 附件可用但本机无法渲染（解码/容器不受支持）时的兜底文案 */
const RENDER_FAILED_TEXT = '无法显示该附件'

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
// 渲染失败独立于 attachmentStatus：它描述「本机渲染结果」，不是「附件在服务端的状态」
const mediaRenderFailed = ref(false)
const retryNonce = ref(0)
// loading 首帧不是失败：占位只在「分类查询给出非 ok 状态」或「本机渲染失败」时出现
const showPlaceholder = computed(() => mediaRenderFailed.value || (mediaStatus.value !== 'loading' && mediaStatus.value !== 'ok'))
/** 占位的状态入参：渲染失败借 'error' 表达（可重试），loading/ok 不渲染占位 */
const placeholderStatus = computed<AttachmentMediaStatus | undefined>(() => {
  if (mediaRenderFailed.value) return 'error'
  const status = mediaStatus.value
  return status === 'loading' || status === 'ok' ? undefined : status
})
const unsupported = computed(() => {
  if (props.kind !== 'video' && props.kind !== 'audio') return false
  const mime = props.mediaType ?? ''
  return mime.length > 0 && !isPlayable(props.kind, mime)
})

async function onMediaError(): Promise<void> {
  // 无 attachmentId（理论上不会渲染出媒体元素）时没有可查询的分类，只能表达为加载失败
  if (!props.attachmentId) { mediaStatus.value = 'error'; return }
  try {
    const r = await api.attachmentsCheck(props.attachmentId)
    // 分类 ok = 附件本身可用；此时元素仍损坏说明是本机渲染失败，必须区别于「附件有问题」
    if (r.status === 'ok') { mediaRenderFailed.value = true; return }
    mediaStatus.value = r.status
  } catch {
    mediaStatus.value = 'error'
  }
}

/** P1-2：占位「重试/刷新」——重挂载（nonce 换 URL 强制重新请求，Main 重新 resolve/重签）；
 *  真实状态非 ok → 更新为最新状态文案 */
function onPlaceholderRetry(result: AttachmentCheckResult): void {
  const d = retryDecision(result)
  if (d === 'remount') {
    // 重挂载必须清掉渲染失败标记，否则占位不会让位给重新请求的媒体元素
    mediaRenderFailed.value = false
    mediaStatus.value = 'loading'
    retryNonce.value++
  } else {
    mediaRenderFailed.value = false
    mediaStatus.value = d
  }
}
</script>

<template>
  <div class="cy-attachment-media">
    <CyAttachmentPlaceholder
      v-if="showPlaceholder"
      :status="placeholderStatus"
      :attachment-id="attachmentId"
      :message="mediaRenderFailed ? RENDER_FAILED_TEXT : undefined"
      @retry="onPlaceholderRetry"
    />
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
