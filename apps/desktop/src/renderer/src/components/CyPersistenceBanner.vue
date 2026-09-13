<!--
  CyPersistenceBanner —— 本地持久化故障的**全局**出口（H-11b renderer 半边，2026-09-13）。

  为什么是全局而不是聊天区横幅：降级挡住的不止草稿——`SessionStore` 同时负责
  drafts-v1.json（草稿/锚点/lastActive）与 message-cache-v1.json（会话列表+消息快照），
  换个视图也一样不写盘。挂在 App 根部（与 CyRendererCrashBanner 同款位置）才不会
  「切到设置页就看不见了」。

  文案纪律：措辞来自 `errorMessage()`（单一来源），本组件不产出用户措辞；只把 Main 的
  **无路径**投影（文件名基名 + 封闭触发标签）作为次要详情行显示。
-->
<template>
  <div v-if="failure" class="cy-persist-banner" role="alert" data-testid="persistence-banner">
    <span class="cy-persist-dot" aria-hidden="true" />
    <div class="cy-persist-text">
      <span class="cy-persist-title">{{ title }}</span>
      <span v-if="detail" class="cy-persist-detail" data-testid="persistence-banner-detail">{{ detail }}</span>
    </div>
    <span class="cy-persist-hint">{{ hint }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDraftStore } from '../stores/draft.store'
import { errorMessage } from '../utils/error-message'

const draftStore = useDraftStore()
const failure = computed(() => draftStore.persistenceFailure)

const title = computed(() => errorMessage(
  failure.value ? { code: failure.value.code, message: '' } : undefined,
  '本地保存失败：草稿与离线缓存没有被写入磁盘。'
))

/** 次要详情：只显示 Main 给的无路径投影（如 `drafts-v1.json · schema-version-mismatch:99`） */
const detail = computed(() => {
  const f = failure.value
  if (!f?.file) return ''
  return f.reason ? `${f.file} · ${f.reason}` : f.file
})

/**
 * 两种故障的**动作建议必须不同**，这是本组件存在的理由：
 * 降级态是「故意不写」——现场被保留，重启不会自己好，需要用户先处置那个文件；
 * 单次写失败是「这次没写成」——内存态仍在，后续写入会重试。
 */
const hint = computed(() => (failure.value?.code === 'PERSISTENCE_DEGRADED'
  ? '已输入内容仍在本窗口内；请先备份该文件再重启，否则本次改动会丢失。'
  : '已输入内容仍在本窗口内；恢复磁盘可写后会自动重试。'))
</script>

<style scoped>
.cy-persist-banner {
  position: sticky;
  top: 0;
  z-index: 51;
  display: flex;
  align-items: center;
  gap: var(--cy-space-4);
  padding: var(--cy-space-3) var(--cy-space-6);
  color: var(--cy-warning-text);
  background: var(--cy-surface-strong);
  border-bottom: 1px solid var(--cy-border);
  font-size: var(--cy-font-md);
}

.cy-persist-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: var(--cy-radius-circle);
  background: var(--cy-warning);
}

.cy-persist-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cy-persist-title {
  font-weight: 600;
}

.cy-persist-detail {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  overflow-wrap: anywhere;
}

.cy-persist-hint {
  margin-left: auto;
  color: var(--cy-text);
  font-size: var(--cy-font-sm);
  text-align: right;
}
</style>
