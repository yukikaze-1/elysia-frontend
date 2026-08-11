<script setup lang="ts">
// CyChatView:聊天主区——messageStore.byId/order 渲染 + 空态 + 流式占位「生成中…」;
// conversationStore 激活/新建(F1:create 不 reset messageStore,新建后须显式 activate(c.id));
// 连接控件:serverUrl 输入 + 连接按钮(connectionStore.connect,Mock 免 token)。
import { computed, nextTick, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import CyChatInput from './CyChatInput.vue'
import CyMessageBubble from './CyMessageBubble.vue'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()

const serverUrl = ref('ws://localhost:8080')
const messagesRef = ref<HTMLElement>()

const visibleIds = computed(() => messageStore.order.filter((id) => !!messageStore.byId[id]))
const isEmpty = computed(() => visibleIds.value.length === 0)
const isStreaming = computed(() => !!messageStore.activeGenerationId)

const convTitle = computed(() => {
  const c = conversationStore.items.find((i) => i.id === conversationStore.currentId)
  return c?.title ?? '新会话'
})

/** 连接状态展示:状态点 tone + 文案 */
const statusTone = computed(() => {
  switch (connectionStore.state.status) {
    case 'connected':
      return 'is-connected'
    case 'connecting':
    case 'reconnecting':
      return 'is-connecting'
    case 'error':
      return 'is-error'
    default:
      return 'is-offline'
  }
})
const statusLabel = computed(() => {
  switch (connectionStore.state.status) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '重连中…'
    case 'error':
      return '连接错误'
    default:
      return '未连接'
  }
})

async function connect(): Promise<void> {
  const url = serverUrl.value.trim()
  if (!url || connectionStore.connecting) return
  await connectionStore.connect(url)
}

/** F1(Task 4 review):create 只设 currentId、不 reset messageStore——新建后显式 activate(c.id) 拉起空消息页 */
async function newConversation(): Promise<void> {
  await conversationStore.create()
  const id = conversationStore.currentId
  if (id) await conversationStore.activate(id)
}

/** 流式期间跟随滚动到底;切会话(visibleIds 长度变化)也回底 */
watch([visibleIds, isStreaming], async () => {
  await nextTick()
  if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight
})
</script>

<template>
  <section class="cy-chat">
    <header class="cy-chat-header">
      <div class="cy-chat-heading">
        <div class="cy-chat-title-line">
          <span class="cy-online-dot" :class="statusTone" />
          <h2>{{ convTitle }}</h2>
          <span class="cy-status-text">{{ statusLabel }}</span>
        </div>
      </div>
      <div class="cy-header-actions">
        <button class="cy-action-button" title="新建会话" @click="newConversation">新建</button>
        <form class="cy-connect" @submit.prevent="connect">
          <input
            v-model="serverUrl"
            class="cy-server-input"
            type="text"
            placeholder="服务器地址"
            aria-label="服务器地址"
            :disabled="connectionStore.connecting"
          />
          <button class="cy-action-button cy-connect-btn" type="submit" :disabled="connectionStore.connecting">
            {{ connectionStore.connecting ? '连接中…' : '连接' }}
          </button>
        </form>
      </div>
    </header>

    <div ref="messagesRef" class="cy-messages" aria-live="polite">
      <div v-if="isEmpty" class="cy-empty">
        <p>新会话,开始对话</p>
      </div>
      <template v-else>
        <CyMessageBubble v-for="id in visibleIds" :key="id" :message="messageStore.byId[id]" />
      </template>

      <!-- 流式占位:activeGenerationId 存在时显示 -->
      <div v-if="isStreaming" class="cy-streaming-placeholder">
        <span class="cy-typing-dot" />
        <span>生成中…</span>
      </div>
    </div>

    <CyChatInput />
  </section>
</template>

<style scoped>
.cy-chat {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.cy-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 62px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--cy-border);
}

.cy-chat-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cy-chat-heading h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.cy-online-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cy-muted);
}

.cy-online-dot.is-connected {
  background: var(--cy-success);
}

.cy-online-dot.is-connecting {
  background: var(--cy-warning);
}

.cy-online-dot.is-error {
  background: var(--cy-danger);
}

.cy-online-dot.is-offline {
  background: var(--cy-muted);
}

.cy-status-text {
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-header-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.cy-action-button {
  padding: 7px 11px;
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  background: var(--cy-surface);
  color: var(--cy-muted);
  font-size: 12px;
  white-space: nowrap;
}

.cy-action-button:hover {
  background: var(--cy-surface-hover);
}

.cy-action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-connect {
  display: flex;
  align-items: center;
  gap: 7px;
}

.cy-server-input {
  width: 180px;
  padding: 7px 10px;
  color: var(--cy-text);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  outline: 0;
  font-size: 12px;
}

.cy-server-input:focus {
  border-color: var(--cy-accent-strong);
}

.cy-connect-btn {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-messages {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 9px;
  min-height: 0;
  padding: 12px 16px;
  overflow-y: auto;
  background: linear-gradient(180deg, var(--cy-surface) 0%, var(--cy-pane) 100%);
}

.cy-empty {
  display: grid;
  flex: 1;
  place-items: center;
  color: var(--cy-muted);
  font-size: 13px;
}

.cy-empty p {
  margin: 0;
}

.cy-streaming-placeholder {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 8px;
  padding: 9px 13px;
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 13px;
  font-size: 12px;
}

.cy-typing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cy-accent-strong);
  animation: cy-pulse 1s ease-in-out infinite;
}

@keyframes cy-pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}
</style>
