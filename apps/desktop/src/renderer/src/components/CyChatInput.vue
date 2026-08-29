<script setup lang="ts">
// CyChatInput:输入区。回车发送/Shift+Enter 换行;发送按钮;sending 期间禁用(F3,Task 4 review);
// 停止按钮(activeGenerationId 存在时);断线横幅(connectionStore.state.status 为 reconnecting/error)。
// G2(§4.4.1):草稿源改 draftStore(内存态 + 防抖持久化归 Main);发送成功清草稿、失败保留;超限/淘汰横幅。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { isCompositionEnter } from '@shared/domain'
import type { PendingSticker } from '@shared/contracts/attachments'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useMessageStore } from '../stores/message.store'
import { useDraftStore } from '../stores/draft.store'
import { useAttachmentStore } from '../stores/attachment.store'
import { useVoiceStore } from '../stores/voice.store'
import { useSettingsStore } from '../stores/settings.store'
import CyAttachmentQueue from './CyAttachmentQueue.vue'
import CyDropOverlay from './CyDropOverlay.vue'
import CyEmojiPicker from './CyEmojiPicker.vue'
import CyVoicePending from './CyVoicePending.vue'
import CyRealtimeBar from './CyRealtimeBar.vue'
import CyDictationHint from './CyDictationHint.vue'
import CyVoiceConsentDialog from './CyVoiceConsentDialog.vue'

const messageStore = useMessageStore()
const conversationStore = useConversationStore()
const connectionStore = useConnectionStore()
const draftStore = useDraftStore()
const attachmentStore = useAttachmentStore()
const voiceStore = useVoiceStore()
const settingsStore = useSettingsStore()
const fileInput = ref<HTMLInputElement>()
const dragActive = ref(false)
let dragDepth = 0

// —— P4-B 语音三入口（spec §5.12）：语音活跃（mode!=='idle'）→ 文本发送/附件禁用 ——
const voiceActive = computed(() => voiceStore.mode !== 'idle')
/** 🎤 录音：语音关闭禁用；其它语音模式进行中禁用（录音中保留可点 = 停止） */
const recordDisabled = computed(() => !settingsStore.voice.enabled || (voiceStore.mode !== 'idle' && voiceStore.mode !== 'recording'))
/** 🔊 实时会话：语音关闭或实时子开关关闭禁用；其它语音模式进行中禁用 */
const realtimeDisabled = computed(() => !settingsStore.voice.enabled || !settingsStore.voice.realtimeEnabled || voiceStore.mode !== 'idle')
/** ⌨️ 转写：语音关闭禁用；其它语音模式进行中禁用（转写中保留可松手 = stop/cancel） */
const dictationDisabled = computed(() => !settingsStore.voice.enabled || (voiceStore.mode !== 'idle' && voiceStore.mode !== 'dictating'))

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function onToggleRecord(): void {
  if (voiceStore.mode === 'recording') void voiceStore.stopRecord()
  else void voiceStore.startRecord()
}

const isRealtime = computed(() => voiceStore.mode === 'realtime')

function onToggleRealtime(): void {
  if (voiceStore.mode === 'realtime') void voiceStore.stopRealtime()
  else void voiceStore.startRealtime()
}

// —— ⌨️ 转写：按住 pointerdown 开始 / pointerup 提交 / pointercancel 取消；上滑 60px 置 cancel 标记 → pointerup 走 cancel ——
const dictationHold = ref<{ startY: number; cancel: boolean } | null>(null)
function onDictationPointerDown(e: PointerEvent): void {
  if (voiceActive.value && voiceStore.mode !== 'dictating') return
  dictationHold.value = { startY: e.clientY, cancel: false }
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  void voiceStore.startDictation()
}
function onDictationPointerMove(e: PointerEvent): void {
  if (!dictationHold.value) return
  if (e.clientY < dictationHold.value.startY - 60) dictationHold.value.cancel = true
}
function onDictationPointerUp(): void {
  const hold = dictationHold.value
  dictationHold.value = null
  if (!hold) return
  if (hold.cancel) void voiceStore.cancelDictation()
  else void voiceStore.stopDictation()
}
function onDictationPointerCancel(): void {
  dictationHold.value = null
  void voiceStore.cancelDictation()
}

// —— 转写 final 插入（D-P4）：finalText 置位 → 组件读 textarea 选区 → applyDictationInsert → clearDictationFinal ——
watch(
  () => voiceStore.dictation.finalText,
  (t) => {
    if (t === undefined) return
    const ta = textareaRef.value
    const sel = ta && ta.selectionStart !== undefined
      ? { start: ta.selectionStart, end: ta.selectionEnd }
      : undefined
    settingsStore.applyDictationInsert(t, sel)
    voiceStore.clearDictationFinal()
  }
)

// —— voiceStore.notice 瞬时提示（录音 300s/600s、D-P20 转写回退）——同 layout.notice 机制，3s 自动清除 ——
let voiceNoticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => voiceStore.notice, (n) => {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer)
  if (n) voiceNoticeTimer = setTimeout(() => voiceStore.clearNotice(), 3000)
})
onBeforeUnmount(() => {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer)
})
// —— G4 Emoji/表情接线（D7/D8）：面板弹出 + 待发送贴图队列 ——
const showPicker = ref(false)
const pendingStickers = ref<PendingSticker[]>([])
const textareaRef = ref<HTMLTextAreaElement>()

const currentId = computed(() => conversationStore.currentId)
const draft = computed({
  get: () => (currentId.value ? draftStore.drafts[currentId.value] ?? '' : ''),
  set: (v: string) => { if (currentId.value) draftStore.saveDraft(currentId.value, v) }
})
const overLimit = computed(() => (currentId.value ? !!draftStore.overLimit[currentId.value] : false))

const hasActiveGeneration = computed(() => !!messageStore.activeGenerationId)

/** 发送条件:非空/有附件/有待发送贴图 + 未在发送 + 无阻断(附件 failed/validating/uploading) + 有激活会话 + 已连接且会话就绪
 *  P1-5：canSend 计入 pendingStickers 非空——纯贴图也能点发送按钮；附件阻断只挡附件/文本路径（贴图不经附件编排，不受影响），保证按钮/Enter 一致
 *  P4-B：语音会话活跃（mode!=='idle'）→ 文本发送禁用（spec §5.12） */
const canSend = computed(() =>
  voiceStore.mode === 'idle' &&
  (draft.value.trim().length > 0 || attachmentStore.hasReady || pendingStickers.value.length > 0) &&
  !messageStore.sending && (pendingStickers.value.length > 0 || !attachmentStore.canSend.blockReason) &&
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

/** D14 硬化①:守卫通过后才 preventDefault + send（模板不再 .prevent，IME 组词确认 Enter 由守卫拦截） */
function onEnter(e: KeyboardEvent): void {
  if (isCompositionEnter(e)) return
  e.preventDefault()
  void send()
}

async function send(): Promise<void> {
  if (!canSend.value && pendingStickers.value.length === 0) return
  let ok = false
  const text = draft.value.trim()
  // P1-5：纯贴图发送——空草稿 + 仅待发送贴图时不发空文本消息（attachmentStore.send('') 会经 messageStore.send('') 发一条空消息）；
  // 仅当有文本或就绪附件时走附件编排路径
  if (text.length > 0 || attachmentStore.hasReady) {
    // G3：附件存在时 attachmentStore 编排上传→发送；保留 messageStore.send 的失败保留草稿语义（G2）。
    // P2-3：wrapper 返回 messageStore.send 布尔——attachmentStore 据此决定清队列（成功）还是回 ready 保留（失败）
    await attachmentStore.send(text, { send: async (t, o) => { ok = await messageStore.send(t, o); return ok } })
  }
  // G4：待发送贴图逐条发送（sticker 非附件，不经上传编排；wire stickerId，D8）
  for (const s of pendingStickers.value) {
    const stickerOk = await messageStore.send('', s.stickerId)
    if (stickerOk) ok = true
  }
  pendingStickers.value = []
  if (ok && currentId.value) draftStore.clear(currentId.value) // 失败保留草稿（spec §4.4.1）
}

/** Emoji 光标插入:读取 selectionStart/End,draft 拼接,光标移到插入后;不自动发送(D7) */
function insertEmoji(emoji: string): void {
  const ta = textareaRef.value
  const start = ta?.selectionStart ?? draft.value.length
  const end = ta?.selectionEnd ?? draft.value.length
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end)
  void nextTick(() => {
    if (ta) { const pos = start + emoji.length; ta.setSelectionRange(pos, pos) }
  })
  showPicker.value = false
  ta?.focus()
}

function onSelectSticker(s: PendingSticker): void {
  pendingStickers.value = [...pendingStickers.value, s]
  showPicker.value = false
  textareaRef.value?.focus()
}

function removeSticker(id: string): void {
  pendingStickers.value = pendingStickers.value.filter((s) => s.stickerId !== id)
}

function onPickerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { showPicker.value = false; textareaRef.value?.focus() }
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

    <!-- D-P5 会话切换守卫提示：语音会话活跃时切换/新建被拒（Task 13 conversationStore.blockReason） -->
    <div v-if="conversationStore.blockReason" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>{{ conversationStore.blockReason }}</span>
    </div>

    <!-- final-review round2：麦克风拒绝 composer banner（spec §5.12 line 323）——store 各 start* 在 capture 失败
         同一同步块置 micError + mode='idle'（待发送条恰好卸载，micError 仅设置页可达）→ 聊天区麦克风拒绝原为静默失败；
         此处 mode==='idle' 且 micError 有值时展示（下次 start* 开头清陈旧错误，banner 随之消失，无需定时器） -->
    <div v-if="voiceStore.micError && voiceStore.mode === 'idle'" class="cy-banner cy-mic-error-banner" role="alert">
      <span class="cy-banner-dot" />
      <span>{{ voiceStore.micError.message }}</span>
    </div>

    <!-- voiceStore 瞬时提示（录音 300s/600s 上限、D-P20 转写回退全局 STT） -->
    <div v-if="voiceStore.notice" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>{{ voiceStore.notice }}</span>
    </div>

    <!-- P4-B 待发送语音条：录音停止后显示（转写字幕 + 试听/重录/删除/确认发送） -->
    <CyVoicePending v-if="voiceStore.mode === 'record_pending'" />
    <!-- G3 附件发送阻断提示（failed/validating/uploading 时展示原因） -->
    <div v-if="attachmentStore.canSend.blockReason" class="cy-banner" role="status">
      <span class="cy-banner-dot" />
      <span>{{ attachmentStore.canSend.blockReason }}</span>
    </div>

    <!-- G3 待发送附件队列 + 拖拽覆盖层 -->
    <template v-if="!isRealtime">
      <CyAttachmentQueue />
      <CyDropOverlay :active="dragActive" :count="attachmentStore.order.length" @leave="dragActive = false" />

      <div class="cy-composer-box">
        <button class="cy-attach-btn" title="添加文件" aria-label="添加文件" :disabled="voiceActive" @click="fileInput?.click()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <input ref="fileInput" type="file" multiple class="cy-hidden-input" @change="onFilePick" />
        <!-- P4-B 语音三入口（spec §5.12）：🎤 普通录音 / 🔊 实时会话 / ⌨️ 转写（按住说话） -->
        <button
          class="cy-voice-btn"
          :class="{ active: voiceStore.mode === 'recording' }"
          :disabled="recordDisabled"
          :aria-pressed="voiceStore.mode === 'recording'"
          :title="voiceStore.mode === 'recording' ? '停止录音' : '普通录音'"
          :aria-label="voiceStore.mode === 'recording' ? '停止录音' : '普通录音'"
          @click="onToggleRecord"
        >
          <template v-if="voiceStore.mode === 'recording'">
            <i class="cy-rec-dot" aria-hidden="true" />
            <span class="cy-rec-timer">{{ formatElapsed(voiceStore.record.elapsedMs) }}</span>
          </template>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><path d="M12 19v3" /></svg>
        </button>
        <!-- UI精修 01：分组分隔线——组1(附件/录音) vs 组2(表情/实时/转写)，细竖线 span 界定两组 -->
        <span class="cy-composer-divider" aria-hidden="true" />
        <!-- G4 Emoji/表情包：面板弹出（Esc 关闭回焦点）+ 待发送贴图队列；UII01 移入 composer-box 组2（表情→实时→转写） -->
        <button class="cy-emoji-btn" :aria-expanded="showPicker" aria-label="Emoji 与表情包" @click="showPicker = !showPicker">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm3.5 7.5a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM8.5 9.5a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM12 17c-2.5 0-4.5-1.5-5-3.5h10c-.5 2-2.5 3.5-5 3.5z"/></svg>
        </button>
        <!-- UI精修 01：picker-wrap 在 flex 行内恒为空会插入左右两个 phantom gap，改为仅弹层打开时挂载 -->
        <div v-if="showPicker" class="cy-picker-wrap" @keydown="onPickerKeydown">
          <CyEmojiPicker class="cy-emoji-pop" @select-emoji="insertEmoji" @select-sticker="onSelectSticker" @close="showPicker = false" />
        </div>
        <button
          class="cy-voice-btn"
          :class="{ active: voiceStore.mode === 'realtime' }"
          :disabled="realtimeDisabled"
          :aria-pressed="voiceStore.mode === 'realtime'"
          title="实时会话"
          aria-label="实时会话"
          @click="onToggleRealtime"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 010 7" /><path d="M18.5 5.5a9 9 0 010 13" /></svg>
        </button>
        <button
          class="cy-voice-btn"
          :class="{ active: voiceStore.mode === 'dictating', cancel: dictationHold?.cancel }"
          :disabled="dictationDisabled"
          title="转写（按住说话）"
          aria-label="输入法转写（按住说话）"
          @pointerdown="onDictationPointerDown"
          @pointermove="onDictationPointerMove"
          @pointerup="onDictationPointerUp"
          @pointercancel="onDictationPointerCancel"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20h4M12 20h6" /><path d="M8 4h8a2 2 0 012 2v5a2 2 0 01-2 2H8a2 2 0 01-2-2V6a2 2 0 012-2z" /></svg>
        </button>
        <textarea
          ref="textareaRef"
          v-model="draft"
          :disabled="messageStore.sending || voiceActive"
          placeholder="输入消息，Enter 发送"
          rows="1"
          aria-label="消息输入框"
          @keydown.enter.exact="onEnter"
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
    </template>
    <!-- P4-B 实时会话：输入区替换为实时状态条（聆听 + 字幕 + 轮次 + 停止） -->
    <CyRealtimeBar v-else />
    <!-- P4-B 转写浮层：按住说话期间显示字幕 + 「松开提交 · 上滑取消」 -->
    <CyDictationHint v-if="voiceStore.mode === 'dictating'" />
    <div v-if="pendingStickers.length" class="cy-sticker-queue" role="list" aria-label="待发送表情">
      <span v-for="s in pendingStickers" :key="s.stickerId" class="cy-sticker-chip" role="listitem">
        {{ s.stickerId }}                    <!-- P0-2：契约 StickerEntry 无 name，chip 显示 stickerId -->
        <button :aria-label="`移除 ${s.stickerId}`" @click="removeSticker(s.stickerId)">✕</button>
      </span>
    </div>
    <div class="cy-composer-status">
      <span class="cy-muted">Enter 发送 · Shift+Enter 换行</span>
    </div>

    <!-- P4-B consent（D-P16）：首个 backend-STT 语音操作前确认对话框 -->
    <CyVoiceConsentDialog />
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
  /* UI精修 01：grid 列数改为 flex——组内含分隔线 span，硬编码列数会因元素增删而脆 */
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-composer textarea {
  flex: 1;
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
.cy-send-btn,
.cy-voice-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
}

/* P4-B 语音三入口：与 attach 同尺寸；录音中红点 + 计时高亮；转写按住高亮/上滑取消变体 */
.cy-voice-btn {
  gap: 4px;
  color: var(--cy-muted);
  background: transparent;
  border: 1px solid var(--cy-border);
}

.cy-voice-btn:hover:not(:disabled) {
  color: var(--cy-accent);
  background: var(--cy-surface-hover);
}

.cy-voice-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cy-voice-btn.active {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border-color: var(--cy-accent);
}

.cy-voice-btn.active.cancel {
  color: var(--cy-danger);
  background: var(--cy-surface-soft);
  border-color: var(--cy-danger);
}

.cy-voice-btn.active {
  width: auto;
  min-width: 32px;
  padding: 0 9px;
}

.cy-rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cy-danger);
  animation: cy-rec-blink 1.1s ease-in-out infinite;
}

.cy-rec-timer {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@keyframes cy-rec-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
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

/* G4 Emoji/表情包：弹出面板锚点 + 待发送贴图队列（UI精修 01：按钮移入 composer-box 组2，不再独立一行） */
.cy-composer-divider {
  flex-shrink: 0;
  width: 1px;
  height: 24px;
  background: var(--cy-border);
  align-self: center;
}

.cy-emoji-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
}

.cy-emoji-btn:hover {
  color: var(--cy-accent);
  background: var(--cy-surface-hover);
}

.cy-picker-wrap {
  position: relative;
}

.cy-emoji-pop {
  position: absolute;
  bottom: 100%;
  right: 0;
  z-index: 30;
  margin-bottom: 6px;
}

.cy-sticker-queue {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}

.cy-sticker-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-sticker-chip button {
  border: 0;
  background: transparent;
  color: var(--cy-muted);
  font-size: 11px;
  cursor: pointer;
}
</style>
