<script setup lang="ts">
// CyAttachmentPlaceholder:spec §4.7 状态占位表——expired/not_found/revoked/error 可解释文案 + 重试/刷新。
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
