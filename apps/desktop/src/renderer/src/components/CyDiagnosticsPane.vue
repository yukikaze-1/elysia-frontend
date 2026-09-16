<!-- src/renderer/src/components/CyDiagnosticsPane.vue -->
<!-- 阶段 7 批次 A（Task 6）：设置中心「开发与诊断」真页——四分区：
  ① 日志管理（路径/大小/保留期/文件列表/打开/清理）
  ② 开发者模式（开关+二次确认+状态标识+dev 展示项）
  ③ 连接诊断（只读 connectionStore 展示）
  ④ 脱敏诊断导出（按钮+结果提示）
  定案：无全局 store——组件直连 desktopApi（api）+ 局部 ref 状态，dev 事件列表仅 pane 内使用。
  布局纪律同 CySecurityPane（.cy-l2d-pane/.cy-l2d-group/.cy-l2d-sub 卡片式；内部滚动归父级 .cy-settings-body）。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../stores/desktop-api'
import { useConnectionStore } from '../stores/connection.store'
import { useConversationStore } from '../stores/conversation.store'
import { useLive2dStore } from '../stores/live2d.store'
import { useMessageStore } from '../stores/message.store'
import { useVoiceStore } from '../stores/voice.store'
import type { DiagnosticsDevEvent, DiagnosticsExportResult, DiagnosticsState } from '@shared/contracts'
import type { PublicToolEvent } from '@shared/contracts/tool'

/** 开发者模式二次确认固定文案（D7A-04/spec §6.4）：明确 DevTools 风险边界——防误触唯一门（逐字不可改） */
const DEV_MODE_CONFIRM_TEXT = 'DevTools 可查看当前页面 DOM 与正在输入的内容；已保存凭据不可读回；远程调试端口始终关闭；重启后自动关闭'
/** 日志清理二次确认文案（防误触；审计日志由后端保留期管辖不在此清理面） */
const CLEAR_LOGS_CONFIRM_TEXT = '确认清理日志文件？将删除当前日志与轮转历史。此操作不可撤销。'
/** dev 事件列表上界：镜像 Main 侧 devTap ring 200（D7A-06）——本 pane 会话内不无限增长 */
const DEV_EVENT_CAP = 200

const conn = useConnectionStore()
const conversation = useConversationStore()
const live2dStore = useLive2dStore()
const message = useMessageStore()
const voice = useVoiceStore()

// —— 局部状态（无全局 store 定案）：状态拉取 fail-open（D7A-02/异步失败不阻塞设置页，同 CySecurityPane）——
const state = ref<DiagnosticsState | null>(null)
const loadError = ref(false)
const exportMsg = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)
const exporting = ref(false)   // C-15：诊断导出 in-flight 锁——导出进行中禁再次触发（防并发导出/重复对话框）
const devEvents = ref<DiagnosticsDevEvent[]>([])
const tools = ref<PublicToolEvent[]>([])
const toolsError = ref(false)
let unsubDev: (() => void) | null = null
// 2026-09-16 审计 P2：组件在 `await api.diagnosticsState()` 期间被卸载时，订阅**仍会被建立**而
// onBeforeUnmount 早已跑过（`unsubDev` 那时还是 null）⇒ 订阅永久驻留、每挂载一次泄漏一个（S-3
// 「订阅建在 await 之后」的实例）。用一个卸载标记在订阅建立后立刻自检并拆除。
let unmounted = false

onMounted(async () => {
  try {
    // 浅拷贝包裹：同引用响应不可靠（刷新路径 state.value 重赋同对象不触发）——契约形状为 plain object，展开安全
    state.value = { ...(await api.diagnosticsState()) }
  } catch {
    // fail-open：state 拉取失败 → 降级显示错误提示；连接诊断等与 state 无关分区照常
    loadError.value = true
  }
  // dev 事件订阅（onToolEvent 先例反方向——renderer 侧订阅；Main devTap 仅 devMode 会话态推送）
  if (unmounted) return   // 在途卸载：**不建立**订阅（建立即无人拆除）
  unsubDev = api.onDiagnosticsDevEvent((ev) => {
    devEvents.value.push(ev)
    if (devEvents.value.length > DEV_EVENT_CAP) devEvents.value.shift()
  })
})

onBeforeUnmount(() => {
  unmounted = true
  unsubDev?.()
  unsubDev = null
})

/** devMode 变化：关闭 → 清空本地事件列表（spec §6.4「禁用：renderer 清空展示」）；开启 → 拉工具清单 */
watch(() => state.value?.devMode, (devMode) => {
  if (devMode === false) devEvents.value = []
  if (devMode === true) void loadTools()
})

async function refreshState(): Promise<void> {
  try {
    state.value = { ...(await api.diagnosticsState()) }   // 浅拷贝：见 onMounted 注——刷新新对象保响应性
  } catch {
    // fail-open：刷新失败保留旧值（devMode 等展示以最后一次成功为准）
  }
}

/** 工具清单（spec §6.4 dev 展示项）：tool:list 容错——失败显示「不可用」不阻塞分区 */
async function loadTools(): Promise<void> {
  toolsError.value = false
  try {
    tools.value = await api.toolList()
  } catch {
    tools.value = []
    toolsError.value = true
  }
}

/** 开发者模式开关：启用=固定串二次确认→set(true)；关闭=短确认→set(false)；幂等由 Main 保证 */
async function onToggleDev(): Promise<void> {
  if (!state.value) return
  const next = !state.value.devMode
  if (next) {
    if (!window.confirm(DEV_MODE_CONFIRM_TEXT)) return
  } else {
    if (!window.confirm('确认关闭开发者模式？DevTools 将关闭，已打开的 dev 展示项隐藏。')) return
  }
  try {
    await api.diagnosticsDevModeSet(next)
  } catch {
    // fail-open：设置失败（IPC 错误）保持现状——不乐观翻转本地展示
  }
  await refreshState()
}

async function onClearLogs(): Promise<void> {
  if (!window.confirm(CLEAR_LOGS_CONFIRM_TEXT)) return
  try {
    await api.diagnosticsClearLogs()
  } catch {
    // fail-open：清理失败保持现状（真实路径经日志写出；无部分清理回滚）
  }
  await refreshState()   // 结果经 state.lastCleanup 回显（「已清理 N 文件/释放 M 字节」）
}

async function onOpenDir(): Promise<void> {
  try {
    await api.diagnosticsOpenLogDir()
  } catch {
    // fail-open：shell.openPath 失败静默（打开目录为即时操，无状态可展示）
  }
}

async function onExport(): Promise<void> {
  if (exporting.value) return   // C-15：in-flight 去重——导出进行中再次点击直接忽略（并保持按钮禁用态）
  exporting.value = true
  try {
    const r: DiagnosticsExportResult = await api.diagnosticsExport()
    if (r.cancelled) return   // 用户取消导出对话框：静默（保留上一次提示）
    exportMsg.value = {
      kind: 'ok',
      text: `已导出：${r.displayPath}（${fmtBytes(r.sizeBytes)}${r.truncatedLog ? '，日志已截断' : ''}${r.truncatedAudit ? '，审计已截断' : ''}）`,
    }
  } catch (e) {
    exportMsg.value = { kind: 'err', text: `导出失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    exporting.value = false
  }
}

// —— 展示辅助（纯函数，无 ctx 泄漏）——

function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${trim1(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${trim1(mb)} MB`
  return `${trim1(mb / 1024)} GB`
}
function trim1(x: number): number { return Number.parseFloat(x.toFixed(1)) }
function fmtTs(ts: string): string { return ts.slice(0, 19).replace('T', ' ') }

const CONN_LABELS: Record<string, string> = {
  disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '连接错误',
}
const VOICE_LABELS: Record<string, string> = {
  idle: '空闲', recording: '录音中', record_pending: '等待识别', realtime: '实时会话', dictating: '听写中',
}

const connStatusLabel = computed(() => CONN_LABELS[conn.state.status] ?? conn.state.status)
const connErrorText = computed(() => conn.error?.message ?? conn.state.lastError ?? '')
/** 后端 origin（Store 摘要展示项）：URL 解析失败回退原文——与 Main 侧派生口径同构（try/catch 确定性） */
const originText = computed(() => {
  const u = conn.state.serverUrl
  if (!u) return '未知'
  try { return new URL(u).origin } catch { return u }
})
const storeSummary = computed(() => ({
  messages: message.order.length,   // 当前会话消息 id 计数——仅计数，无消息正文（pinia 解包 ref → 值为数组）
}))
const cleanupText = computed(() => {
  const c = state.value?.lastCleanup
  if (!c) return ''
  return `已清理 ${c.removedFiles} 个文件，释放 ${fmtBytes(c.freedBytes)}`
})
/** Live2D 性能读数（7D）：读取时取值——诊断页打开时读当前值（面板 7D 起常驻挂载，settings 打开仍保持 ready → 显示真实帧读数） */
const live2dStats = computed(() => live2dStore.getStats())
</script>

<template>
  <section class="cy-l2d-pane" aria-label="开发与诊断">
    <h3 class="cy-l2d-title">开发与诊断</h3>

    <!-- ① 日志管理 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">日志管理</h4>
      <p v-if="loadError" class="cy-security-empty" data-testid="diag-state-error">诊断状态加载失败——日志/开发者模式信息不可用，连接诊断仍可查看。</p>
      <template v-if="state">
        <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">日志目录</span><span data-testid="diag-log-dir" class="cy-diagnostic-val">{{ state.displayDir }}</span></p>
        <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">当前大小</span><span data-testid="diag-log-size" class="cy-diagnostic-val">{{ fmtBytes(state.logSizeBytes) }}</span></p>
        <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">保留期</span><span data-testid="diag-log-retention" class="cy-diagnostic-val">日志轮转 5MB×{{ state.retentionDays }} 份；审计保留 {{ state.auditRetentionDays }} 天</span></p>
        <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">dev 事件丢弃</span><span data-testid="diag-log-dropped" class="cy-diagnostic-val">{{ state.eventDropped }}</span></p>
        <div class="cy-diagnostic-actions">
          <button type="button" class="cy-security-btn" data-testid="diag-log-open" @click="onOpenDir">打开目录</button>
          <button type="button" class="cy-security-btn" data-testid="diag-log-clear" @click="onClearLogs">清理日志</button>
        </div>
        <p v-if="cleanupText" class="cy-security-empty" data-testid="diag-cleanup-result">{{ cleanupText }}</p>
        <ul v-if="state.logFiles.length" class="cy-diagnostic-files" data-testid="diag-log-files">
          <li v-for="f in state.logFiles" :key="f.name" class="cy-diagnostic-file-item">
            <span class="cy-diagnostic-file-name">{{ f.name }}</span>
            <span class="cy-diagnostic-file-size">{{ fmtBytes(f.sizeBytes) }}</span>
            <span class="cy-diagnostic-file-ts">{{ fmtTs(f.modifiedAt) }}</span>
          </li>
        </ul>
        <p v-else class="cy-security-empty">暂无日志文件。</p>
      </template>
    </div>

    <!-- ② 开发者模式 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">开发者模式
        <span v-if="state?.devMode" class="cy-diagnostic-badge" data-testid="diag-dev-badge">已开启</span>
      </h4>
      <p v-if="state?.devMode" class="cy-diagnostic-banner" data-testid="diag-dev-banner">开发者模式已开启——DevTools 未随本页关闭；远程调试端口始终关闭；重启后自动关闭。</p>
      <p class="cy-security-empty">启用后打开 DevTools 并显示脱敏开发信息（协议事件/工具清单/Store 摘要）。已保存凭据不可读回；远程调试端口始终关闭；重启后自动关闭。</p>
      <button v-if="state" type="button" class="cy-security-btn" data-testid="diag-dev-toggle"
              :aria-pressed="state.devMode" @click="onToggleDev">{{ state.devMode ? '关闭开发者模式' : '开启开发者模式' }}</button>

      <!-- dev 展示项（仅 devMode 时渲染；全部元数据零正文） -->
      <template v-if="state?.devMode">
        <h5 class="cy-diagnostic-dev-subtitle">协议事件（脱敏）</h5>
        <ul v-if="devEvents.length" class="cy-diagnostic-events" data-testid="diag-dev-events">
          <li v-for="(e, i) in devEvents" :key="e.ts + e.type + i" class="cy-diagnostic-event-item">
            <span class="cy-diagnostic-event-ts">{{ fmtTs(e.ts) }}</span>
            <span class="cy-diagnostic-event-type">{{ e.type }}</span>
            <span class="cy-diagnostic-event-preview">{{ e.preview }}</span>
          </li>
        </ul>
        <p v-else class="cy-security-empty" data-testid="diag-dev-events">暂无协议事件（开发者模式下协议事件脱敏条目将在此显示）。</p>

        <h5 class="cy-diagnostic-dev-subtitle">工具调用（最近）</h5>
        <ul v-if="tools.length" class="cy-diagnostic-events" data-testid="diag-dev-tools">
          <li v-for="t in tools" :key="t.id" class="cy-diagnostic-event-item">
            <span class="cy-diagnostic-event-type">{{ t.toolName }}</span>
            <span class="cy-diagnostic-event-preview">{{ t.title }} · {{ t.status }}</span>
          </li>
        </ul>
        <p v-else class="cy-security-empty" data-testid="diag-dev-tools">{{ toolsError ? '工具清单不可用' : '暂无工具调用记录' }}</p>

        <h5 class="cy-diagnostic-dev-subtitle">Store 状态摘要</h5>
        <dl class="cy-diagnostic-store" data-testid="diag-dev-store">
          <div class="cy-diagnostic-store-row"><dt>连接状态</dt><dd data-testid="diag-store-conn">{{ connStatusLabel }}</dd></div>
          <div class="cy-diagnostic-store-row"><dt>origin</dt><dd data-testid="diag-store-origin">{{ originText }}</dd></div>
          <div class="cy-diagnostic-store-row"><dt>当前会话</dt><dd data-testid="diag-store-session">{{ conversation.currentId ?? '—' }}</dd></div>
          <div class="cy-diagnostic-store-row"><dt>消息计数</dt><dd data-testid="diag-store-messages">{{ storeSummary.messages }}</dd></div>
          <div class="cy-diagnostic-store-row"><dt>语音状态</dt><dd data-testid="diag-store-voice">{{ VOICE_LABELS[voice.mode] ?? voice.mode }}</dd></div>
        </dl>

        <h5 class="cy-diagnostic-dev-subtitle">Live2D 性能</h5>
        <p v-if="live2dStats" class="cy-diagnostic-line" data-testid="diag-dev-perf">
          帧耗时（EMA）：<span class="cy-diagnostic-val">{{ live2dStats.emaCostMs.toFixed(1) }} ms</span>
          <template v-if="live2dStats.autoTargetFps">&nbsp;·&nbsp;目标帧率：{{ live2dStats.autoTargetFps }} fps</template>
          &nbsp;·&nbsp;模式：{{ live2dStats.mode }}
        </p>
        <p v-else class="cy-security-empty" data-testid="diag-dev-perf">Live2D 未启动（无读数）</p>

        <h5 class="cy-diagnostic-dev-subtitle">详细前端日志</h5>
        <button type="button" class="cy-security-btn" data-testid="diag-dev-log-link" @click="onOpenDir">打开日志目录</button>
      </template>
    </div>

    <!-- ③ 连接诊断（只读；display 复用 CyConnectionPanel 错误展示先例 connection.error.message） -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">连接诊断</h4>
      <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">连接状态</span><span class="cy-diagnostic-val" data-testid="diag-conn-status">{{ connStatusLabel }}</span></p>
      <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">端点</span><span class="cy-diagnostic-val cy-diagnostic-break" data-testid="diag-conn-endpoint">{{ conn.state.serverUrl ?? '—' }}</span></p>
      <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">协议版本</span><span class="cy-diagnostic-val" data-testid="diag-conn-proto">{{ conn.state.protocolVersion ?? '—' }}<template v-if="conn.state.serverVersion"> · 后端 {{ conn.state.serverVersion }}</template></span></p>
      <p class="cy-diagnostic-line"><span class="cy-diagnostic-key">最近错误</span><span class="cy-diagnostic-val" data-testid="diag-conn-last-error">{{ connErrorText || '—' }}</span></p>
    </div>

    <!-- ④ 脱敏诊断导出 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">脱敏诊断导出</h4>
      <p class="cy-security-empty">导出脱敏后的运行日志、审计与连接现场为单个 JSON 文件（机密字段与本地绝对路径已净化；用户自选保存位置）。</p>
      <div class="cy-diagnostic-actions">
        <button type="button" class="cy-security-btn" data-testid="diag-export" :disabled="exporting" @click="onExport">导出诊断包…</button>
      </div>
      <p v-if="exportMsg" class="cy-security-empty" :class="{ 'cy-diagnostic-err': exportMsg.kind === 'err' }" data-testid="diag-export-result">{{ exportMsg.text }}</p>
    </div>
  </section>
</template>

<style scoped>
/* 布局纪律同 CySecurityPane（cy-l2d-pane/group/sub 卡片式；内部滚动归父级 .cy-settings-body） */
.cy-l2d-pane { display: flex; flex-direction: column; gap: var(--cy-space-8); }
.cy-l2d-title { margin: 0; font-size: var(--cy-font-xl); font-weight: 600; }
.cy-l2d-group { display: flex; flex-direction: column; gap: var(--cy-space-4-5); padding: var(--cy-space-6) var(--cy-space-7); background: var(--cy-surface-glass); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-6); box-shadow: var(--cy-shadow-soft); }
.cy-l2d-sub { margin: 0 0 var(--cy-space-1); font-size: var(--cy-font-lg); font-weight: 600; color: var(--cy-muted); display: flex; align-items: center; gap: var(--cy-space-4); }
.cy-security-empty { margin: 0; color: var(--cy-muted); font-size: var(--cy-font-md); line-height: 1.7; }
.cy-security-btn { min-height: 34px; padding: var(--cy-space-1-5) var(--cy-space-5); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-3); background: var(--cy-bg); cursor: pointer; font-size: var(--cy-font-md); transition: background var(--cy-motion-fast) ease, transform var(--cy-motion-fast) ease; }
.cy-security-btn:hover:not(:disabled) { background: var(--cy-surface-hover); transform: translateY(-1px); }
.cy-diagnostic-line { margin: 0; display: flex; gap: var(--cy-space-5); font-size: var(--cy-font-md); align-items: baseline; }
.cy-diagnostic-key { flex: 0 0 88px; color: var(--cy-muted); }
.cy-diagnostic-val { color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-diagnostic-break { word-break: break-all; }
.cy-diagnostic-actions { display: flex; gap: var(--cy-space-4); }
.cy-diagnostic-badge { padding: var(--cy-space-0-5) var(--cy-space-4); font-size: var(--cy-font-sm); font-weight: 600; color: var(--cy-accent-text); background: var(--cy-accent); border-radius: var(--cy-radius-pill); }
.cy-diagnostic-banner { margin: 0; padding: var(--cy-space-4) var(--cy-space-5); font-size: var(--cy-font-md); color: var(--cy-accent-text); background: var(--cy-accent); border-radius: var(--cy-radius-4); }
.cy-diagnostic-files, .cy-diagnostic-events { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--cy-space-3); }
.cy-diagnostic-file-item, .cy-diagnostic-event-item { display: flex; flex-wrap: wrap; gap: var(--cy-space-4); font-size: var(--cy-font-md); padding: var(--cy-space-3) var(--cy-space-5); background: var(--cy-surface-soft); border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); align-items: baseline; }
.cy-diagnostic-file-name, .cy-diagnostic-event-type { font-weight: 600; }
.cy-diagnostic-file-size, .cy-diagnostic-file-ts, .cy-diagnostic-event-ts { color: var(--cy-muted); font-size: var(--cy-font-sm); }
.cy-diagnostic-event-preview { color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-diagnostic-dev-subtitle { margin: var(--cy-space-3) 0 0; font-size: var(--cy-font-md); font-weight: 600; color: var(--cy-text-secondary); }
.cy-diagnostic-store { margin: 0; display: flex; flex-direction: column; gap: var(--cy-space-2); font-size: var(--cy-font-md); }
.cy-diagnostic-store-row { display: flex; gap: var(--cy-space-5); align-items: baseline; }
.cy-diagnostic-store-row dt { flex: 0 0 88px; color: var(--cy-muted); }
.cy-diagnostic-store-row dd { margin: 0; color: var(--cy-text-secondary); }
.cy-diagnostic-err { color: var(--cy-danger); }
</style>
