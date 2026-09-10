<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CharacterBindingSnapshot, CharacterPublicState, ConnectionState } from '@shared/contracts'
import type { PublicError } from '../utils/public-error'
// 别名：本组件已有一个 errorMessage computed（模板绑定用），避免与集中映射器重名
import { errorMessage as resolveErrorMessage } from '../utils/error-message'
import { useConnectionStore } from '../stores/connection.store'
import { useCharacterRuntimeStore, type CharacterRuntimeLoadState } from '../stores/character-runtime.store'
import {
  clampMoodIntensity,
  formatRelativeTime,
  resolveRecentInteractionAt
} from './character-public-state'

export interface CharacterRuntimeViewLike {
  activeBinding?: CharacterBindingSnapshot
  activeState?: CharacterPublicState
  activeStatus: CharacterRuntimeLoadState
  activeError?: PublicError
  loadState(instanceId: string, expected?: CharacterBindingSnapshot): Promise<void>
}

export interface CharacterConnectionViewLike {
  state: ConnectionState
}

const props = withDefaults(defineProps<{
  /** Optional injections keep the component independent from Pinia in unit tests. */
  runtime?: CharacterRuntimeViewLike
  connection?: CharacterConnectionViewLike
  now?: number | string | Date | (() => number)
  relativeTimeRefreshMs?: number
}>(), {
  relativeTimeRefreshMs: 60_000
})

const runtime = props.runtime ?? useCharacterRuntimeStore()
const connection = props.connection ?? useConnectionStore()

const nowMs = ref(readNow())
const retrying = ref(false)
let relativeTimeTimer: ReturnType<typeof setInterval> | undefined

function readNow(): number {
  const value = props.now
  if (typeof value === 'function') {
    const result = value()
    return Number.isFinite(result) ? result : Date.now()
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Date.now()
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now()
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : Date.now()
  }
  return Date.now()
}

function refreshRelativeTime(): void {
  nowMs.value = readNow()
}

watch(() => props.now, refreshRelativeTime)

const binding = computed(() => runtime.activeBinding)
const exactState = computed(() => {
  const currentBinding = binding.value
  const currentState = runtime.activeState
  // Keep the component fail-closed even when a host supplies a test double:
  // the current role card may only consume the exact active revision.
  if (!currentBinding || !currentState) return undefined
  if (currentState.characterId !== currentBinding.characterId
    || currentState.characterInstanceId !== currentBinding.characterInstanceId
    || currentState.characterRevision !== currentBinding.characterRevision) return undefined
  return currentState
})
const runtimeStatus = computed(() => runtime.activeStatus)
const runtimeError = computed(() => runtime.activeError)

const connectionStatus = computed(() => connection.state.status)
const connected = computed(() => connectionStatus.value === 'connected')
// profiles=true + state_stream=false is still a supported mode: state is
// loaded through the REST snapshot. The stream flag only changes live updates.
const stateCapabilityAvailable = computed(() => connected.value && connection.state.features?.characterProfiles === true)
const offline = computed(() => connectionStatus.value === 'disconnected' || connectionStatus.value === 'reconnecting')
const connecting = computed(() => connectionStatus.value === 'connecting')
const transportError = computed(() => connectionStatus.value === 'error')
const state = computed(() => {
  // A snapshot from an earlier capable connection must not look current when
  // the newly connected backend is legacy/unsupported. Offline is different:
  // the architecture explicitly allows showing the last known snapshot there.
  if (connected.value && !stateCapabilityAvailable.value) return undefined
  return exactState.value
})
const hasState = computed(() => state.value !== undefined)

type PublicStateUiStatus = 'unavailable' | 'loading' | 'ready' | 'stale' | 'error'

const uiStatus = computed<PublicStateUiStatus>(() => {
  if (!binding.value) return 'unavailable'
  if (connected.value && !stateCapabilityAvailable.value) return 'unavailable'
  if (offline.value) return 'stale'
  if (transportError.value) return hasState.value ? 'stale' : 'error'
  if (connecting.value) return hasState.value ? 'stale' : 'loading'
  if (runtimeStatus.value === 'loading') return 'loading'
  if (runtimeStatus.value === 'error') return 'error'
  if (runtimeStatus.value === 'stale') return 'stale'
  if (runtimeStatus.value === 'ready' || hasState.value) return 'ready'
  // A connected, capable binding with no snapshot is waiting for the
  // coordinator's first request. It is user-visible as a loading state.
  return 'loading'
})

const displayName = computed(() => {
  const name = binding.value?.displayName?.trim()
  return name || '当前角色'
})

const PUBLIC_TEXT_MAX_LENGTH = 160
const ERROR_TEXT_MAX_LENGTH = 240
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
/**
 * Error messages may contain serialized/internal payload fragments.
 *
 * 2026-09-10：同时拦住**浏览器/网络层的原生错误文本**。实测真机网络中断时本卡片直接显示了
 * `Failed to fetch`——那是 fetch 的原始技术细节，对用户毫无可操作性，当由兜底句接管。
 * 集中映射器（utils/error-message）无法处理它：该文本没有对应错误码，而映射器必须保留
 * 「无映射时回退后端已公开说明」这一档（后端说明是跨进程错误的唯一可见来源，不能丢）。
 * 故这类「形态可判但无语义码」的文本在本组件的脱敏层收口。
 */
const FORBIDDEN_ERROR_CONTENT = /[{}[\]]|(?:\b(?:L[234]|reflection|memory|relationship|internal[_\s-]*state|raw|json|prompt|stateVersion|characterInstanceId)\b|记忆|关系|反思|原始\s*JSON|Failed to fetch|NetworkError|Load failed|TypeError|undefined is not)/i

/**
 * The public projection is safe because it only receives already-selected
 * mood/activity fields. Do not blacklist ordinary content words such as
 * "memory" or "relationship": those are valid user-facing activity labels.
 * Normalize whitespace for the narrow rail and reject hidden control bytes;
 * Vue interpolation performs the final HTML escaping at render time.
 */
function safePublicText(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || DISALLOWED_CONTROL_CHARS.test(value)) return undefined
  const text = value.trim().replace(/\s+/gu, ' ')
  if (!text || text.length > PUBLIC_TEXT_MAX_LENGTH) return undefined
  return text
}

const moodLabel = computed(() => {
  return safePublicText(state.value?.mood?.label)
})
const currentActivity = computed(() => {
  return safePublicText(state.value?.currentActivity)
})
const interactionAt = computed(() => state.value ? resolveRecentInteractionAt(state.value) : undefined)
const recentInteraction = computed(() => interactionAt.value
  ? formatRelativeTime(interactionAt.value, nowMs.value)
  : '时间未知')
const moodIntensity = computed(() => clampMoodIntensity(state.value?.mood?.intensity))
const moodIntensityStyle = computed<Record<string, string>>(() => {
  const value = moodIntensity.value
  if (value === undefined) return {}
  const style: Record<string, string> = {}
  // Store the bounded scalar as a CSS variable, never as text in the DOM.
  style['--cy-public-mood-intensity'] = String(value)
  return style
})

const statusLabel = computed(() => {
  switch (uiStatus.value) {
    case 'loading': return '读取中'
    case 'ready': return '在线'
    case 'stale': return offline.value ? '离线 · 可能过期' : '可能过期'
    case 'error': return '读取失败'
    default: return '不可用'
  }
})

const statusMessage = computed(() => {
  if (!binding.value) return '暂无角色绑定'
  if (connected.value && !stateCapabilityAvailable.value) return '当前连接不支持角色公开状态'
  switch (uiStatus.value) {
    case 'loading': return hasState.value ? '正在更新角色状态…' : '正在读取角色状态…'
    case 'stale': return hasState.value ? '保留上次状态，恢复连接后更新' : '离线，暂无可用状态快照'
    case 'error': return hasState.value ? '暂时无法更新，仍显示上次状态' : '暂时无法读取角色状态'
    case 'ready': return '暂无可展示的公开状态'
    default: return '角色公开状态暂不可用'
  }
})

/**
 * 角色公开状态卡片里的错误文案。
 *
 * 2026-09-10 修复：此前直接放行 `error.message`，把**未经翻译的底层错误**显示给了用户
 * （实测真机：网络中断时卡片里出现浏览器的原生 `Failed to fetch`）。本组件是唯一绕过集中
 * 文案链的渲染点——`Utils/error-message` 早已是「错误码 → 用户可读文案」的单一来源。
 *
 * 现在两条链串联：
 *   ① `errorMessage()`：按 code/backendCode 映射为可读文案；未收录的错误码回退到
 *      Main 已公开的 message（跨进程错误的唯一可见来源，不能丢）；
 *   ② 本组件原有的脱敏检查：长度上限 + 禁用内容（原始 JSON/内部状态/prompt/记忆等词）。
 *      保留它是因为 ② 的诉求（公开卡片不得泄露内部状态）与 ① 的诉求（文案可读）不同，
 *      ② 仍要能拦住**已经过 ① 的**文本。
 *
 * 效果：`Failed to fetch` 这类浏览器原生错误会被兜底句替换；后端已公开的业务说明照常显示。
 */
function safeErrorMessage(error: PublicError | undefined): string {
  const fallback = '暂时无法读取角色状态，请稍后重试。'
  // ① 集中映射（含 backendCode 优先、本地码、以及「回退到已公开 message」三档）
  const resolved = resolveErrorMessage(error, fallback)
  // ② 本卡片的二次脱敏：归一空白 + 长度上限 + 禁用内容
  const candidate = resolved
    .replace(/\[[a-zA-Z][a-zA-Z0-9_]*=[^\]]+\]\s*/g, '')
    .replace(DISALLOWED_CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return !candidate || candidate.length > ERROR_TEXT_MAX_LENGTH || FORBIDDEN_ERROR_CONTENT.test(candidate)
    ? fallback
    : candidate
}

const errorMessage = computed(() => safeErrorMessage(runtimeError.value))
const retryable = computed(() => Boolean(
  binding.value
  && stateCapabilityAvailable.value
  && (uiStatus.value === 'error' || uiStatus.value === 'stale')
))
// Keep the action visible during the request so the user can see that a retry
// is in progress. Disabled is an interaction guard, not a visibility rule.
const showRetry = computed(() => retrying.value || retryable.value)

async function retry(): Promise<void> {
  const currentBinding = binding.value
  if (!currentBinding || retrying.value || !retryable.value) return
  retrying.value = true
  try {
    // Pass the complete current binding as the expectation. The runtime store
    // captures its identity and rejects responses from another revision.
    await runtime.loadState(currentBinding.characterInstanceId, currentBinding)
  } catch {
    // The store owns the public error transition; a test double or future
    // implementation may reject directly, which must not become unhandled.
  } finally {
    retrying.value = false
  }
}

onMounted(() => {
  const interval = Number.isFinite(props.relativeTimeRefreshMs) && props.relativeTimeRefreshMs > 0
    ? props.relativeTimeRefreshMs
    : 60_000
  relativeTimeTimer = setInterval(refreshRelativeTime, interval)
})

onBeforeUnmount(() => {
  if (relativeTimeTimer !== undefined) {
    clearInterval(relativeTimeTimer)
    relativeTimeTimer = undefined
  }
})

defineExpose({ refreshRelativeTime, retry })
</script>

<template>
  <section
    class="cy-public-state"
    :data-status="uiStatus"
    aria-labelledby="cy-public-state-title"
    :aria-busy="uiStatus === 'loading'"
  >
    <div class="cy-public-state-head">
      <div>
        <p id="cy-public-state-title" class="cy-public-state-kicker">公开状态</p>
        <p v-if="binding" class="cy-public-state-name" data-testid="public-state-character-name">{{ displayName }}</p>
      </div>
      <span class="cy-public-state-badge" :class="`is-${uiStatus}`">{{ statusLabel }}</span>
    </div>

    <template v-if="binding">
      <dl v-if="state" class="cy-public-state-facts">
        <div v-if="moodLabel" class="cy-public-state-fact cy-public-state-mood">
          <dt>心情</dt>
          <dd>
            <span>{{ moodLabel }}</span>
            <span
              v-if="moodIntensity !== undefined"
              class="cy-public-state-intensity"
              :style="moodIntensityStyle"
              aria-hidden="true"
            />
          </dd>
        </div>
        <div v-if="currentActivity" class="cy-public-state-fact">
          <dt>正在做</dt>
          <dd>{{ currentActivity }}</dd>
        </div>
        <div class="cy-public-state-fact">
          <dt>最近互动</dt>
          <dd>{{ recentInteraction }}</dd>
        </div>
      </dl>
      <p v-if="uiStatus === 'error'" class="cy-public-state-message is-error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="!state || statusMessage !== '暂无可展示的公开状态'" class="cy-public-state-message" role="status">{{ statusMessage }}</p>
      <p v-if="uiStatus === 'stale' && state" class="cy-public-state-note">已保留上次快照</p>
      <button
        v-if="showRetry"
        class="cy-public-state-retry"
        type="button"
        :disabled="retrying"
        :aria-busy="retrying"
        @click="retry"
      >
        {{ retrying ? '正在重试…' : '重试' }}
      </button>
    </template>
    <p v-else class="cy-public-state-message" role="status">{{ statusMessage }}</p>
  </section>
</template>

<style scoped>
.cy-public-state {
  flex: none;
  box-sizing: border-box;
  width: calc(100% - 24px);
  max-width: calc(100% - 24px);
  min-width: 0;
  margin: 0 var(--cy-space-6) var(--cy-space-4);
  padding: var(--cy-space-5);
  overflow: hidden;
  color: var(--cy-text);
  background: color-mix(in srgb, var(--cy-surface) 78%, var(--cy-accent) 22%);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
  font-size: var(--cy-font-md);
}

.cy-public-state-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--cy-space-4);
  min-width: 0;
}

.cy-public-state-head > div {
  min-width: 0;
}

.cy-public-state-kicker,
.cy-public-state-name,
.cy-public-state-message,
.cy-public-state-note {
  margin: 0;
}

.cy-public-state-kicker {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-public-state-name {
  max-width: 180px;
  margin-top: var(--cy-space-1);
  overflow: hidden;
  color: var(--cy-text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-public-state-badge {
  flex: none;
  padding: var(--cy-space-1) var(--cy-space-3-5);
  border-radius: var(--cy-radius-pill);
  color: var(--cy-muted);
  background: var(--cy-surface);
  font-size: var(--cy-font-xs);
  line-height: 1.3;
}

.cy-public-state-badge.is-ready {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-public-state-badge.is-loading {
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

.cy-public-state-badge.is-stale {
  color: var(--cy-warning-text);
  background: color-mix(in srgb, var(--cy-surface) 74%, #d6a34a 26%);
}

.cy-public-state-badge.is-error {
  color: var(--cy-danger-text);
  background: var(--cy-danger);
}

.cy-public-state-facts {
  display: grid;
  gap: var(--cy-space-3-5);
  margin: var(--cy-space-5) 0 0;
  min-width: 0;
}

.cy-public-state-fact {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  align-items: baseline;
  gap: var(--cy-space-4);
  min-width: 0;
}

.cy-public-state-fact dt {
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

.cy-public-state-fact dd {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--cy-text);
  word-break: break-word;
}

.cy-public-state-mood dd {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--cy-space-3-5);
  min-width: 0;
}

.cy-public-state-mood dd > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.cy-public-state-intensity {
  display: block;
  flex: none;
  width: 28px;
  height: 4px;
  overflow: hidden;
  border-radius: var(--cy-radius-pill);
  background: linear-gradient(90deg, var(--cy-accent-strong), var(--cy-accent));
  opacity: 0.8;
}

.cy-public-state-intensity::after {
  display: block;
  width: calc((1 - var(--cy-public-mood-intensity)) * 100%);
  height: 100%;
  margin-left: calc(var(--cy-public-mood-intensity) * 100%);
  background: var(--cy-surface);
  content: '';
}

.cy-public-state-message {
  min-width: 0;
  max-width: 100%;
  margin-top: var(--cy-space-4-5);
  overflow-wrap: anywhere;
  color: var(--cy-muted);
  line-height: 1.45;
  word-break: break-word;
}

.cy-public-state-message.is-error {
  color: var(--cy-danger-text);
}

.cy-public-state-note {
  min-width: 0;
  max-width: 100%;
  margin-top: var(--cy-space-2-5);
  overflow-wrap: anywhere;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  word-break: break-word;
}

.cy-public-state-retry {
  width: 100%;
  min-height: 28px;
  margin-top: var(--cy-space-4-5);
  padding: var(--cy-space-2) var(--cy-space-4-5);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4);
  background: var(--cy-surface);
  color: var(--cy-accent-text);
  font-size: var(--cy-font-sm);
}

.cy-public-state-retry:hover {
  background: var(--cy-surface-hover);
}

.cy-public-state-retry:disabled {
  cursor: wait;
  opacity: 0.72;
}
</style>
