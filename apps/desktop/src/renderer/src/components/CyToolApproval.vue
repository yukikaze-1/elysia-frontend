<!-- src/renderer/src/components/CyToolApproval.vue -->
<!-- 阶段 6 批次 B（Task 7）：工具权限窗——四问（AI 想做什么/操作哪个资源/为什么需要/哪些数据发后端）
     + 写 Diff（pendingDiff 侧信道）+ 对等按钮（拒绝/允许一次）+ 焦点陷阱（Tab 面板内循环，CyHistoryViewer
     先例）。由卡片「允许此电脑操作」触发打开（props.open，非自动弹出——四问必答流，doc 03 §10）。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { GRANT_DEFAULT_TTL_MS, GRANT_TTL_OPTIONS_MS } from '@shared/contracts/tool'
import { useToolStore } from '../stores/tool.store'

const toolStore = useToolStore()
const denyBtn = ref<HTMLButtonElement | null>(null)
const box = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const current = computed(() => toolStore.liveOrder.map(id => toolStore.records[id]).find(r => r?.status === 'awaiting_permission'))
const props = defineProps<{ open: boolean }>()   // 卡片「允许此电脑操作」触发打开（非自动弹出——四问必答流，doc 03 §10）
const open = computed(() => props.open && !!current.value)
const emit = defineEmits<{ close: [] }>()
// 批次 C（D6C-05）：第三入口「允许指定目录」仅 read/write awaiting 显示
const isGrantable = computed(() => !!current.value && (current.value.toolName === 'desktop.file.read' || current.value.toolName === 'desktop.file.write'))
const openGrantPicker = ref(false)
const granting = ref(false)                    // L-8：grant 提交期间禁用（防抖）
const submitting = ref(false)                  // FINAL-LOW（L-8 收口）：allow/deny 提交期间禁用（防双击二次 decide）
const ttlMs = ref<number>(GRANT_DEFAULT_TTL_MS)  // F-18：TTL select 默认 24h
const grantError = ref('')
function ttlLabel(t: number): string {
  if (t === 3600_000) return '1 小时'
  if (t === 86_400_000) return '24 小时'
  if (t === 604_800_000) return '7 天'
  if (t === 2_592_000_000) return '30 天'
  return String(t)
}
function onTtlChange(e: Event): void {
  ttlMs.value = Number((e.target as HTMLSelectElement).value)
}
// 确认授权 → store.grantDirectory(callId, ttlMs) → executed=true 关闭（emit('close')）；executed=false（F-1 miss：grant 已建但
// 请求目标不在授权目录内）→ 窗内提示不关窗；失败保持 open + 错误提示
async function confirmGrant(): Promise<void> {
  if (!current.value) return
  granting.value = true
  grantError.value = ''
  try {
    const executed = await toolStore.grantDirectory(current.value.desktopCallId ?? current.value.id, ttlMs.value)
    if (!executed) {   // FINAL-LOW：F-1 miss 反馈——用户可见解释，非静默关窗
      grantError.value = '授权已创建，但当前请求目标不在授权目录内——请改用「允许一次」或选择包含目标的目录'
      return
    }
    openGrantPicker.value = false
    returnToTrigger()
    emit('close')
  } catch (e) {
    grantError.value = e instanceof Error ? e.message : '授权失败，请重试'
  } finally {
    granting.value = false
  }
}
onMounted(() => { document.addEventListener('keydown', onKeydown) })
onUnmounted(() => { document.removeEventListener('keydown', onKeydown) })
// M1（fix round 1）：组件在 CyLiveToolCards 内常驻挂载（:open 切换无 v-if）——onMounted 只执行一次且此时
// open 恒 false，初始焦点/触发元素记忆必须经 watch(open) 驱动（每次打开都记录 activeElement + 聚焦拒绝按钮）
watch(() => open.value, (v) => {
  if (v) {
    trigger.value = document.activeElement as HTMLElement
    // MED-1（Task 7 review）：跨请求状态复位——常驻挂载下 deny/allow/Esc 关闭不复位 openGrantPicker，
    // 下一请求（如 capture）重开面板会残留 grant 子面板/陈旧 TTL/错误文案
    openGrantPicker.value = false
    grantError.value = ''
    ttlMs.value = GRANT_DEFAULT_TTL_MS   // F-18：每次打开回默认 24h
    nextTick(() => denyBtn.value?.focus())
  }
})
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) { toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'deny'); returnToTrigger(); emit('close') }
  if (e.key === 'Tab' && open.value) { trapTab(e) }
}
/** 焦点陷阱：Tab/Shift+Tab 在面板内循环（CyHistoryViewer 先例） */
function trapTab(e: KeyboardEvent): void {
  if (!box.value) return
  const focusables = box.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (focusables.length === 0) { e.preventDefault(); return }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}
function returnToTrigger() { trigger.value?.focus?.(); toolStore.clearApprovalLocal?.() }
// FINAL-LOW（L-8 收口）：allow/deny 提交期禁用 + rejection 收敛——IPC 往返窗口内双击二次 decide → TOOL_STATE_INVALID 噪音消除
async function allow() {
  if (submitting.value) return
  submitting.value = true
  try { await toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'allow_once') }
  catch { /* 结构化错误已由 Main 上提；面板即将关闭（returnToTrigger）——无 unhandled rejection */ }
  submitting.value = false
  returnToTrigger(); emit('close')
}
async function deny() {
  if (submitting.value) return
  submitting.value = true
  try { await toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'deny') }
  catch { /* 同上 */ }
  submitting.value = false
  returnToTrigger(); emit('close')
}
</script>

<template>
  <div v-if="open" class="cy-approval-overlay" data-testid="tool-approval">
    <div ref="box" class="cy-approval-box" role="dialog" aria-modal="true" aria-label="工具权限确认">
      <h3>允许此电脑操作？</h3>
      <dl class="cy-approval-questions">
        <dt>AI 想做什么</dt><dd>{{ current!.toolName }} — {{ current!.inputSummary }}</dd>
        <dt>操作哪个资源</dt><dd>{{ toolStore.pendingPathSummary?.pathSummary ?? current!.inputSummary }}</dd>
        <dt>为什么需要</dt><dd>{{ current!.reason ?? 'AI 请求执行此桌面操作以完成你的任务。' }}</dd>
        <dt>哪些数据会发送到后端</dt><dd>{{ toolStore.pendingDataFlowNote?.dataFlowNote ?? '请查看工具说明。' }}</dd>
      </dl>
      <div v-if="toolStore.pendingDiff?.diff" class="cy-approval-diff" data-testid="approval-diff">
        <p class="cy-diff-note">{{ toolStore.pendingDiff.diff.isNewFile ? '新建文件' : '覆盖文件' }} · {{ toolStore.pendingDiff.diff.formatNote }}
          <template v-if="toolStore.pendingDiff.diff.truncated"> · 共 {{ toolStore.pendingDiff.diff.totalLines }} 行，仅显示前 100 行</template></p>
        <pre class="cy-diff-body"><template v-for="(l, i) in toolStore.pendingDiff.diff.lines" :key="i"><span :class="'cy-diff-' + l.kind">{{ l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' ' }}{{ l.text }}</span></template></pre>
      </div>
      <div class="cy-approval-actions">
        <button ref="denyBtn" type="button" class="cy-btn" data-testid="approval-deny" :disabled="submitting" @click="deny">拒绝</button>
        <button type="button" class="cy-btn cy-btn-approve" data-testid="approval-allow" :disabled="submitting" @click="allow">允许一次</button>
        <!-- 批次 C（D6C-05）：第三入口「允许指定目录」——仅 read/write awaiting 显示（L-8：提交期间禁用防抖） -->
        <button v-if="isGrantable" type="button" class="cy-btn cy-btn-grant" data-testid="approval-grant-dir"
          :disabled="granting" @click="openGrantPicker = true">允许指定目录</button>
      </div>
      <!-- 批次 C：grant 选择子面板（F-18：TTL 白名单 select，默认 24h；确认 → store.grantDirectory(callId, ttlMs)）
           MED-1 双门：isGrantable && openGrantPicker——非可授权工具（capture）即使状态残留也不显示授权 UI -->
      <div v-if="isGrantable && openGrantPicker" class="cy-approval-grant-box" data-testid="approval-grant-box">
        <label class="cy-approval-grant-label" for="grant-ttl">有效期</label>
        <select id="grant-ttl" data-testid="grant-ttl-select" :value="String(ttlMs)" @change="onTtlChange">
          <option v-for="t in GRANT_TTL_OPTIONS_MS" :key="t" :value="String(t)">{{ ttlLabel(t) }}</option>
        </select>
        <button type="button" class="cy-btn cy-btn-approve" data-testid="approval-grant-confirm" :disabled="granting" @click="confirmGrant">确认授权</button>
        <button type="button" class="cy-btn" data-testid="approval-grant-cancel" :disabled="granting" @click="openGrantPicker = false">取消</button>
        <p v-if="grantError" class="cy-approval-grant-error" role="alert">{{ grantError }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-approval-overlay { position: fixed; inset: 0; z-index: 80; background: var(--cy-overlay, rgba(0,0,0,.45)); display: flex; align-items: center; justify-content: center; }
.cy-approval-box { background: var(--cy-bg); border-radius: 10px; padding: 16px 18px; max-width: 520px; width: min(92vw, 520px); max-height: 84vh; overflow: auto; }
.cy-approval-questions { margin: 10px 0; }
.cy-approval-questions dt { font-weight: 600; margin-top: 6px; }
.cy-approval-questions dd { margin: 2px 0 0; color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-approval-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.cy-btn { padding: 6px 16px; border: 1px solid var(--cy-border); border-radius: 6px; background: var(--cy-bg); cursor: pointer; }
.cy-btn-approve { border-color: var(--cy-accent, #1a66ff); color: var(--cy-accent, #1a66ff); }
.cy-btn-grant { border-color: var(--cy-accent-weak, rgba(0,120,255,.45)); color: var(--cy-accent, #1a66ff); }
.cy-btn:disabled { opacity: .5; cursor: not-allowed; }
.cy-approval-grant-box { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--cy-border); }
.cy-approval-grant-label { color: var(--cy-text-muted); font-size: 12px; }
.cy-approval-grant-error { flex-basis: 100%; margin: 2px 0 0; color: var(--cy-danger, #d33); font-size: 12px; }
.cy-diff-note { color: var(--cy-text-muted); margin: 6px 0; }
.cy-diff-body { background: var(--cy-bg-sub); padding: 6px; border-radius: 6px; max-height: 240px; overflow: auto; margin: 0; font-size: 12px; white-space: pre-wrap; }
.cy-diff-added { color: var(--cy-diff-add, #18794e); }
.cy-diff-removed { color: var(--cy-diff-del, #cd2b3a); }
</style>
