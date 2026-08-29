<script setup lang="ts">
// CyConnectionPanel:连接装配面板(真实模式联调 FE-P1-01/FE-P0-01)。
// - 装配模式(MOCK/REAL)来自 chat:get-runtime-info;Mock 模式隐藏 Endpoint/Token 输入;
// - Endpoint 经 setEndpoint 规范化(origin 变化自动清 token 绑定);Token 密码框提交后立即清空明文(spec 3.2.2);
// - connect 无参:endpoint/token 由 Main 侧 connection-config 持有。
// UII-QQ 重构:常驻 260px 连接卡 → 紧凑状态徽标（REAL·已连接）+ 点击 popover 展开
// （Endpoint/Token/版本/连接错误/连接·断开，Esc/点外部关闭）。能力不删，只调入口与视觉层级（任务约束 3）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import type { CredentialStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'
import { parsePublicError } from '../utils/public-error'

const connection = useConnectionStore()
const mode = ref<'real' | 'mock'>('real')
const endpointInput = ref('')
const tokenInput = ref('')
const tokenStatus = ref<CredentialStatus>('empty')
const endpointErr = ref<string>()
const tokenErr = ref<string>()
const busy = ref(false)
const serverVersion = computed(() => connection.state.serverVersion)
const protocolVersion = computed(() => connection.state.protocolVersion)
const connected = computed(() => connection.state.status === 'connected')
const tokenLabel = computed(() => ({ available: 'Token 已设置', empty: 'Token 未设置', unavailable: '凭据存储不可用', locked: '凭据已锁定' }[tokenStatus.value] ?? ''))

/** 徽标文案：mode + 连接状态（.cy-status-text 保留精确状态文本——5 个集成测试轮询该类名） */
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
      return '连接错误'
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

// —— popover 开合（Esc / 点击外部关闭；面板不被滚动区裁切——header 非 scroll 容器，absolute 锚定徽标） ——
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
    // origin 变化 → Main 已自动清 token+binding,chip 同步刷新(最终 review 修复)
    tokenStatus.value = await api.getCredentialStatus()
  } catch (e: unknown) {
    endpointErr.value = e instanceof Error ? parsePublicError(e.message).message : String(e)
  }
}

async function applyToken(): Promise<void> {
  tokenErr.value = undefined
  const t = tokenInput.value.trim()
  if (!t) return
  try {
    tokenStatus.value = await api.setBackendToken(t)
  } catch (e: unknown) {
    tokenErr.value = e instanceof Error ? parsePublicError(e.message).message : String(e)
  } finally {
    tokenInput.value = ''   // 提交后立即清空明文(spec 3.2.2)
  }
}

async function clearToken(): Promise<void> {
  tokenStatus.value = await api.clearBackendToken()
}

async function toggleConnect(): Promise<void> {
  busy.value = true
  try {
    if (connected.value) await connection.disconnect()
    else await connection.connect()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div ref="rootRef" class="cy-connection-panel">
    <!-- 紧凑状态徽标：REAL·已连接 / MOCK·未连接 …（点击开 popover；窄容器缩为点+mode）。
         不设 aria-label——可见文本即可达名（读屏读出 mode+状态），aria-expanded 表达开合 -->
    <button
      class="cy-conn-badge"
      :aria-expanded="open"
      title="连接设置"
      @click="open = !open"
    >
      <span class="cy-conn-dot" :class="statusTone" aria-hidden="true" />
      <span class="cy-conn-mode">{{ modeLabel }}</span>
      <span class="cy-conn-sep" aria-hidden="true">·</span>
      <span class="cy-status-text">{{ statusLabel }}</span>
    </button>

    <!-- 配置 popover：Endpoint / Token / 后端与协议版本 / 连接错误 / 连接·断开（能力不删，任务约束 3） -->
    <div v-if="open" class="cy-conn-pop" role="dialog" aria-label="连接设置">
      <button class="cy-btn cy-connect-btn" :disabled="busy" @click="toggleConnect">
        {{ connected ? '断开' : '连接' }}
      </button>

      <template v-if="mode !== 'mock'">
        <div class="cy-pop-field">
          <label class="cy-pop-label" for="cy-conn-endpoint">Endpoint</label>
          <div class="cy-row cy-row-form">
            <input id="cy-conn-endpoint" v-model="endpointInput" class="cy-input" type="text" placeholder="https://… 或回环 http://127.0.0.1:8765" />
            <button class="cy-btn" :disabled="busy" @click="applyEndpoint">设置</button>
          </div>
          <div v-if="endpointErr" class="cy-err">{{ endpointErr }}</div>
        </div>
        <div class="cy-pop-field">
          <label class="cy-pop-label" for="cy-conn-token">Token</label>
          <div class="cy-row cy-row-form">
            <span class="cy-token-label">{{ tokenLabel }}</span>
            <input id="cy-conn-token" v-model="tokenInput" class="cy-input" type="password" placeholder="Token" @keyup.enter="applyToken" />
            <button class="cy-btn" :disabled="busy" @click="applyToken">设置</button>
            <button v-if="tokenStatus === 'available'" class="cy-btn" :disabled="busy" @click="clearToken">清除</button>
          </div>
          <div v-if="tokenErr" class="cy-err">{{ tokenErr }}</div>
        </div>
      </template>

      <div v-if="serverVersion || protocolVersion" class="cy-server-info">
        后端 {{ serverVersion }} · 协议 {{ protocolVersion }}
      </div>
      <div v-if="connection.error" class="cy-conn-error">{{ connection.error.message }}</div>
    </div>
  </div>
</template>

<style scoped>
.cy-connection-panel {
  position: relative;
  flex: 0 0 auto;
}

/* 紧凑徽标：一个入口同时表达 mode + 状态（替代原「绿点+已连接」+260px 连接卡双份表达） */
.cy-conn-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--cy-border);
  border-radius: 999px;
  background: var(--cy-surface);
  color: var(--cy-muted);
  font-size: 12px;
  white-space: nowrap;
}

.cy-conn-badge:hover {
  background: var(--cy-surface-hover);
}

.cy-conn-badge[aria-expanded='true'] {
  background: var(--cy-surface-hover);
}

.cy-conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cy-muted);
}

.cy-conn-dot.is-connected { background: var(--cy-success); }
.cy-conn-dot.is-connecting { background: var(--cy-warning); }
.cy-conn-dot.is-error { background: var(--cy-danger); }

.cy-conn-mode {
  color: var(--cy-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.cy-status-text {
  color: var(--cy-text);
  /* 问题 6/附注 B：状态文字不折行 */
  white-space: nowrap;
}

/* popover：锚定徽标右对齐，不被裁切（header 非 scroll 容器）；层级高于消息区 */
.cy-conn-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 320px;
  padding: 12px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  box-shadow: var(--cy-shadow);
  font-size: 12px;
}

.cy-connect-btn {
  padding: 7px 0;
  color: var(--cy-accent-text);
  background: var(--cy-accent-strong);
  border: 0;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 500;
}

.cy-connect-btn:hover:not(:disabled) {
  filter: brightness(1.06);
}

.cy-pop-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cy-pop-label {
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cy-token-label {
  flex: 0 0 auto;
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  color: var(--cy-text);
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  border-radius: 8px;
  outline: 0;
  font-size: 11px;
}

.cy-input:focus {
  border-color: var(--cy-accent-strong);
}

.cy-btn {
  flex: 0 0 auto;
  padding: 5px 9px;
  color: var(--cy-muted);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 8px;
  font-size: 11px;
  white-space: nowrap;
}

.cy-btn:hover {
  background: var(--cy-surface-hover);
}

.cy-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cy-err {
  color: var(--cy-danger);
  font-size: 11px;
}

.cy-server-info {
  color: var(--cy-muted);
  font-size: 11px;
}

/* trust-boundary.spec 断言类名：连接错误经 onChatError → connectionStore.setError → 本元素渲染 */
.cy-conn-error {
  color: var(--cy-danger);
  font-size: 11px;
  overflow-wrap: anywhere;
}

/* G1 容器查询（容器 = .cy-chat-header）：窄聊天把徽标缩为「点 + mode」（状态细节在 popover 内仍完整可达） */
@container (max-width: 419px) {
  .cy-conn-sep,
  .cy-status-text {
    display: none;
  }
  .cy-conn-pop {
    width: 260px;
  }
}
</style>
