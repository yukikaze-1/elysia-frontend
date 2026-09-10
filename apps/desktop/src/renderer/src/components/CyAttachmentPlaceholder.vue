<script setup lang="ts">
// CyAttachmentPlaceholder:spec §4.7 状态占位表——expired/not_found/revoked/error 可解释文案 + 重试/刷新。
// P1-2：retry 不再丢弃 attachmentsCheck 结果——emit('retry', result)，父组件据此重挂载媒体（ok）或更新状态文案。
// 2026-09-10：新增可选 message 覆盖文案——「附件可用但本机渲染失败」不是附件状态问题，
// 沿用「加载失败」会误导用户去重试一个其实完好的附件。
import { ref } from 'vue'
import type { AttachmentCheckResult, AttachmentMediaStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'
const props = defineProps<{ status?: AttachmentMediaStatus; attachmentId?: string; message?: string }>()
const emit = defineEmits<{ retry: [result: AttachmentCheckResult] }>()
const retrying = ref(false)
const TEXT: Record<AttachmentMediaStatus, string> = {
  ok: '', expired: '附件已过期', not_found: '附件不存在', revoked: '附件已撤销', error: '加载失败'
}
const label = (): string => props.message || (props.status ? TEXT[props.status] : '')
async function retry(): Promise<void> {
  if (!props.attachmentId) return
  retrying.value = true
  try {
    const r = await api.attachmentsCheck(props.attachmentId)
    emit('retry', r)
  } catch {
    emit('retry', { status: 'error', reason: 'check_failed' })
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div v-if="status && status !== 'ok'" class="cy-placeholder" role="status">
    <span>{{ label() }}</span>
    <button v-if="status === 'error' || status === 'expired'" class="cy-placeholder-action" :disabled="retrying" @click="retry">
      {{ status === 'expired' ? '刷新' : '重试' }}
    </button>
  </div>
</template>

<style scoped>
.cy-placeholder { display: inline-flex; align-items: center; gap: 8px; padding: 7px 11px; border-radius: 10px; color: var(--cy-muted); background: var(--cy-surface-soft); border: 1px dashed var(--cy-border); font-size: 12px; }
.cy-placeholder-action { padding: 2px 8px; border-radius: 999px; color: var(--cy-accent-text); background: var(--cy-accent); font-size: 11px; }
</style>
