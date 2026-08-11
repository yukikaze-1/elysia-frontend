<script setup lang="ts">
// CyChatInput:输入区。回车发送/Shift+Enter 换行;发送按钮;sending 期间禁用(F3,Task 4 review);
// 停止按钮(activeGenerationId 存在时);断线横幅(connectionStore.state.status 为 reconnecting/error)。
import { computed, ref } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()

const draft = ref('')

const hasActiveGeneration = computed(() => !!messageStore.activeGenerationId)

/** 发送条件:非空 + 未在发送(F3)+ 有激活会话(无会话 send 直接 return,按钮同步禁用避免假死) */
const canSend = computed(
  () => draft.value.trim().length > 0 && !messageStore.sending && !!conversationStore.currentId
)

/** 断线横幅:reconnecting/error(流式不可继续,提示用户) */
const showBanner = computed(() => {
  const s = connectionStore.state.status
  return s === 'reconnecting' || s === 'error'
})
const bannerText = computed(() => {
  const s = connectionStore.state.status
  if (s === 'reconnecting') return '连接已断开,正在重连…'
  if (s === 'error') return `连接出错${connectionStore.state.lastError ? `: ${connectionStore.state.lastError}` : ''}`
  return ''
})

function send(): void {
  if (!canSend.value) return
  messageStore.send(draft.value.trim())
  draft.value = ''
}

/** 回车发送守卫:IME 组词确认期间(中文/日文输入法)Enter 是候选确认,不发送 */
function onEnter(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  send()
}

function stop(): void {
  messageStore.cancel()
}
</script>

<template>
  <footer class="cy-composer">
    <!-- 断线横幅(重连/错误时提示;connected 时隐藏) -->
    <div v-if="showBanner" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>{{ bannerText }}</span>
    </div>

    <!-- 发送/回复错误提示(P2-4):messageStore.lastError 结构化(PublicError),展示 .message -->
    <div v-if="messageStore.lastError" class="cy-banner cy-error-banner" role="alert">
      <span class="cy-banner-dot" />
      <span>发送失败:{{ messageStore.lastError.message }}</span>
    </div>

    <div class="cy-composer-box">
      <textarea
        v-model="draft"
        :disabled="messageStore.sending"
        placeholder="输入消息，Enter 发送"
        rows="1"
        aria-label="消息输入框"
        @keydown.enter.exact.prevent="onEnter"
      />
      <button
        v-if="hasActiveGeneration"
        class="cy-stop-btn"
        title="停止生成"
        aria-label="停止生成"
        @click="stop"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <button class="cy-send-btn" :disabled="!canSend" title="发送" aria-label="发送" @click="send">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
    </div>
    <div class="cy-composer-status">
      <span class="cy-muted">Enter 发送 · Shift+Enter 换行</span>
    </div>
  </footer>
</template>

<style scoped>
.cy-composer {
  padding: 10px 14px 14px;
  background: var(--cy-pane);
  border-top: 1px solid var(--cy-border);
}

.cy-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  margin-bottom: 8px;
  color: var(--cy-danger);
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  font-size: 12px;
}

.cy-banner-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cy-danger);
}

.cy-error-banner {
  border-style: dashed;
}

.cy-composer-box {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: end;
  gap: 8px;
  padding: 8px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-composer textarea {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  max-height: 72px;
  resize: none;
  padding: 7px 4px;
  color: var(--cy-text);
  background: transparent;
  border: 0;
  outline: 0;
}

.cy-composer textarea:disabled {
  color: var(--cy-muted);
  cursor: not-allowed;
}

.cy-stop-btn,
.cy-send-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
}

.cy-stop-btn {
  color: var(--cy-danger);
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
}

.cy-stop-btn:hover {
  background: var(--cy-surface-hover);
}

.cy-send-btn {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-send-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cy-composer-status {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 7px;
  color: var(--cy-muted);
  font-size: 11px;
}
</style>
