<script setup lang="ts">
// CyConversationList:conversationStore.items 渲染(当前高亮)+ 新建/重命名/删除。
// 新建后调 activate(c.id)(F1,Task 4 review——create 不 reset messageStore,须显式 activate 拉起空消息)。
import { computed, onMounted, ref } from 'vue'
import type { Conversation } from '@shared/contracts'
import { useConversationStore } from '../stores/conversation.store'

const conversationStore = useConversationStore()

const items = computed(() => conversationStore.items)
const currentId = computed(() => conversationStore.currentId)

const query = ref('')
const filteredItems = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter((c) => c.title.toLowerCase().includes(q))
})

const renamingId = ref<string>()
const renameDraft = ref('')

async function create(): Promise<void> {
  await conversationStore.create()
  const id = conversationStore.currentId
  if (id) await conversationStore.activate(id)
}

function startRename(c: Conversation): void {
  renamingId.value = c.id
  renameDraft.value = c.title
}

async function commitRename(): Promise<void> {
  const id = renamingId.value
  if (!id) return
  const title = renameDraft.value.trim()
  if (title) await conversationStore.rename({ conversationId: id, title })
  renamingId.value = undefined
}

function cancelRename(): void {
  renamingId.value = undefined
}

function remove(c: Conversation): void {
  if (window.confirm(`删除会话「${c.title}」?`)) void conversationStore.remove(c.id)
}

onMounted(() => {
  void conversationStore.list()
})
</script>

<template>
  <aside class="cy-conversations">
    <div class="cy-pane-heading">
      <h2>会话</h2>
      <button class="cy-icon-button" title="新建会话" aria-label="新建会话" @click="create">
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
      <div
        v-for="c in filteredItems"
        :key="c.id"
        class="cy-conversation"
        :class="{ 'is-active': currentId === c.id }"
      >
        <!-- 常规态:整行可点激活;重命名态:标题换输入框(按钮内不放 input) -->
        <button v-if="renamingId !== c.id" class="cy-conversation-main" :aria-pressed="currentId === c.id" @click="conversationStore.activate(c.id)">
          <span class="cy-conversation-avatar">{{ c.title.slice(0, 1) }}</span>
          <span class="cy-conversation-copy">
            <span class="cy-conversation-title">{{ c.title }}</span>
            <span class="cy-conversation-preview">{{ c.preview || '—' }}</span>
          </span>
        </button>
        <div v-else class="cy-conversation-main cy-conversation-renaming">
          <span class="cy-conversation-avatar">{{ c.title.slice(0, 1) }}</span>
          <input
            v-model="renameDraft"
            class="cy-rename-input"
            aria-label="会话名称"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
        </div>
        <div class="cy-conversation-actions">
          <button class="cy-row-btn" title="重命名" aria-label="重命名" @click="startRename(c)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
          <button class="cy-row-btn" title="删除" aria-label="删除" @click="remove(c)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        </div>
      </div>

      <p v-if="filteredItems.length === 0" class="cy-conversation-empty">暂无会话</p>
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

.cy-icon-button:hover {
  background: var(--cy-surface-hover);
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
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border-radius: 12px;
}

.cy-conversation:hover {
  background: var(--cy-surface-hover);
}

.cy-conversation.is-active {
  background: var(--cy-accent);
}

.cy-conversation-main {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  padding: 9px;
  text-align: left;
  background: transparent;
  border: 0;
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

.cy-conversation-actions {
  display: none;
  gap: 2px;
  padding-right: 6px;
}

.cy-conversation:hover .cy-conversation-actions {
  display: flex;
}

.cy-row-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--cy-muted);
}

.cy-row-btn:hover {
  color: var(--cy-text);
  background: var(--cy-surface);
}

.cy-rename-input {
  width: 100%;
  min-width: 0;
  padding: 4px 6px;
  color: var(--cy-text);
  background: var(--cy-surface);
  border: 1px solid var(--cy-accent-strong);
  border-radius: 7px;
  outline: 0;
  font-size: 13px;
}

.cy-conversation-empty {
  margin: 14px 0 0;
  text-align: center;
  color: var(--cy-muted);
  font-size: 12px;
}
</style>
