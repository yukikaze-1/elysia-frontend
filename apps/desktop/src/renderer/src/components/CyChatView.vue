<script setup lang="ts">
import { ref } from 'vue'

// Phase 0 静态演示:UI 壳与双通道消息示意。数据来自原型与 Mock 夹具;
// 真实流式驱动由 messageStore + BackendAdapter(阶段 2)提供。
const innerVoiceOpen = ref(true)
const draft = ref('')

const replyMeta = {
  model: 'cyrene-llm-v1',
  tokens: '208 / 会话 2100',
  emotion: 'thinking'
}

const publicSegments = [
  '好的，我来回答你关于**流式回复**的问题。',
  '一次 AI 回复只建立一个父消息。',
  '第一，`deltaSequence` 只在分段内累计；第二，`segmentIndex` 决定全局展示顺序。'
]

const toolCall = {
  name: 'desktop.file.read',
  summary: '读取 ~/notes/example.txt',
  status: '已完成'
}
</script>

<template>
  <section class="cy-chat">
    <!-- 聊天头部 -->
    <header class="cy-chat-header">
      <div class="cy-chat-heading">
        <div class="cy-chat-title-line">
          <span class="cy-online-dot" />
          <h2>流式回复演示</h2>
        </div>
        <div class="cy-chat-meta">
          <span class="cy-meta-chip">{{ replyMeta.model }}</span>
          <span class="cy-meta-chip">{{ replyMeta.tokens }}</span>
          <span class="cy-meta-chip">{{ replyMeta.emotion }}</span>
        </div>
      </div>
      <div class="cy-header-actions">
        <button class="cy-action-button">历史查看</button>
        <button class="cy-action-button">清空</button>
      </div>
    </header>

    <!-- 消息区 -->
    <div class="cy-messages">
      <!-- 用户消息 -->
      <div class="cy-message-row cy-user-row">
        <div class="cy-message cy-user-message">
          <p>能讲讲流式回复的分段与归组规则吗？</p>
        </div>
      </div>

      <!-- 工具卡片 -->
      <div class="cy-tool">
        <div class="cy-tool-head">
          <span class="cy-tool-title">
            <span class="cy-tool-status is-complete">{{ toolCall.status }}</span>
            <strong>{{ toolCall.name }}</strong>
          </span>
        </div>
        <div class="cy-tool-details">{{ toolCall.summary }}</div>
      </div>

      <!-- Assistant 双通道消息:Inner Voice + Public Reply 同属一条消息 -->
      <div class="cy-message-row">
        <span class="cy-message-avatar">Cy</span>
        <div class="cy-dual-message">
          <details class="cy-inner-voice" :open="innerVoiceOpen" @toggle="innerVoiceOpen = ($event.target as HTMLDetailsElement).open">
            <summary>
              内心独白
              <span class="cy-muted">inner_voice</span>
            </summary>
            <p>让我先整理一下回答思路。（要点：按 responseId 归组、segmentIndex 排序）</p>
          </details>

          <div class="cy-public-reply">
            <div class="cy-response-cluster">
              <div class="cy-response-head">
                <strong>Cyrene</strong>
                <span class="cy-muted">· 刚刚 · cyrene-llm-v1</span>
              </div>
              <div class="cy-response-segments">
                <p
                  v-for="(seg, i) in publicSegments"
                  :key="i"
                  class="cy-segment cy-segment-public"
                  v-html="seg"
                />
              </div>
              <div class="cy-response-footer">
                <span>in 208 tokens</span>
                <span>emotion: thinking</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <footer class="cy-composer">
      <div class="cy-composer-box">
        <button class="cy-composer-btn" title="表情" aria-label="表情">🙂</button>
        <button class="cy-composer-btn" title="表情包" aria-label="表情包">🖼️</button>
        <button class="cy-composer-btn" title="附件" aria-label="附件">📎</button>
        <button class="cy-composer-btn" title="按住说话转文字" aria-label="按住说话转文字">🎤</button>
        <textarea
          v-model="draft"
          placeholder="输入消息，Enter 发送"
          rows="1"
          aria-label="消息输入框"
        />
        <button class="cy-send-btn" title="发送" aria-label="发送">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </div>
      <div class="cy-composer-status">
        <span class="cy-muted">Phase 0 静态示意 · 无交互逻辑</span>
      </div>
    </footer>
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
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cy-success);
}

.cy-chat-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 5px;
}

.cy-meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  color: var(--cy-muted);
  font-size: 11px;
  white-space: nowrap;
}

.cy-header-actions {
  display: flex;
  gap: 7px;
}

.cy-action-button {
  padding: 7px 11px;
  border: 1px solid var(--cy-border);
  border-radius: 10px;
  background: var(--cy-surface);
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-action-button:hover {
  background: var(--cy-surface-hover);
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

.cy-message-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.cy-user-row {
  justify-content: flex-end;
}

.cy-message-avatar {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  font-size: 13px;
}

.cy-message {
  max-width: 86%;
  padding: 10px 12px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-message p {
  margin: 0;
}

.cy-user-message {
  background: var(--cy-user);
}

.cy-dual-message {
  display: grid;
  gap: 9px;
  max-width: 90%;
  padding: 0;
  overflow: hidden;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-inner-voice {
  padding: 10px 12px;
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border-bottom: 1px solid var(--cy-border);
}

.cy-inner-voice summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  color: var(--cy-text);
  font-weight: 500;
}

.cy-inner-voice p {
  margin: 8px 0 0;
  font-size: 13px;
}

.cy-public-reply {
  padding: 0 12px 12px;
}

.cy-response-cluster {
  display: grid;
  gap: 7px;
}

.cy-response-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-response-segments {
  display: grid;
  gap: 6px;
}

.cy-segment {
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 8px 11px;
  border-radius: 5px 13px 13px 13px;
}

.cy-segment-public {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border-left: 2px solid var(--cy-accent-strong);
}

.cy-response-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-tool {
  width: min(100%, 380px);
  margin-left: 39px;
  padding: 11px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.cy-tool-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cy-tool-status {
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--cy-success);
  background: var(--cy-surface-soft);
  font-size: 11px;
  white-space: nowrap;
}

.cy-tool-details {
  color: var(--cy-muted);
  font-size: 12px;
}

.cy-composer {
  padding: 10px 14px 14px;
  background: var(--cy-pane);
  border-top: 1px solid var(--cy-border);
}

.cy-composer-box {
  display: grid;
  grid-template-columns: auto auto auto auto 1fr auto;
  align-items: end;
  gap: 8px;
  padding: 8px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 14px;
}

.cy-composer-btn {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--cy-muted);
  font-size: 15px;
}

.cy-composer-btn:hover {
  background: var(--cy-surface-hover);
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

.cy-send-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
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
