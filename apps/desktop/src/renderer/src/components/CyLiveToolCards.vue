<!-- src/renderer/src/components/CyLiveToolCards.vue -->
<!-- 阶段 6 批次 B（Task 7）：工具实时区——CyMessageList 与 CyChatInput 之间，数据驱动渲染 liveOrder 卡片
     + 权限窗（approvalOpen 由卡片「允许此电脑操作」触发，非自动弹出）。 -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useToolStore } from '../stores/tool.store'
import CyToolCard from './CyToolCard.vue'
import CyToolApproval from './CyToolApproval.vue'
const toolStore = useToolStore()
const approvalOpen = ref(false)
function openApproval() { approvalOpen.value = true }
function closeApproval() { approvalOpen.value = false }
// L4（fix round 1）：waitingForApproval 归 false 时兜底关闭权限窗——awaiting 记录被解决（审批/超时/逐出保护外路径）
// 后不再残留 approvalOpen，防下一 awaiting 自动重弹（违背「非自动弹出」）
watch(
  () => toolStore.waitingForApproval,
  (v) => { if (!v) approvalOpen.value = false }
)
</script>
<template>
  <div class="cy-live-tools" data-testid="live-tool-cards">
    <CyToolCard v-for="rec in toolStore.liveRecords()" :key="rec.id" :record="rec"
      @open-approval="openApproval"
      @cancel="toolStore.cancel(rec.desktopCallId ?? rec.id)"
      @pick="(sid) => toolStore.pickSource(rec.desktopCallId ?? rec.id, sid)"
      @confirm-upload="() => toolStore.confirmUpload(rec.desktopCallId ?? rec.id)" />
    <CyToolApproval :open="approvalOpen" @close="closeApproval" />
  </div>
</template>
<style scoped>.cy-live-tools { padding: 0 var(--cy-space-6); }</style>
