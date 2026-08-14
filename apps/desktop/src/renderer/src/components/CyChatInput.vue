<script setup lang="ts">
// CyChatInput:输入区。回车发送/Shift+Enter 换行;发送按钮;sending 期间禁用(F3,Task 4 review);
// 停止按钮(activeGenerationId 存在时);断线横幅(connectionStore.state.status 为 reconnecting/error)。
// G2(§4.4.1):草稿源改 draftStore(内存态 + 防抖持久化归 Main);发送成功清草稿、失败保留;超限/淘汰横幅。
import { computed, ref } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useDraftStore } from '../stores/draft.store'
import { useAttachmentStore } from '../stores/attachment.store'
import CyAttachmentQueue from './CyAttachmentQueue.vue'
import CyDropOverlay from './CyDropOverlay.vue'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()
const draftStore = useDraftStore()
const attachmentStore = useAttachmentStore()
const fileInput = ref<HTMLInputElement>()
const dragActive = ref(false)
let dragDepth = 0

const currentId = computed(() => conversationStore.currentId)
const draft = computed({
  get: () => (currentId.value ? draftStore.drafts[currentId.value] ?? '' : ''),
  set: (v: string) => { if (currentId.value) draftStore.saveDraft(currentId.value, v) }
})
const overLimit = computed(() => (currentId.value ? !!draftStore.overLimit[currentId.value] : false))

const hasActiveGeneration = computed(() => !!messageStore.activeGenerationId)

/** 发送条件:非空/有附件 + 未在发送 + 无阻断(附件 failed/validating/uploading) + 有激活会话 + 已连接且会话就绪 */
const canSend = computed(() =>
  (draft.value.trim().length > 0 || attachmentStore.hasReady) &&
  !messageStore.sending && !attachmentStore.canSend.blockReason &&
  !!conversationStore.currentId && connectionStore.state.status === 'connected' && conversationStore.ready
)

/** 断线横幅:reconnecting/error(流式不可继续,提示用户) */
const showBanner = computed(() => {
  const s = connectionStore.state.status
  return s === 'reconnecting' || s === 'error'
})
const bannerText = computed(() => {
  const s = connectionStore.state.status
  if (s === 'reconnecting') return '连接已断开,正在重连…'
  if (s === 'error') return `连接出错${connectionStore.error?.message ? `: ${connectionStore.error.message}` : ''}`
  return ''
})

async function send(): Promise<void> {
  if (!canSend.value) return
  // G3：附件存在时 attachmentStore 编排上传→发送；保留 messageStore.send 的失败保留草稿语义（G2）
  let ok = false
  await attachmentStore.send(draft.value.trim(), { send: async (t, o) => { ok = await messageStore.send(t, o) } })
  if (ok && currentId.value) draftStore.clear(currentId.value) // 失败保留草稿（spec §4.4.1）
}

/** 回车发送守卫:IME 组词确认期间(中文/日文输入法)Enter 是候选确认,不发送 */
function onEnter(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  void send()
}

function stop(): void {
  messageStore.cancel()
}

// —— G3 附件收集（点击/拖拽/粘贴仅 source 不同；拖拽/粘贴只建条目，不自动上传/发送，spec §4.3）——
function onFilePick(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files) attachmentStore.addFiles(Array.from(input.files).map((f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'picker', file: f })))
  input.value = ''
}
function onDrop(e: DragEvent): void {
  dragActive.value = false
  dragDepth = 0
  if (e.dataTransfer?.files?.length) {
    attachmentStore.addFiles(Array.from(e.dataTransfer.files).map((f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'drag_drop', file: f })))
  }
}
function onDragEnter(e: DragEvent): void {
  if (e.dataTransfer?.types?.includes('Files')) { dragDepth += 1; dragActive.value = true }
}
function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}
async function onPaste(e: ClipboardEvent): Promise<void> {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length) {
    // 粘贴文件 pathless（webUtils.getPathForFile 返回空串）→ 预读 bytes 一并交 store（D5 粘贴 bytes 型）
    const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, mediaType: f.type || 'application/octet-stream', source: 'paste' as const, file: f, bytes: await f.arrayBuffer() })))
    attachmentStore.addFiles(inputs)
    e.preventDefault()   // 有粘贴附件时不进文本草稿
  }
}
</script>

<template>
  <footer
    class="cy-composer"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover.prevent
    @drop.prevent="onDrop"
    @paste="onPaste"
  >
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

    <!-- 草稿超限横幅(G2 §4.4.1 D4):100KB 字节上限,超出部分拒绝写入;提供清空按钮 -->
    <div v-if="overLimit" class="cy-banner cy-error-banner" role="alert">
      <span class="cy-banner-dot" />
      <span>草稿已满（100KB 上限），超出部分未保存</span>
      <button class="cy-clear-draft" @click="currentId && draftStore.clear(currentId)">清空草稿</button>
    </div>
    <!-- 草稿淘汰一次性通知(G2 P2-1):Main 50 会话上限淘汰不静默 -->
    <div v-if="draftStore.evictionNotice.length" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>草稿已满：最早的非激活会话草稿已按策略清理（{{ draftStore.evictionNotice.length }} 个）</span>
      <button class="cy-clear-draft" @click="draftStore.dismissEviction()">知道了</button>
    </div>

    <!-- G3 附件发送阻断提示（failed/validating/uploading 时展示原因） -->
    <div v-if="attachmentStore.canSend.blockReason" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>{{ attachmentStore.canSend.blockReason }}</span>
    </div>

    <!-- G3 待发送附件队列 + 拖拽覆盖层 -->
    <CyAttachmentQueue />
    <CyDropOverlay :active="dragActive" :count="attachmentStore.order.length" @leave="dragActive = false" />

    <div class="cy-composer-box">
      <button class="cy-attach-btn" title="添加文件" aria-label="添加文件" @click="fileInput?.click()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <input ref="fileInput" type="file" multiple class="cy-hidden-input" @change="onFilePick" />
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
  position: relative;   /* G3 CyDropOverlay absolute 定位锚点 */
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

.cy-clear-draft {
  border: 0;
  background: transparent;
  color: var(--cy-accent-strong);
  font-size: 12px;
  cursor: pointer;
  margin-left: auto;
}

.cy-composer-box {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
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

.cy-hidden-input {
  display: none;
}

.cy-attach-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--cy-muted);
  background: transparent;
  border: 1px solid var(--cy-border);
}

.cy-attach-btn:hover {
  color: var(--cy-accent);
  background: var(--cy-surface-hover);
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
