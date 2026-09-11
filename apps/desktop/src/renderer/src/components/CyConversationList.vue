<script setup lang="ts">
// CyConversationList:conversationStore.items 渲染(当前高亮)+ 新建/重命名/删除。
// 新建后调 activate(c.id)(F1,Task 4 review——create 不 reset messageStore,须显式 activate 拉起空消息)。
import { computed, ref } from 'vue'
import type { Conversation } from '@shared/contracts'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useAppStore } from '../stores/app.store'
import CyConversationCharacterPicker from './CyConversationCharacterPicker.vue'
import { errorMessage } from '../utils/error-message'

const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()
const appStore = useAppStore()

// 多套 UI 基础：store 只产 code，文案由映射器决定（此前后端/本地文案混在 store 里）
const errorText = computed(() => errorMessage(conversationStore.error, '会话操作失败，请稍后重试。'))

const items = computed(() => conversationStore.items)
const currentId = computed(() => conversationStore.currentId)

/** 操作门控(批次B T9):connected + 会话就绪 + 不在操作中;未就绪禁点新建/激活/重命名/删除 */
const canAct = computed(() => connectionStore.state.status === 'connected' && conversationStore.ready && !conversationStore.busy)
/** 打开会话门控(G2 §4.5.3):在线走 activate;离线视图走 activateLocal(读缓存)——打开按钮离线也启用,新建/重命名/删除仍连在线门控 */
const canOpen = computed(() => canAct.value || conversationStore.offlineView)
const profilesEnabled = computed(() => connectionStore.state.status === 'connected' && connectionStore.state.features?.characterProfiles === true)

const query = ref('')
const filteredItems = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter((c) => c.title.toLowerCase().includes(q))
})

const renamingId = ref<string>()
const renameDraft = ref('')
const characterPickerOpen = ref(false)
const characterPickerBusy = ref(false)

async function createLegacy(): Promise<void> {
  const conversation = await conversationStore.create()
  if (conversation?.id) await conversationStore.activate(conversation.id)
}

function create(): void {
  if (!canAct.value) return
  if (profilesEnabled.value) {
    characterPickerOpen.value = true
    return
  }
  void createLegacy()
}

async function confirmCharacter(characterId: string): Promise<void> {
  if (characterPickerBusy.value || !canAct.value || !profilesEnabled.value) return
  characterPickerBusy.value = true
  try {
    const conversation = await conversationStore.create(characterId)
    if (conversation?.id) {
      await conversationStore.activate(conversation.id)
      characterPickerOpen.value = false
    }
  } finally {
    characterPickerBusy.value = false
  }
}

function openSettings(kind: 'identity' | 'characters'): void {
  characterPickerOpen.value = false
  appStore.openSettings(kind)
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

/** UII-QQ：紧凑时间显示（updatedAt 展示层格式化，不改数据） */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** UII-QQ：空标题回退「新会话」（不显示空串/下划线） */
function displayTitle(c: Conversation): string {
  return c.title || '新会话'
}

function avatarLabel(c: Conversation): string {
  return Array.from(c.character?.displayName?.trim() || c.title?.trim() || '会')[0] ?? '会'
}

function avatarStyle(c: Conversation): Record<string, string> | undefined {
  const color = c.character?.presentation.themeColor
  return color ? { backgroundColor: color } : undefined
}

function characterLabel(c: Conversation): string {
  return c.character?.displayName || '未绑定角色'
}

/** 离线视图：点击其他缓存会话 → activateLocal（P1-1 绕过 api.activate/getMessages）；在线 → 既有 activate */
function activateConv(id: string): void {
  if (connectionStore.state.status === 'disconnected') void conversationStore.activateLocal(id)
  else void conversationStore.activate(id)
}
</script>

<template>
  <aside class="cy-conversations">
    <div class="cy-pane-heading">
      <h2>会话</h2>
      <button class="cy-icon-button" title="新建会话" aria-label="新建会话" :disabled="!canAct" @click="create">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <!-- 会话操作错误短横幅(批次B T9):conversationStore.error 结构化展示 -->
    <div v-if="conversationStore.error" class="cy-conversation-error" role="alert">{{ errorText }}</div>

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
        <button v-if="renamingId !== c.id" class="cy-conversation-main" :aria-pressed="currentId === c.id" :disabled="!canOpen" @click="activateConv(c.id)">
          <span class="cy-conversation-avatar" :style="avatarStyle(c)">{{ avatarLabel(c) }}</span>
          <span class="cy-conversation-copy">
            <span class="cy-conversation-row1">
              <span class="cy-conversation-title">{{ displayTitle(c) }}</span>
              <span class="cy-conversation-time">{{ formatTime(c.updatedAt) }}</span>
            </span>
            <span class="cy-conversation-preview">{{ c.preview || '暂无消息' }}</span>
            <span class="cy-conversation-character">{{ characterLabel(c) }}</span>
          </span>
        </button>
        <div v-else class="cy-conversation-main cy-conversation-renaming">
          <span class="cy-conversation-avatar" :style="avatarStyle(c)">{{ avatarLabel(c) }}</span>
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
          <button class="cy-row-btn" title="重命名" aria-label="重命名" :disabled="!canAct" @click="startRename(c)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
          <button class="cy-row-btn" title="删除" aria-label="删除" :disabled="!canAct" @click="remove(c)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        </div>
      </div>

      <p v-if="filteredItems.length === 0" class="cy-conversation-empty">暂无会话</p>
    </div>
  </aside>
  <CyConversationCharacterPicker
    :open="characterPickerOpen"
    :busy="characterPickerBusy || conversationStore.busy"
    :remote-available="connectionStore.state.status === 'connected' && profilesEnabled"
    @close="characterPickerOpen = false"
    @confirm="confirmCharacter"
    @open-settings="openSettings"
  />
</template>

<style scoped>
.cy-conversations {
  grid-area: conv;
  min-width: 0;
  padding: var(--cy-space-7) var(--cy-space-5);
  background: color-mix(in srgb, var(--cy-surface) 48%, transparent);
  border-right: 1px solid var(--cy-border);
  backdrop-filter: blur(18px) saturate(110%);
  overflow-y: auto;
}

.cy-pane-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--cy-space-5);
}

.cy-pane-heading h2 {
  margin: 0;
  font-size: var(--cy-font-base);
  font-weight: 500;
}

.cy-icon-button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-5);
  background: var(--cy-accent-tint);
  color: var(--cy-accent-strong);
  transition: background var(--cy-motion-fast) ease, transform var(--cy-motion-fast) ease;
}

.cy-icon-button:hover {
  background: var(--cy-surface-hover);
  transform: translateY(-1px);
}

.cy-icon-button:disabled,
.cy-conversation-main:disabled,
.cy-row-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-conversation-error {
  padding: var(--cy-space-3) var(--cy-space-4-5);
  margin-bottom: var(--cy-space-4);
  color: var(--cy-danger);
  background: var(--cy-surface-soft);
  border: 1px dashed var(--cy-border);
  border-radius: var(--cy-radius-4);
  font-size: var(--cy-font-md);
  overflow-wrap: anywhere;
}

.cy-search {
  display: flex;
  align-items: center;
  gap: var(--cy-space-3-5);
  padding: var(--cy-space-3-5) var(--cy-space-4-5);
  margin-bottom: var(--cy-space-5);
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-5);
  transition: border-color var(--cy-motion-fast) ease, box-shadow var(--cy-motion-fast) ease;
}

.cy-search:focus-within {
  border-color: var(--cy-accent-strong);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cy-accent-strong) 12%, transparent);
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
  gap: var(--cy-space-3);
}

.cy-conversation {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border-radius: var(--cy-radius-6);
}

.cy-conversation:hover {
  background: var(--cy-surface-hover);
}

/* UII-QQ：选中态用柔和 tint 底，不再依赖过重 accent 边框/色块 */
.cy-conversation.is-active {
  background: var(--cy-accent-tint);
}

.cy-conversation.is-active .cy-conversation-title {
  color: var(--cy-text);
  font-weight: 500;
}

.cy-conversation-main {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: var(--cy-space-4-5);
  width: 100%;
  padding: var(--cy-space-4-5);
  text-align: left;
  background: transparent;
  border: 0;
}

.cy-conversation-avatar {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--cy-radius-6);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  font-size: var(--cy-font-base);
}

.cy-conversation-copy {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-1);
  min-width: 0;
}

.cy-conversation-row1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--cy-space-4);
}

.cy-conversation-title,
.cy-conversation-preview {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-conversation-title {
  min-width: 0;
  font-size: var(--cy-font-lg);
}

/* UII-QQ：紧凑时间（今天 HH:mm / 昨天 / M/D / YYYY/M/D） */
.cy-conversation-time {
  flex: 0 0 auto;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-conversation-preview {
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
}

.cy-conversation-character {
  display: block;
  overflow: hidden;
  color: var(--cy-muted);
  font-size: var(--cy-font-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-conversation-actions {
  display: none;
  gap: var(--cy-space-1);
  padding-right: var(--cy-space-3);
}

/* hover / 键盘聚焦（focus-within）都可达（红线 §7） */
.cy-conversation:hover .cy-conversation-actions,
.cy-conversation:focus-within .cy-conversation-actions {
  display: flex;
}

.cy-row-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--cy-radius-3-5);
  color: var(--cy-muted);
}

.cy-row-btn:hover {
  color: var(--cy-text);
  background: var(--cy-surface);
}

.cy-rename-input {
  width: 100%;
  min-width: 0;
  padding: var(--cy-space-2) var(--cy-space-3);
  color: var(--cy-text);
  background: var(--cy-surface);
  border: 1px solid var(--cy-accent-strong);
  border-radius: var(--cy-radius-3-5);
  outline: 0;
  font-size: var(--cy-font-lg);
}

.cy-conversation-empty {
  margin: var(--cy-space-7) 0 0;
  text-align: center;
  color: var(--cy-muted);
  font-size: var(--cy-font-md);
}
</style>
