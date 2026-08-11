<script setup lang="ts">
// CyConnectionPanel:连接装配面板(真实模式联调 FE-P1-01/FE-P0-01)。
// - 装配模式(MOCK/REAL)来自 chat:get-runtime-info;Mock 模式隐藏 Endpoint/Token 输入;
// - Endpoint 经 setEndpoint 规范化(origin 变化自动清 token 绑定);Token 密码框提交后立即清空明文(spec 3.2.2);
// - connect 无参:endpoint/token 由 Main 侧 connection-config 持有。
import { computed, onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection.store'
import type { CredentialStatus } from '@shared/contracts'
import { api } from '../stores/desktop-api'

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
  } catch (e: unknown) {
    endpointErr.value = e instanceof Error ? e.message : String(e)
  }
}

async function applyToken(): Promise<void> {
  tokenErr.value = undefined
  const t = tokenInput.value.trim()
  if (!t) return
  try {
    tokenStatus.value = await api.setBackendToken(t)
  } catch (e: unknown) {
    tokenErr.value = e instanceof Error ? e.message : String(e)
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
  <div class="cy-connection-panel">
    <div class="cy-mode-row">
      <span class="cy-mode-badge">{{ mode === 'mock' ? 'MOCK 演示模式' : 'REAL' }}</span>
    </div>
    <div v-if="mode !== 'mock'" class="cy-row">
      <input v-model="endpointInput" class="cy-input" type="text" placeholder="https://… 或回环 http://127.0.0.1:8765" />
      <button class="cy-btn" :disabled="busy" @click="applyEndpoint">设置</button>
    </div>
    <div v-if="endpointErr" class="cy-err">{{ endpointErr }}</div>
    <div v-if="mode !== 'mock'" class="cy-row">
      <span class="cy-token-label">{{ tokenLabel }}</span>
      <input v-model="tokenInput" class="cy-input" type="password" placeholder="Token" @keyup.enter="applyToken" />
      <button class="cy-btn" :disabled="busy" @click="applyToken">设置</button>
      <button v-if="tokenStatus === 'available'" class="cy-btn" :disabled="busy" @click="clearToken">清除</button>
    </div>
    <div v-if="tokenErr" class="cy-err">{{ tokenErr }}</div>
    <div class="cy-row">
      <button class="cy-btn cy-connect-btn" :disabled="busy" @click="toggleConnect">
        {{ connected ? '断开' : '连接' }}
      </button>
    </div>
    <div v-if="serverVersion || protocolVersion" class="cy-server-info">
      后端 {{ serverVersion }} · 协议 {{ protocolVersion }}
    </div>
    <div v-if="connection.error" class="cy-conn-error">{{ connection.error.message }}</div>
  </div>
</template>

<style scoped>
.cy-connection-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 260px;
  padding: 8px 10px;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
}

.cy-mode-row {
  display: flex;
  align-items: center;
}

.cy-mode-badge {
  padding: 2px 8px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.04em;
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

.cy-connect-btn {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-err {
  color: var(--cy-danger);
  font-size: 11px;
}

.cy-server-info {
  color: var(--cy-muted);
  font-size: 11px;
}

.cy-conn-error {
  color: var(--cy-danger);
  font-size: 11px;
}
</style>
