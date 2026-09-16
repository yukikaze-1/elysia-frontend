<!-- src/renderer/src/components/CyToolCard.vue -->
<!-- UII-QQ 收尾（工具卡重构）：紧凑执行回执卡——
     标题区 = native button 折叠切换（Enter/Space 原生支持 + aria-expanded，操作按钮一律在标题区外，无嵌套 button）；
     折叠态仅一行结果摘要（outputSummary → inputSummary → 状态文案，单行省略，不从非结构化文本猜摘要）；
     详情区（调用参数/执行结果/错误）限高内部滚动；复制结果复用现有安全剪贴板封装（utils/clipboard，Web API 不经 IPC）。
     折叠默认值按状态：completed/rejected/cancelled/timeout 折叠；running/failed/requested/awaiting_permission 及
     capture 进行中默认展开；用户手动切换后本次组件生命周期尊重用户选择（running→completed 自动收起仅发生在未手动操作时）。
     授权/取消操作、capture 面板、只读 diff、归档截图不受折叠影响（现有 testid/事件/权限窗流全保留）。
     awaiting 态提供「允许此电脑操作」（打开权限窗）+「拒绝」对等按钮；取消按钮为独立 v-if（H13：与 awaiting 并存）。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { ToolCallRecord, ToolCallStatus, ToolRuntime } from '@shared/contracts/tool'
import { useToolStore } from '../stores/tool.store'
import { copyText } from '../utils/clipboard'
import { effectiveTruncated, formatDuration, formatToolBrief, formatToolDetail, parseStructuredSummary, singleLineText } from '../utils/tool-display'
import { errorMessage } from '../utils/error-message'
import CyImageAttachment from './CyImageAttachment.vue'

const props = defineProps<{ record: ToolCallRecord; readonly?: boolean }>()
const emit = defineEmits<{ openApproval: []; cancel: []; pick: [sourceId: string]; confirmUpload: [] }>()
const toolStore = useToolStore()

// —— 展示映射（仅前端轻映射，不改后端协议）：常见工具友好名；未命中回退原名（desktop. 前缀剥离），恒不空白；
// 原始工具 ID 保留在名称 title（诊断提示） ——
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  describe_image: '图片理解',
  get_runtime_config: '获取运行配置',
  read_file: '读取文件',
  write_file: '写入文件',
  web_search: '网络搜索',
  list_directory: '浏览目录',
  'desktop.screen.capture': '屏幕截图',
  'desktop.file.read': '读取文件',
  'desktop.file.write': '写入文件',
}
const displayToolName = computed(() => {
  const n = props.record.toolName
  return TOOL_DISPLAY_NAMES[n] ?? (n.startsWith('desktop.') ? n.slice('desktop.'.length) || n : n)
})

const RUNTIME_TEXT: Record<ToolRuntime, string> = { backend: '后端', desktop: '桌面', local_worker: '本地工作器' }
const runtimeText = computed(() => RUNTIME_TEXT[props.record.runtime] ?? props.record.runtime)
const isBackend = computed(() => props.record.runtime === 'backend')

/** 状态文案 + 语义色调（running=蓝 / 成功=绿 / 待操作=橙 / 失败=红 / 取消=灰——色只上小图标与状态文字） */
const STATUS_META: Record<ToolCallStatus, { text: string; tone: 'running' | 'success' | 'warning' | 'danger' | 'muted' }> = {
  requested: { text: '等待授权', tone: 'warning' },
  awaiting_permission: { text: '等待授权', tone: 'warning' },
  running: { text: '正在执行', tone: 'running' },
  completed: { text: '已完成', tone: 'success' },
  failed: { text: '执行失败', tone: 'danger' },
  rejected: { text: '用户已拒绝', tone: 'muted' },
  cancelled: { text: '已取消', tone: 'muted' },
  timeout: { text: '已超时', tone: 'danger' },
}
const statusText = computed(() => STATUS_META[props.record.status]?.text ?? props.record.status)
const statusTone = computed(() => STATUS_META[props.record.status]?.tone ?? 'muted')
const awaiting = computed(() => props.record.status === 'awaiting_permission' && !props.readonly)
/** 耗时（tool-display 纯函数）：undefined/null/NaN/Infinity/负数/0 一律不显示（防「0ms」误导） */
const durationText = computed(() => formatDuration(props.record.durationMs))

// —— 折叠规则：用户手动切换（userExpanded）优先，未操作时按状态默认（含 capture 进行中）——
const isCapture = computed(() => props.record.toolName === 'desktop.screen.capture')

/**
 * 预览元信息（尺寸 · 字节数）：doc 03 §10/PRD §12.3 要"说明截的是哪块屏/哪个窗"，
 * 尺寸与大小是让用户判断"这一屏是不是我要传的"的直接依据。
 * mock 注入面（CYRENE_MOCK_CAPTURE_SOURCES）没有真实缩略图 ⇒ 两字段都可能缺，缺则不显示该段。
 */
const previewMeta = computed(() => {
  const p = toolStore.captureState?.preview
  if (!p) return ''
  const parts: string[] = []
  if (p.width !== undefined && p.height !== undefined) parts.push(`${p.width}×${p.height}`)
  if (p.bytes !== undefined) parts.push(formatBytes(p.bytes))
  return parts.join(' · ')
})

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const userExpanded = ref<boolean | null>(null)   // null = 尚未手动操作（跟随默认值，status 变化自动翻转）
const defaultExpanded = computed(() => {
  if (['requested', 'awaiting_permission', 'running', 'failed'].includes(props.record.status)) return true
  return isCapture.value && !!toolStore.captureState && !props.readonly
})
const expanded = computed(() => userExpanded.value ?? defaultExpanded.value)
const detailsId = computed(() => `cy-tool-details-${props.record.id}`)
function toggle(): void {
  userExpanded.value = !expanded.value
}

/** 折叠摘要：结构化 JSON → 易读摘要（tool-display 纯函数，只做展示转换、不改 record）→
 *  inputSummary 单行 → 状态文案；不显示原始 JSON 整串 */
const briefText = computed(() =>
  formatToolBrief(props.record.toolName, props.record.status, props.record.outputSummary)
  ?? (props.record.inputSummary ? singleLineText(props.record.inputSummary) : undefined)
  ?? statusText.value
)
/** 展示用截断判定（record.truncated 或结构化结果顶层 truncated）——不修改原始 record */
const truncated = computed(() => effectiveTruncated(props.record))
/** 截断标签不重复：摘要已含「内容已截断」（文件读取）时不再追加 */
const showBriefTruncated = computed(() => truncated.value && !briefText.value.includes('内容已截断'))
/** 展开详情：合法 JSON → 2 空格缩进（is-json 等宽字体）；普通文本原样保留换行 */
const inputDetail = computed(() => formatToolDetail(props.record.inputSummary))
const outputDetail = computed(() => formatToolDetail(props.record.outputSummary))
const inputIsJson = computed(() => parseStructuredSummary(props.record.inputSummary) !== null)
const outputIsJson = computed(() => parseStructuredSummary(props.record.outputSummary) !== null)
/** 错误区仅真实失败/超时渲染——用户取消（cancelled）/拒绝（rejected）不是执行错误，不渲染红色区域
 *  （错误数据仍保留在 record 供诊断）；技术错误码在详情内弱化展示，标题只显示易读状态 */
const showError = computed(() =>
  (props.record.status === 'failed' || props.record.status === 'timeout') && !!props.record.error?.message
)
const errorCode = computed(() => {
  const c = props.record.error?.code
  return c && c !== 'TOOL_ERROR' ? c : ''
})
/**
 * 错误文案（2026-09-10）：**不再直接渲染 `record.error.message`**，改经 utils/error-message 单一来源。
 *
 * 此前这里是渲染层最后一处绕过集中映射的原始文案渲染点——其后果不是「显示错字」，而是
 * 「本地码有映射却在此地被绕过」：任何新增的错误码映射对本卡片静默失效，排查时表现为
 * 「同一错误在别处友好、在此处仍是技术原文」。回退链第 ③ 档保留 Main 已公开原文，
 * 故工具侧真实执行错误（如后端/桌面工具给出的可读失败说明）显示不变。
 */
const errorText = computed(() => {
  const err = props.record.error
  if (!err?.message) return ''
  return errorMessage({ code: err.code ?? 'UNKNOWN', message: err.message }, '工具执行失败，请重试。')
})

// L3（fix round 1）：pathSummary 按 record 的 callId 绑定（pendingPathSummary 侧信道 callId 匹配才展示，
// 不串到其它卡片）
const pathSummary = computed(() => {
  if (props.readonly) return undefined
  const p = toolStore.pendingPathSummary
  return p && p.callId === (props.record.desktopCallId ?? props.record.id) ? p.pathSummary : undefined
})

const captureAttachmentId = computed(() =>
  isCapture.value && props.record.status === 'completed' && (props.record.attachmentCount ?? 0) > 0
    ? props.record.desktopCallId
    : undefined
)

// —— 复制结果：现有安全剪贴板封装（navigator.clipboard 优先 + execCommand 兜底，Web API 不经 IPC）——
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
// 2026-09-16 审计 P2：卸载标记——与 CyMessageBubble/CyCodeBlock 同形：定时器建在 await 之后，
// 卸载发生在 await 期间时定时器无人清理。
let unmounted = false
async function copyResult(): Promise<void> {
  const text = props.record.outputSummary
  if (!text) return
  const ok = await copyText(text)
  if (ok && !unmounted) {
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1600)
  }
}
onBeforeUnmount(() => { unmounted = true; if (copiedTimer) clearTimeout(copiedTimer) })
</script>

<template>
  <div class="cy-tool-card" :data-status="record.status" :data-runtime="record.runtime">
    <!-- 标题区 = 折叠切换（native button：Enter/Space 原生激活；操作按钮在标题区外，无嵌套） -->
    <button type="button" class="cy-tool-toggle" data-testid="tool-toggle" :aria-expanded="expanded"
            :aria-controls="detailsId" @click="toggle">
      <svg class="cy-tool-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <span class="cy-tool-name" :title="record.toolName">{{ displayToolName }}</span>
      <span class="cy-tool-runtime" :class="isBackend ? 'is-backend' : 'is-desktop'">{{ runtimeText }}</span>
      <span class="cy-tool-spacer" />
      <span class="cy-tool-status" :class="`is-${statusTone}`" data-testid="tool-status">
        <i class="cy-tool-dot" aria-hidden="true" />{{ statusText }}<template v-if="durationText"> · {{ durationText }}</template>
      </span>
      <svg class="cy-tool-chevron" :class="{ 'is-open': expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <p v-if="pathSummary" class="cy-tool-path" data-testid="tool-path">{{ pathSummary }}</p>
    <!-- 折叠摘要：单行省略；展开后由详情分区取代，不重复占高；effectiveTruncated 且摘要未含「内容已截断」时补橙色弱标签（不重复） -->
    <p v-if="!expanded" class="cy-tool-brief" data-testid="tool-brief">
      <span class="cy-tool-brief-text">{{ briefText }}</span>
      <span v-if="showBriefTruncated" class="cy-tool-brief-tag" data-testid="tool-brief-tag">已截断</span>
    </p>

    <!-- 详情区：限高内部滚动（.cy-tool-pre），长结果不撑长聊天页；合法 JSON 缩进 + 等宽展示 -->
    <div v-if="expanded" :id="detailsId" class="cy-tool-details" data-testid="tool-details">
      <section v-if="record.inputSummary" class="cy-tool-section">
        <div class="cy-tool-section-head"><span>调用参数</span></div>
        <div class="cy-tool-pre" :class="{ 'is-json': inputIsJson }" data-testid="tool-input">{{ inputDetail }}</div>
      </section>
      <section v-if="record.outputSummary" class="cy-tool-section">
        <div class="cy-tool-section-head">
          <span>执行结果</span>
          <button type="button" class="cy-tool-copy" data-testid="tool-copy" @click="copyResult">{{ copied ? '已复制' : '复制结果' }}</button>
        </div>
        <div class="cy-tool-pre" :class="{ 'is-json': outputIsJson }" data-testid="tool-output">{{ outputDetail }}</div>
        <p v-if="truncated" class="cy-tool-truncated" data-testid="tool-truncated">结果已截断</p>
      </section>
      <!-- 错误区仅真实失败/超时渲染（取消/拒绝非执行错误；数据保留在 record 供诊断）；浅红底 + 左红强调线收敛视觉 -->
      <div v-if="showError" class="cy-tool-error" data-testid="tool-error">
        <span class="cy-tool-error-msg">{{ errorText }}</span>
        <p v-if="errorCode" class="cy-tool-error-code" data-testid="tool-error-code">{{ errorCode }}</p>
      </div>
      <p v-if="record.attachmentCount" class="cy-tool-attachments">含 {{ record.attachmentCount }} 个附件</p>
      <!-- 工具标识：弱化展示原始 toolName（runtime 判定/诊断依据；友好名之外保留真实调用 ID） -->
      <p class="cy-tool-ident" data-testid="tool-ident">工具标识 {{ record.toolName }}</p>
      <p v-if="record.startedAt" class="cy-tool-time">{{ record.startedAt.slice(0, 19).replace('T', ' ') }}<template v-if="record.finishedAt"> → {{ record.finishedAt.slice(0, 19).replace('T', ' ') }}</template></p>
    </div>

    <!-- 以下区域不受折叠影响：授权/取消操作（H13 awaiting 态取消与授权并存）、capture 面板、只读 diff、归档截图 -->
    <div v-if="!isBackend" class="cy-tool-actions">
      <template v-if="awaiting">
        <button type="button" class="cy-btn cy-btn-approve" data-testid="tool-approve" @click="emit('openApproval')">允许此电脑操作</button>
        <button type="button" class="cy-btn" data-testid="tool-deny" @click="toolStore.decide(record.desktopCallId ?? record.id, 'deny')">拒绝</button>
      </template>
      <button v-if="!['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(record.status)" type="button"
              class="cy-btn cy-btn-cancel" data-testid="tool-cancel" @click="emit('cancel')">取消任务</button>   <!-- H13：独立 v-if（与 awaiting 并存，非 v-else-if）——awaiting 态也有取消入口（Task 8 集成依赖） -->
    </div>
    <div v-if="isCapture && toolStore.captureState && !props.readonly" class="cy-tool-capture" data-testid="tool-capture-panel">
      <div v-if="toolStore.captureState.sources && !toolStore.captureState.preview" class="cy-capture-sources">
        <button v-for="s in toolStore.captureState.sources" :key="s.sourceId" type="button" class="cy-capture-source"
                data-testid="capture-source" @click="emit('pick', s.sourceId)">
          <img :src="s.thumbnailDataUrl" alt="" /><span>{{ s.sourceName }}</span>
        </button>
      </div>
      <div v-else-if="toolStore.captureState.preview" class="cy-capture-preview">
        <!-- doc 03 §10 / PRD §12.3：预览必须说明**截取的是哪个屏幕或窗口**，且上传前再次明确提醒 -->
        <p class="cy-capture-preview-source" data-testid="capture-preview-source">
          所选来源：<strong>{{ toolStore.captureState.preview.sourceName }}</strong>
          <span v-if="previewMeta" class="cy-capture-preview-meta" data-testid="capture-preview-meta">{{ previewMeta }}</span>
        </p>
        <img :src="toolStore.captureState.preview.previewDataUrl" alt="截图预览" />
        <p class="cy-capture-preview-warning" data-testid="capture-preview-warning" role="note">
          确认后将上传到已连接的后端，用于当前任务；截图可能包含屏幕上的其它窗口内容。取消则丢弃，不会上传。
        </p>
        <button type="button" class="cy-btn cy-btn-approve" data-testid="capture-confirm" @click="emit('confirmUpload')">确认上传</button>
        <button type="button" class="cy-btn" @click="toolStore.cancel(record.desktopCallId ?? record.id)">取消</button>
      </div>
    </div>
    <!-- 批次 C（F-4）：grant 命中自动执行路径的完成记录携带 diff（F-7 契约 ToolCallRecord.diff，终态不清）→
         只读 Diff 信息条（无确认按钮——approval-diff 仅权限窗）；不进折叠区，集成契约恒可探测 -->
    <div v-if="record.diff && !isBackend" class="cy-tool-diff-readonly" data-testid="tool-diff-readonly">
      <span class="cy-tool-diff-note">{{ record.diff.formatNote }}</span>
      <pre class="cy-diff-body" data-testid="tool-diff-body"><template v-for="(l, i) in record.diff.lines" :key="i"><span :class="`cy-diff-${l.kind}`">{{ l.text }}</span></template></pre>
    </div>
    <CyImageAttachment v-if="captureAttachmentId" class="cy-tool-capture-archive" :attachment-id="captureAttachmentId"
                       route-type="tool-capture" name="截图结果" data-testid="tool-capture-archive" />
  </div>
</template>

<style scoped>
/* 紧凑执行回执卡：浅灰蓝底（surface-soft）+ 细描边 + 12px 圆角，无大阴影——明显轻于助手白气泡。
   宽度：响应式基准（QQ 文件卡口径）——宽窗 560px 首选、窄窗 100%，成功/失败/取消/折叠/展开一致，
   不随 outputSummary 内容长度伸缩；min() 保证不超消息列、不产生横向滚动 */
.cy-tool-card {
  width: min(560px, 100%);
  min-width: 0;
  margin: var(--cy-space-2) 0;
  padding: var(--cy-space-2-5) var(--cy-space-4) var(--cy-space-3-5);
  background: var(--cy-surface-soft);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
  font-size: var(--cy-font-md);
}

/* 标题区（折叠切换）：图标 + 友好名 + 运行位置 + 状态·耗时 + 箭头；窄窗下名称优先（ellipsis），次要信息可换行 */
.cy-tool-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cy-space-3-5);
  width: 100%;
  min-width: 0;
  padding: var(--cy-space-1-5) var(--cy-space-2-5);
  border-radius: var(--cy-radius-4);
  text-align: left;
}

.cy-tool-toggle:hover {
  background: var(--cy-surface-hover);
}

.cy-tool-icon {
  flex: none;
  color: var(--cy-muted);
}

.cy-tool-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--cy-text);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-tool-runtime {
  flex: none;
  padding: var(--cy-space-0-5) var(--cy-space-3);
  border-radius: 4px;
  font-size: var(--cy-font-xs);
}

.cy-tool-runtime.is-backend {
  color: var(--cy-muted);
  background: var(--cy-surface-hover);
}

.cy-tool-runtime.is-desktop {
  color: var(--cy-accent-strong);
  background: var(--cy-accent-tint);
}

.cy-tool-spacer {
  flex: 1 1 0;
}

.cy-tool-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--cy-space-2);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  white-space: nowrap;
}

.cy-tool-status.is-running { color: var(--cy-accent-strong); }
.cy-tool-status.is-success { color: var(--cy-success); }
.cy-tool-status.is-warning { color: var(--cy-warning); }
.cy-tool-status.is-danger { color: var(--cy-danger); }

.cy-tool-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--cy-radius-circle);
  background: currentColor;
}

.cy-tool-status.is-running .cy-tool-dot {
  animation: cy-tool-pulse 1.2s ease-in-out infinite;
}

@keyframes cy-tool-pulse {
  50% { opacity: 0.35; }
}

.cy-tool-chevron {
  flex: none;
  color: var(--cy-muted);
  transition: transform var(--cy-motion-fast) ease;
}

.cy-tool-chevron.is-open {
  transform: rotate(180deg);
}

.cy-tool-path {
  margin: var(--cy-space-2) var(--cy-space-1) 0;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  overflow-wrap: anywhere;
}

/* 折叠摘要：单行省略——长结果不撑高聊天列表；截断弱标签固定右侧不被省略号吃掉 */
.cy-tool-brief {
  display: flex;
  align-items: center;
  gap: var(--cy-space-3);
  min-width: 0;
  margin: var(--cy-space-1-5) var(--cy-space-1) 0;
}

.cy-tool-brief-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cy-tool-brief-tag {
  flex: none;
  color: var(--cy-warning);
  font-size: var(--cy-font-xs);
}

.cy-tool-details {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-3-5);
  margin-top: var(--cy-space-2-5);
}

.cy-tool-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cy-space-4);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}

/* 详情正文：换行 + 任意长单词断行；限高 200px 区域内滚动（不无限拉长聊天页）；详情文本允许选择复制 */
.cy-tool-pre {
  max-height: 200px;
  margin: var(--cy-space-1) 0 0;
  padding: var(--cy-space-3) var(--cy-space-4);
  overflow-y: auto;
  color: var(--cy-text);
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4);
  font-size: var(--cy-font-sm);
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
}

.cy-tool-pre.is-json {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace;
}

.cy-tool-copy {
  flex: none;
  padding: var(--cy-space-0-5) var(--cy-space-4);
  color: var(--cy-muted);
  cursor: pointer;
  background: var(--cy-surface);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-pill);
  font-size: var(--cy-font-xs);
}

.cy-tool-copy:hover {
  color: var(--cy-accent-text);
  background: var(--cy-surface-hover);
}

.cy-tool-truncated {
  margin: var(--cy-space-1) 0 0;
  color: var(--cy-muted);
  font-size: var(--cy-font-xs);
  opacity: 0.8;
}

/* 错误区收敛：浅红底 + 左侧红强调线（不再用醒目红色虚线嵌套框）；技术错误码弱化置底 */
.cy-tool-error {
  padding: var(--cy-space-3) var(--cy-space-4) var(--cy-space-3) var(--cy-space-5);
  color: var(--cy-danger);
  background: color-mix(in srgb, var(--cy-danger) 9%, transparent);
  border-left: 3px solid var(--cy-danger);
  border-radius: var(--cy-radius-3);
  font-size: var(--cy-font-sm);
}

.cy-tool-error-msg {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
}

.cy-tool-error-code {
  margin: var(--cy-space-1-5) 0 0;
  color: inherit;
  font-size: var(--cy-font-xs);
  opacity: 0.7;
  overflow-wrap: anywhere;
}

.cy-tool-attachments {
  margin: 0 var(--cy-space-1);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
  overflow-wrap: anywhere;
}

/* 工具标识：原始 toolName 弱化小字（runtime 判定/诊断依据） */
.cy-tool-ident {
  margin: 0 var(--cy-space-1);
  color: var(--cy-muted);
  font-size: var(--cy-font-xs);
  opacity: 0.75;
  overflow-wrap: anywhere;
  user-select: text;
}

.cy-tool-time {
  margin: 0 var(--cy-space-1);
  color: var(--cy-muted);
  font-size: var(--cy-font-xs);
  opacity: 0.8;
  overflow-wrap: anywhere;
}

.cy-tool-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cy-space-4);
  margin-top: var(--cy-space-3);
}

.cy-btn {
  padding: var(--cy-space-1-5) var(--cy-space-5);
  cursor: pointer;
  background: var(--cy-bg);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-3);
  font-size: var(--cy-font-md);
}

.cy-btn-approve {
  color: var(--cy-accent-strong);
  border-color: var(--cy-accent-strong);
}

.cy-tool-capture {
  max-height: 45vh;
  margin-top: var(--cy-space-3);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.cy-capture-sources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cy-space-4);
}

.cy-capture-source {
  padding: var(--cy-space-2);
  cursor: pointer;
  background: var(--cy-bg);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-3);
}

.cy-capture-source img {
  display: block;
  width: 120px;
  height: 90px;
  object-fit: cover;
}

.cy-capture-preview {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-3);
}

/* doc 03 §10：预览内的"所选来源"与"上传前提醒"——用可读正文色，不做成灰字弱化（这是隐私告知） */
.cy-capture-preview-source {
  margin: 0;
  color: var(--cy-text);
  font-size: var(--cy-font-md);
}

.cy-capture-preview-meta {
  margin-left: var(--cy-space-3);
  color: var(--cy-muted);
}

.cy-capture-preview-warning {
  margin: 0;
  padding: var(--cy-space-3) var(--cy-space-4);
  border-left: 3px solid var(--cy-warning);
  border-radius: var(--cy-radius-3);
  background: var(--cy-surface-soft);
  color: var(--cy-text);
  font-size: var(--cy-font-sm);
}

.cy-capture-preview img {
  align-self: flex-start;
  max-width: 100%;
  max-height: 30vh;
  border-radius: var(--cy-radius-3);
  object-fit: contain;
}

.cy-tool-diff-readonly {
  margin-top: var(--cy-space-3);
}

.cy-tool-diff-note {
  color: var(--cy-text-muted);
  font-size: var(--cy-font-sm);
}

.cy-diff-body {
  max-height: 160px;
  margin: var(--cy-space-1) 0 0;
  padding: var(--cy-space-2);
  overflow: auto;
  background: var(--cy-bg);
  border-radius: var(--cy-radius-3);
  font-size: var(--cy-font-sm);
  white-space: pre-wrap;
}

.cy-diff-added { color: var(--cy-diff-add); }
.cy-diff-removed { color: var(--cy-diff-del); }
</style>
