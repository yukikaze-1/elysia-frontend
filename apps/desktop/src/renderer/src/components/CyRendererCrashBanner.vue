<template>
  <div v-if="crash" class="cy-crash-banner" role="alert">
    <span>页面已重启，进行中的回复可能中断</span>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../stores/desktop-api'
const crash = ref<{ reason: string; exitCode: number } | null>(null)
onMounted(async () => {
  // D7B-05 修正：renderer 崩溃时收不到 push——改为 bootstrap 经 getLastCrash 读 marker（读后 Main 清空）
  try { crash.value = await api.getLastCrash() } catch { /* fail-open：读失败不显示 */ }
})
</script>
<style scoped>
.cy-crash-banner { position: sticky; top: 0; z-index: 50; background: #3a2a18; color: #f0c674; padding: var(--cy-space-3) var(--cy-space-6); font-size: var(--cy-font-lg); }
</style>
