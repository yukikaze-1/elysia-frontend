<!-- src/renderer/src/components/CyToolCard.vue -->
<!-- 阶段 6 批次 B（Task 7）：工具卡片——数据驱动；只读模式（归档卡片）；授权入口；capture 面板分支。
     awaiting 态提供「允许此电脑操作」（打开权限窗）+「拒绝」对等按钮；取消按钮为独立 v-if（H13：
     与 awaiting 按钮并存，非 v-else-if——awaiting 态也有取消入口，Task 8 集成测试依赖）。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCallRecord } from '@shared/contracts/tool'
import { useToolStore } from '../stores/tool.store'

const props = defineProps<{ record: ToolCallRecord; readonly?: boolean }>()
const emit = defineEmits<{ openApproval: []; cancel: []; pick: [sourceId: string]; confirmUpload: [] }>()
const toolStore = useToolStore()
const STATUS_TEXT: Record<string, string> = {
  requested: '等待授权', awaiting_permission: '等待授权', running: '正在执行', completed: '执行完成',
  failed: '执行失败', rejected: '用户已拒绝', cancelled: '已取消', timeout: '已超时',
}
const statusText = computed(() => STATUS_TEXT[props.record.status] ?? props.record.status)
const isBackend = computed(() => props.record.runtime === 'backend')
const awaiting = computed(() => props.record.status === 'awaiting_permission' && !props.readonly)
const isCapture = computed(() => props.record.toolName === 'desktop.screen.capture')
// L3（fix round 1）：pathSummary 按 record 的 callId 绑定（pendingPathSummary 侧信道 callId 匹配才展示，
// 不串到其它卡片）
const pathSummary = computed(() => {
  if (props.readonly) return undefined
  const p = toolStore.pendingPathSummary
  return p && p.callId === (props.record.desktopCallId ?? props.record.id) ? p.pathSummary : undefined
})
</script>

<template>
  <div class="cy-tool-card" :data-status="record.status" :data-runtime="record.runtime">
    <div class="cy-tool-head">
      <span class="cy-tool-badge" :class="isBackend ? 'is-backend' : 'is-desktop'">{{ isBackend ? '后端' : '此电脑' }}</span>
      <span class="cy-tool-title">{{ record.toolName.startsWith('desktop.') ? record.toolName.slice('desktop.'.length) : record.toolName }}</span>
      <span class="cy-tool-status" data-testid="tool-status">{{ statusText }}</span>
    </div>
    <p v-if="pathSummary" class="cy-tool-path" data-testid="tool-path">{{ pathSummary }}</p>
    <p v-if="record.inputSummary" class="cy-tool-summary">{{ record.inputSummary }}</p>
    <p v-if="record.outputSummary" class="cy-tool-result">{{ record.outputSummary }}<template v-if="record.truncated">…（已截断）</template></p>
    <p v-if="record.error?.message" class="cy-tool-error">{{ record.error.message }}</p>
    <p v-if="record.attachmentCount" class="cy-tool-attachments">含 {{ record.attachmentCount }} 个附件</p>
    <p v-if="record.startedAt" class="cy-tool-time">{{ record.startedAt.slice(0, 19).replace('T', ' ') }}<template v-if="record.finishedAt"> → {{ record.finishedAt.slice(0, 19).replace('T', ' ') }}</template></p>
    <!-- 批次 C（F-4）：grant 命中自动执行路径的完成记录携带 diff（F-7 契约 ToolCallRecord.diff，终态不清）→
         只读 Diff 信息条（无确认按钮——approval-diff 仅权限窗） -->
    <div v-if="record.diff && !isBackend" class="cy-tool-diff-readonly" data-testid="tool-diff-readonly">
      <span class="cy-tool-diff-note">{{ record.diff.formatNote }}</span>
      <pre class="cy-diff-body" data-testid="tool-diff-body"><template v-for="(l, i) in record.diff.lines" :key="i"><span :class="`cy-diff-${l.kind}`">{{ l.text }}</span></template></pre>
    </div>
    <div v-if="!isBackend" class="cy-tool-actions">
      <template v-if="awaiting">
        <button type="button" class="cy-btn cy-btn-approve" data-testid="tool-approve" @click="emit('openApproval')">允许此电脑操作</button>
        <button type="button" class="cy-btn" data-testid="tool-deny" @click="toolStore.decide(record.desktopCallId ?? record.id, 'deny')">拒绝</button>
      </template>
      <button v-if="!['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(record.status)" type="button"
              class="cy-btn cy-btn-cancel" data-testid="tool-cancel" @click="emit('cancel')">取消任务</button>   <!-- H13：独立 v-if（与 awaiting 并存，非 v-else-if）——awaiting 态也有取消入口（Task 8 集成依赖） -->
    </div>
    <div v-if="isCapture && toolStore.captureState && !props.readonly" class="cy-tool-capture" data-testid="tool-capture-panel">
      <div v-if="toolStore.captureState.sources && !toolStore.captureState.preview" class="cy-capture-sources">
        <button v-for="s in toolStore.captureState.sources" :key="s.sourceId" type="button" class="cy-capture-source"
                data-testid="capture-source" @click="emit('pick', s.sourceId)">
          <img :src="s.thumbnailDataUrl" alt="" /><span>{{ s.sourceName }}</span>
        </button>
      </div>
      <div v-else-if="toolStore.captureState.preview" class="cy-capture-preview">
        <img :src="toolStore.captureState.preview.previewDataUrl" alt="截图预览" />
        <button type="button" class="cy-btn cy-btn-approve" data-testid="capture-confirm" @click="emit('confirmUpload')">确认上传</button>
        <button type="button" class="cy-btn" @click="toolStore.cancel(record.desktopCallId ?? record.id)">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-tool-card { border: 1px solid var(--cy-border); border-radius: 8px; padding: 8px 10px; margin: 4px 0; font-size: 12px; background: var(--cy-bg-sub); }
.cy-tool-head { display: flex; gap: 8px; align-items: center; }
.cy-tool-badge { padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.cy-tool-badge.is-backend { background: var(--cy-bg-muted); color: var(--cy-text-muted); }
.cy-tool-badge.is-desktop { background: var(--cy-accent-weak, rgba(0,120,255,.15)); color: var(--cy-accent, #1a66ff); }
.cy-tool-status { margin-left: auto; color: var(--cy-text-muted); }
.cy-tool-path, .cy-tool-summary, .cy-tool-result, .cy-tool-error, .cy-tool-attachments, .cy-tool-time { margin: 4px 0 0; color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-tool-error { color: var(--cy-danger, #d33); }
.cy-tool-actions { margin-top: 6px; display: flex; gap: 8px; }
.cy-btn { padding: 3px 10px; border: 1px solid var(--cy-border); border-radius: 6px; background: var(--cy-bg); cursor: pointer; }
.cy-btn-approve { border-color: var(--cy-accent, #1a66ff); color: var(--cy-accent, #1a66ff); }
.cy-capture-sources { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.cy-capture-source { border: 1px solid var(--cy-border); border-radius: 6px; padding: 4px; background: var(--cy-bg); cursor: pointer; }
.cy-capture-source img { width: 120px; height: 90px; object-fit: cover; display: block; }
.cy-capture-preview img { max-width: 100%; border-radius: 6px; }
.cy-capture-preview { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.cy-tool-diff-readonly { margin-top: 6px; }
.cy-tool-diff-note { color: var(--cy-text-muted); font-size: 11px; }
.cy-diff-body { background: var(--cy-bg); padding: 4px; border-radius: 6px; max-height: 160px; overflow: auto; margin: 2px 0 0; font-size: 11px; white-space: pre-wrap; }
.cy-diff-added { color: var(--cy-diff-add, #18794e); }
.cy-diff-removed { color: var(--cy-diff-del, #cd2b3a); }
</style>
