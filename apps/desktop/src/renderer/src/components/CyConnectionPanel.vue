<script setup lang="ts">
// CyConnectionPanel:连接装配面板(真实模式联调 FE-P1-01/FE-P0-01)。
// - 装配模式(MOCK/REAL)来自 chat:get-runtime-info;Mock 模式隐藏 Endpoint/Token 输入;
// - Endpoint 经 setEndpoint 规范化(origin 变化自动清 token 绑定);Token 密码框提交后立即清空明文(spec 3.2.2);
// - connect 无参:endpoint/token 由 Main 侧 connection-config 持有。
// UII-QQ 设置页批次：浮层重设计为「状态摘要 + 展开的连接设置」两级结构——
// 摘要态：状态点/状态文字、Endpoint 安全摘要（仅 host）、后端与协议版本、「连接设置」入口、已连接时的次要「断开」；
// 编辑态：Endpoint / Token（密码型 + 显示切换；已配置显示「已配置」不回填原值）/ 主按钮「保存并连接」/
// 次要危险「断开」/ 表单内错误与可执行提示。自动重连、Token 保存/清除与连接状态逻辑不变；
// `.cy-status-text` 为集成测试轮询锚点，Esc/点外部关闭。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import type { CredentialStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'
import { parsePublicError } from '../utils/public-error'
import { errorMessage } from '../utils/error-message'

/** 多套 UI 基础：跨 IPC 错误一律经映射器（不再直接取公开原文），使本地/后端错误同一条文案链 */
function toErrorText(e: unknown, fallback: string): string {
  return e instanceof Error ? errorMessage(parsePublicError(e.message), fallback) : String(e)
}

const connection = useConnectionStore()
const mode = ref<'real' | 'mock'>('real')
const endpointInput = ref('')
const tokenInput = ref('')
const tokenStatus = ref<CredentialStatus>('empty')
const endpointErr = ref<string>()
const tokenErr = ref<string>()
const connectErr = ref<string>()
const busy = ref(false)
const tokenVisible = ref(false)
const editing = ref(false)
const serverVersion = computed(() => connection.state.serverVersion)
const protocolVersion = computed(() => connection.state.protocolVersion)
const connected = computed(() => connection.state.status === 'connected')
const tokenLabel = computed(() => ({ available: '已配置', empty: '未配置', unavailable: '凭据存储不可用', locked: '凭据已锁定' }[tokenStatus.value] ?? ''))

const modeLabel = computed(() => (mode.value === 'mock' ? 'MOCK' : 'REAL'))
const statusLabel = computed(() => {
  switch (connection.state.status) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '重连中…'
    case 'error':
      return '连接失败'
    default:
      return '未连接'
  }
})
const statusTone = computed(() => {
  switch (connection.state.status) {
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

/** Endpoint 安全摘要：仅展示 host（不含协议路径参数）；未配置显示占位说明 */
const endpointSummary = computed(() => {
  const raw = endpointInput.value.trim()
  if (!raw) return '未配置（开发模式默认 http://127.0.0.1:8765）'
  try { return new URL(raw).host } catch { return raw }
})

// —— popover 开合（Esc / 点击外部关闭；从按钮右侧向上展开，z-index 高于聊天内容、低于设置 overlay） ——
const open = ref(false)
const rootRef = ref<HTMLElement>()
function onDocPointerDown(e: PointerEvent): void {
  if (!open.value) return
  if (rootRef.value?.contains(e.target as Node)) return
  open.value = false
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
watch(open, (o) => {
  if (o) {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    window.addEventListener('keydown', onKeydown, true)
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    window.removeEventListener('keydown', onKeydown, true)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
})

onMounted(async () => {
  const r = await api.getRuntimeInfo()
  mode.value = r.mode
  const e = await api.getEndpoint()
  if (e.endpoint) endpointInput.value = e.endpoint
  tokenStatus.value = await api.getCredentialStatus()
})

async function applyEndpoint(): Promise<void> {
  endpointErr.value = undefined
  try {
    const r = await api.setEndpoint(endpointInput.value.trim())
    endpointInput.value = r.endpoint
    // origin 变化 → Main 已自动清 token+binding,状态同步刷新(最终 review 修复)
    tokenStatus.value = await api.getCredentialStatus()
    return
  } catch (e: unknown) {
    endpointErr.value = toErrorText(e, '保存后端地址失败，请检查地址格式。')
  }
}

async function applyToken(): Promise<void> {
  tokenErr.value = undefined
  const t = tokenInput.value.trim()
  if (!t) return
  try {
    tokenStatus.value = await api.setBackendToken(t)
  } catch (e: unknown) {
    tokenErr.value = toErrorText(e, '保存 Token 失败，请重试。')
  } finally {
    tokenInput.value = ''   // 提交后立即清空明文(spec 3.2.2)
  }
}

async function clearToken(): Promise<void> {
  tokenStatus.value = await api.clearBackendToken()
}

async function toggleConnect(): Promise<void> {
  busy.value = true
  connectErr.value = undefined
  try {
    if (connected.value) await connection.disconnect()
    else await connection.connect()
  } catch (e: unknown) {
    connectErr.value = toErrorText(e, '连接失败，请检查地址与 Token。')
  } finally {
    busy.value = false
  }
}

/** 编辑态主按钮「保存并连接」：先落 Endpoint/Token（有输入才提交），再发起连接；错误落表单内。
 *  修复：同 origin 只换 Token 时 setEndpoint 不触发 D14 断开——凡有保存动作，已连接即先断开再连接，
 *  新 Token 立即生效；连接失败经 connection.store 归档到 connection.error（store 不 rethrow），编辑态与
 *  摘要态均直接展示 connection.error。 */
async function saveAndConnect(): Promise<void> {
  connectErr.value = undefined
  const wantsEndpoint = !!endpointInput.value.trim()
  const wantsToken = !!tokenInput.value.trim()
  if (!wantsEndpoint && !wantsToken) {
    endpointErr.value = '请先填写后端地址'
    return
  }
  busy.value = true
  try {
    if (wantsEndpoint) {
      await applyEndpoint()
      if (endpointErr.value) return   // endpoint 失败即停（token 绑定 origin，先修地址）
    }
    if (wantsToken) {
      await applyToken()
      if (tokenErr.value) return
    }
    if (connected.value) await connection.disconnect()
    await connection.connect()
  } finally {
    busy.value = false
  }
}

/** 编辑态错误：本地校验错误优先，其次 store 归档的连接错误（connect 失败不 rethrow） */
const editError = computed(() => connectErr.value ?? (connection.error ? errorMessage(connection.error, '连接失败，请重试。') : null))
</script>

<template>
  <div ref="rootRef" class="cy-connection-panel">
    <!-- NavRail 全局连接钮：插头图标 + 右下角状态点（绿/黄/红/灰）。
         可达名 = sr-only 文本（含 REAL/MOCK 与状态，/REAL|MOCK/ 测试契约保持），hover tooltip = 完整状态 -->
    <button
      class="cy-conn-badge"
      :aria-expanded="open"
      :title="`${modeLabel} · ${statusLabel}`"
      @click="open = !open"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v3a6 6 0 0 1-12 0V8z" /></svg>
      <span class="cy-conn-dot" :class="statusTone" aria-hidden="true" />
      <span class="cy-status-text cy-sr-only">{{ modeLabel }} · {{ statusLabel }}</span>
    </button>

    <!-- 连接浮层：状态摘要 + 展开的连接设置（从按钮右侧向上展开，NavRail 内不裁切） -->
    <div v-if="open" class="cy-conn-pop" role="dialog" aria-label="后端连接">
      <!-- 摘要态 -->
      <div v-if="!editing" class="cy-conn-summary">
        <div class="cy-conn-status-row">
          <span class="cy-conn-dot" :class="statusTone" aria-hidden="true" />
          <span class="cy-status-text">{{ statusLabel }}</span>
        </div>
        <dl class="cy-conn-facts">
          <div class="cy-conn-fact">
            <dt>地址</dt>
            <dd>{{ endpointSummary }}</dd>
          </div>
          <div v-if="serverVersion || protocolVersion" class="cy-conn-fact">
            <dt>版本</dt>
            <dd>后端 {{ serverVersion || '—' }} · 协议 {{ protocolVersion || '—' }}</dd>
          </div>
        </dl>
        <div class="cy-conn-summary-actions">
          <button class="cy-btn cy-btn-secondary" @click="editing = true">连接设置</button>
          <button v-if="connected" class="cy-btn cy-btn-danger" :disabled="busy" @click="toggleConnect">断开</button>
          <button v-else class="cy-btn cy-btn-primary" :disabled="busy" @click="toggleConnect">连接</button>
        </div>
        <div v-if="connection.error" class="cy-conn-error">
          {{ errorMessage(connection.error, '连接失败，请重试。') }}
          <span class="cy-conn-error-hint">可展开「连接设置」检查地址与 Token。</span>
        </div>
      </div>

      <!-- 编辑态 -->
      <form v-else class="cy-conn-edit" @submit.prevent="saveAndConnect">
        <div class="cy-conn-edit-title">连接设置</div>

        <template v-if="mode !== 'mock'">
          <label class="cy-pop-field">
            <span class="cy-pop-label">后端地址（Endpoint）</span>
            <input v-model="endpointInput" class="cy-input" type="text" placeholder="https://… 或 http://127.0.0.1:8765" autocomplete="off" spellcheck="false" />
            <span v-if="endpointErr" class="cy-err">
              {{ endpointErr }}
              <span class="cy-conn-error-hint">http 仅允许回环地址（127.x / localhost / ::1）；https 可为任意主机。</span>
            </span>
          </label>

          <label class="cy-pop-field">
            <span class="cy-pop-label">
              Token
              <span class="cy-token-chip" :class="{ ok: tokenStatus === 'available' }">{{ tokenLabel }}</span>
            </span>
            <span class="cy-token-row">
              <input
                v-model="tokenInput"
                class="cy-input"
                :type="tokenVisible ? 'text' : 'password'"
                :placeholder="tokenStatus === 'available' ? '已配置——输入新值可更换' : '粘贴后端 Token'"
                autocomplete="new-password"
              />
              <button
                type="button"
                class="cy-token-eye"
                :aria-pressed="tokenVisible"
                :aria-label="tokenVisible ? '隐藏 Token' : '显示 Token'"
                :title="tokenVisible ? '隐藏 Token' : '显示 Token'"
                @click="tokenVisible = !tokenVisible"
              >
                <svg v-if="!tokenVisible" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><path d="m4 4 16 16" /></svg>
              </button>
            </span>
            <span v-if="tokenErr" class="cy-err">{{ tokenErr }}</span>
            <span v-if="tokenStatus === 'available'" class="cy-token-actions">
              <span class="cy-token-hint">已保存于系统凭据库（不回显原值）。</span>
              <button type="button" class="cy-token-clear" :disabled="busy" @click="clearToken">清除已存 Token</button>
            </span>
          </label>
        </template>
        <div v-else class="cy-server-info">MOCK 演示模式：无需后端地址与 Token。</div>

        <div class="cy-conn-edit-actions">
          <button type="submit" class="cy-btn cy-btn-primary" :disabled="busy">{{ connected ? '保存并重新连接' : '保存并连接' }}</button>
          <button v-if="connected" type="button" class="cy-btn cy-btn-danger" :disabled="busy" @click="toggleConnect">断开</button>
          <button type="button" class="cy-btn cy-btn-secondary" :disabled="busy" @click="editing = false">返回摘要</button>
        </div>
        <div v-if="editError" class="cy-conn-error">
          {{ editError }}
          <span class="cy-conn-error-hint">请确认后端已启动、地址与 Token 正确后重试。</span>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.cy-connection-panel {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
}

/* NavRail 全局连接钮：32+ 图标钮，右下角状态点 */
.cy-conn-badge {
  position: relative;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: var(--cy-radius-6);
  color: var(--cy-muted);
  background: transparent;
  border: 0;
}

.cy-conn-badge:hover {
  color: var(--cy-accent-text);
  background: var(--cy-surface-hover);
}

.cy-conn-badge[aria-expanded='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-conn-dot {
  position: absolute;
  right: 7px;
  bottom: 7px;
  width: 8px;
  height: 8px;
  border-radius: var(--cy-radius-circle);
  background: var(--cy-muted);
  box-shadow: 0 0 0 2px var(--cy-nav);
}

.cy-conn-dot.is-connected { background: var(--cy-success); }
.cy-conn-dot.is-connecting { background: var(--cy-warning); }
.cy-conn-dot.is-error { background: var(--cy-danger); }

/* 集成测试契约（.cy-status-text textContent 轮询）：sr-only 视觉隐藏但可访问 */
.cy-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* 连接浮层：从 NavRail 按钮右侧向上展开（bottom 对齐按钮底），不受 60px 栏宽裁切 */
.cy-conn-pop {
  position: absolute;
  left: calc(100% + 10px);
  bottom: 0;
  z-index: 45;
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-5);
  width: 320px;
  max-height: min(560px, calc(100dvh - 96px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--cy-space-6);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
  box-shadow: var(--cy-shadow);
  font-size: var(--cy-font-md);
}

/* —— 摘要态 —— */
.cy-conn-status-row {
  display: flex;
  align-items: center;
  gap: var(--cy-space-4);
}

.cy-conn-status-row .cy-conn-dot {
  position: static;
  box-shadow: none;
}

.cy-conn-status-row .cy-status-text {
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
  font-weight: 600;
}

.cy-conn-facts {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-2-5);
  margin: 0;
}

.cy-conn-fact {
  display: flex;
  gap: var(--cy-space-4);
  min-width: 0;
}

.cy-conn-fact dt {
  flex: 0 0 auto;
  color: var(--cy-muted);
}

.cy-conn-fact dd {
  margin: 0;
  color: var(--cy-text);
  overflow-wrap: anywhere;
}

.cy-conn-summary-actions,
.cy-conn-edit-actions {
  display: flex;
  gap: var(--cy-space-3-5);
}

.cy-conn-edit-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}

.cy-btn {
  flex: 1 1 auto;
  padding: var(--cy-space-3-5) var(--cy-space-5);
  border-radius: var(--cy-radius-4-5);
  font-size: var(--cy-font-md);
  white-space: nowrap;
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  border: 1px solid var(--cy-border);
}

.cy-btn:hover:not(:disabled) {
  background: var(--cy-surface-hover);
}

.cy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-btn-primary {
  color: var(--cy-accent-text);
  background: var(--cy-accent-strong);
  border-color: var(--cy-accent-strong);
  font-weight: 500;
}

.cy-btn-primary:hover:not(:disabled) {
  background: var(--cy-accent-strong);
  filter: brightness(1.06);
}

.cy-btn-danger {
  color: var(--cy-danger);
  border-color: var(--cy-danger);
  background: transparent;
}

.cy-btn-danger:hover:not(:disabled) {
  color: var(--cy-accent-text);
  background: var(--cy-danger);
}

.cy-btn-secondary {
  background: transparent;
  color: var(--cy-muted);
}

/* —— 编辑态 —— */
.cy-conn-edit {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-5);
}

.cy-conn-edit-title {
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
  font-weight: 600;
}

.cy-pop-field {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-2-5);
  min-width: 0;
}

.cy-pop-label {
  display: flex;
  align-items: center;
  gap: var(--cy-space-3);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-token-chip {
  padding: var(--cy-space-0-5) var(--cy-space-3-5);
  border-radius: var(--cy-radius-pill);
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  font-size: var(--cy-font-xs);
}

.cy-token-chip.ok {
  color: var(--cy-success);
  border-color: var(--cy-success);
}

.cy-token-row {
  display: flex;
  align-items: center;
  gap: var(--cy-space-3);
  min-width: 0;
}

.cy-token-eye {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: var(--cy-radius-4);
  color: var(--cy-muted);
  background: transparent;
  border: 1px solid var(--cy-border);
}

.cy-token-eye:hover {
  color: var(--cy-accent-text);
  background: var(--cy-surface-hover);
}

.cy-token-eye[aria-pressed='true'] {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-token-hint {
  color: var(--cy-muted);
  font-size: var(--cy-font-xs);
}

.cy-token-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cy-space-4);
}

.cy-token-clear {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--cy-danger);
  font-size: var(--cy-font-sm);
  cursor: pointer;
}

.cy-token-clear:hover:not(:disabled) {
  text-decoration: underline;
}

.cy-token-clear:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-input {
  width: 100%;
  min-width: 0;
  padding: var(--cy-space-3) var(--cy-space-4);
  color: var(--cy-text);
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4);
  outline: 0;
  font-size: var(--cy-font-md);
}

.cy-input:focus {
  border-color: var(--cy-accent-strong);
}

.cy-server-info {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-err {
  color: var(--cy-danger);
  font-size: var(--cy-font-sm);
}

/* trust-boundary.spec 断言类名：连接错误经 onChatError → connectionStore.setError → 本元素渲染 */
.cy-conn-error {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-1);
  padding: var(--cy-space-3-5) var(--cy-space-4-5);
  color: var(--cy-danger);
  background: var(--cy-surface-soft);
  border: 1px dashed var(--cy-danger);
  border-radius: var(--cy-radius-4);
  font-size: var(--cy-font-sm);
  overflow-wrap: anywhere;
}

.cy-conn-error-hint {
  color: var(--cy-muted);
}
</style>
