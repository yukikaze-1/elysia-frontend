<script setup lang="ts">
import { ref } from 'vue'

// Phase 0 静态演示数据(与 Mock Backend 的会话一致);真实数据来自 conversationStore(阶段 2)
const conversations = [
  { id: 'conv-1001', title: '流式回复演示', preview: '好的，我来回答…', time: '刚刚', active: true },
  { id: 'conv-1002', title: '历史会话示例', preview: '', time: '昨天', active: false }
]

const selected = ref('conv-1001')
const query = ref('')
</script>

<template>
  <aside class="cy-conversations">
    <div class="cy-pane-heading">
      <h2>会话</h2>
      <button class="cy-icon-button" title="新建会话" aria-label="新建会话">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div class="cy-search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4-4" />
      </svg>
      <input v-model="query" type="search" placeholder="搜索会话" aria-label="搜索会话" />
    </div>

    <div class="cy-conversation-list">
      <button
        v-for="c in conversations"
        :key="c.id"
        class="cy-conversation"
        :class="{ 'is-active': selected === c.id }"
        :aria-pressed="selected === c.id"
        @click="selected = c.id"
      >
        <span class="cy-conversation-avatar">{{ c.title.slice(0, 1) }}</span>
        <span class="cy-conversation-copy">
          <span class="cy-conversation-title">{{ c.title }}</span>
          <span class="cy-conversation-preview">{{ c.preview || c.time }}</span>
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.cy-conversations {
  min-width: 0;
  padding: 14px 10px;
  background: var(--cy-pane);
  border-right: 1px solid var(--cy-border);
  overflow-y: auto;
}

.cy-pane-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.cy-pane-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.cy-icon-button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  background: var(--cy-surface);
  color: var(--cy-muted);
}

.cy-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  margin-bottom: 10px;
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 10px;
}

.cy-search input {
  width: 100%;
  min-width: 0;
  padding: 0;
  color: var(--cy-text);
  background: transparent;
  border: 0;
  outline: 0;
}

.cy-conversation-list {
  display: grid;
  gap: 6px;
}

.cy-conversation {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  padding: 9px;
  text-align: left;
  border-radius: 12px;
}

.cy-conversation:hover {
  background: var(--cy-surface-hover);
}

.cy-conversation.is-active {
  background: var(--cy-accent);
}

.cy-conversation-avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: var(--cy-accent-text);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
}

.cy-conversation-copy {
  min-width: 0;
}

.cy-conversation-title,
.cy-conversation-preview {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-conversation-title {
  font-size: 13px;
}

.cy-conversation-preview {
  color: var(--cy-muted);
  font-size: 12px;
}
</style>
