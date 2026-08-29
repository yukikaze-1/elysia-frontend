<script setup lang="ts">
// CyConnectionPanel:连接装配面板(真实模式联调 FE-P1-01/FE-P0-01)。
// - 装配模式(MOCK/REAL)来自 chat:get-runtime-info;Mock 模式隐藏 Endpoint/Token 输入;
// - Endpoint 经 setEndpoint 规范化(origin 变化自动清 token 绑定);Token 密码框提交后立即清空明文(spec 3.2.2);
// - connect 无参:endpoint/token 由 Main 侧 connection-config 持有。
import { computed, onMounted, ref } from 'vue'
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
  <div class="cy-connection-panel">
    <!-- UI 问题 6：头部只显联调关键态（mode badge + 连接/断开）；Endpoint/Token/版本/错误收进「配置」折叠，
         默认收起，避免联调产物常驻产品 UI 最显眼位置。Endpoint/Token 设置入口仍可达（总原则 3 不回退）。 -->
    <details class="cy-conn-config">
      <summary>
        <span class="cy-conn-config-toggle">配置</span>
        <span class="cy-mode-badge">{{ mode === 'mock' ? 'MOCK' : 'REAL' }}</span>
      </summary>
      <div v-if="mode !== 'mock'" class="cy-row cy-row-form">
        <input v-model="endpointInput" class="cy-input" type="text" placeholder="https://… 或回环 http://127.0.0.1:8765" />
        <button class="cy-btn" :disabled="busy" @click="applyEndpoint">设置</button>
      </div>
      <div v-if="endpointErr" class="cy-err">{{ endpointErr }}</div>
      <div v-if="mode !== 'mock'" class="cy-row cy-row-form">
        <span class="cy-token-label">{{ tokenLabel }}</span>
        <input v-model="tokenInput" class="cy-input" type="password" placeholder="Token" @keyup.enter="applyToken" />
        <button class="cy-btn" :disabled="busy" @click="applyToken">设置</button>
        <button v-if="tokenStatus === 'available'" class="cy-btn" :disabled="busy" @click="clearToken">清除</button>
      </div>
      <div v-if="tokenErr" class="cy-err">{{ tokenErr }}</div>
      <div v-if="serverVersion || protocolVersion" class="cy-server-info">
        后端 {{ serverVersion }} · 协议 {{ protocolVersion }}
      </div>
      <div v-if="connection.error" class="cy-conn-error">{{ connection.error.message }}</div>
    </details>
    <div class="cy-row">
      <button class="cy-btn cy-connect-btn" :disabled="busy" @click="toggleConnect">
        {{ connected ? '断开' : '连接' }}
      </button>
    </div>
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

.cy-conn-config {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 「配置」折叠开关行：默认收起，Endpoint/Token/版本/错误 均在展开后可见 */
.cy-conn-config > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  cursor: pointer;
  user-select: none;
}
.cy-conn-config > summary::-webkit-details-marker { display: none; }

.cy-conn-config-toggle {
  padding: 2px 8px;
  color: var(--cy-muted);
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  border-radius: 999px;
  font-size: 11px;
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

/* G1（spec §4.7）：作用于最近容器 .cy-chat-header（container-type: inline-size）。
   仅「极端窄聊天」才压缩连接面板：默认四区态聊天内容盒 = 540−28 边距 = 512px（窗口 1200），
   会话栏折叠后 672px（窗口 1100），均 ≥ 420 —— 输入行始终可见；
   chat 内容盒 < 420px（约 chat<448px，仅极窄视口 520/375 或嵌入场景可达）才隐藏 Endpoint/Token 行。 */
@container (max-width: 419px) {
  .cy-connection-panel {
    min-width: auto;
  }
  .cy-row-form {
    display: none;
  }
}
@container (max-width: 319px) {
  .cy-mode-badge {
    display: none;
  }
}
</style>
