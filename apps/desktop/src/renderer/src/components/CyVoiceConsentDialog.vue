<script setup lang="ts">
// CyVoiceConsentDialog:后端 STT 首次操作确认对话框（D-P16，spec §5.12/§6）——
// 「音频将发送至后端识别（本机不保留）」+ [取消]→dismissConsent + [同意]→confirmConsent（持久化 consentBackendStt「不再提示」+ 重发挂起动作）。
// 自含 v-if=consentPending；由 CyChatInput（语音入口）与 CySettingsView（测试麦克风）双宿主（两视图互斥，不双渲染）。
//
// M-21（2026-09-11 全量评审）：本窗 `role="dialog" aria-modal="true"` + `position:fixed; inset:0`，此前零焦点管理——
// 打开后焦点留在覆盖层**之后**的麦克风按钮上（Enter 会重新触发语音动作而不是回答提示）、Tab 走查被遮挡控件、
// Escape 无效、读屏器不知对话框已出现。现按仓库既有 4 个正确先例（CyToolApproval / CySettingsView /
// CyHistoryViewer / CyProfileWizard）补：初始焦点 → Tab 陷阱 → 回焦触发元素。
//
// 挂载形状与 CyToolApproval **不同**：本组件自含 `v-if="consentPending"`，但组件实例在宿主内**常驻**，
// 只有 overlay 子树随 pending 建立/销毁（CyToolApproval 是 props.open 门 + 常驻 overlay）。
// 因此焦点时机不能只靠 onMounted（若未来宿主改成常驻则漏触发），需 onMounted（初值即 true）
// + watch(consentPending)（后续置位）双门——见 focusCancel()。
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()
const overlay = ref<HTMLElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
/** 打开前的活动元素（关闭后回焦，仿 CyToolApproval.trigger / CySettingsView.triggerElement） */
let triggerElement: Element | null = null

/** 初始焦点落在「取消」——与 CyToolApproval（初始焦点在「拒绝」）同款安全默认：
 *  用户按下语音入口后立刻按 Enter 回答的是「拒绝」（中止本次语音动作、不上传音频），
 *  而不是在尚未阅读提示时就把 consentBackendStt 持久化。 */
function focusCancel(): void {
  // P1-11：nextTick 返回 promise，回调式会悬空——`void` 显式表达"有意不等待"（聚焦尽力而为）
  void nextTick(() => cancelBtn.value?.focus())
}

/** 回焦触发元素。触发元素可能已卸载（设置页切换视图等）→ isConnected 门，避免把焦点丢给脱离文档的节点 */
function returnToTrigger(): void {
  const t = triggerElement
  triggerElement = null
  if (t instanceof HTMLElement && t.isConnected) t.focus()
}

onMounted(() => {
  triggerElement = document.activeElement
  focusCancel()
})
// 常驻挂载兜底：pending 后续置位（宿主不再依赖 overlay 的 v-if 也能聚焦）
watch(() => voiceStore.consentPending, (pending) => {
  if (pending) { triggerElement = document.activeElement; focusCancel() }
})
// 持引用的是"打开前那个元素"——组件卸载即弃，避免长期挂着一个可能已被替换的 DOM 节点
onBeforeUnmount(() => { triggerElement = null })

function onCancel(): void {
  voiceStore.dismissConsent()
  returnToTrigger()
}
async function onConfirm(): Promise<void> {
  try {
    await voiceStore.confirmConsent()
  } finally {
    returnToTrigger()   // finally：confirm 失败也回焦，不把焦点留在已卸载的对话框里
  }
}

/** Tab/Shift+Tab 在对话框内循环（CyToolApproval.trapTab / CySettingsView.onKeydown 同款查询） */
function trapTab(e: KeyboardEvent): void {
  if (!overlay.value) return
  const focusables = overlay.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (focusables.length === 0) { e.preventDefault(); return }
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

/**
 * 键盘处理（挂在 overlay 上，仿 CySettingsView；浅层树内 `onKeydown` 不会被子组件 `stopPropagation` 屏蔽）。
 *
 * 关于 Escape 的产品语义决策——本窗**不是**「不可关闭的同意闸门」，Escape 走与 [取消] 完全相同的路径：
 * 依据是既有落文口径「拒绝则中止」（docs/07 §「后端 STT 一次性同意」，doc 02 §13.3 同），
 * 而实现里 [取消] 就是这个「拒绝」：`dismissConsent()` 只清 pending、**不置位** `consentBackendStt`
 * （voice.store.ts:298-302），挂起动作不执行、音频不离开设备，下次语音操作仍会重新弹窗。
 * 即 Escape 既不可能让用户「绕过同意」（没有同意就没有上传），也不改变任何持久化状态——
 * 它只是拒绝，且拒绝是产品明文允许的答复之一。真正被禁止的是「未答复就继续」。
 *
 * 反向约束（不得引入的新逃逸）：`confirmDispatching` 为 true（用户已同意、挂起动作在途）时，
 * Escape 与 [取消] 一并关闭——那次录音已经开出去了，此时"取消"不再等价于拒绝，而会把
 * confirm 已派发的动作留在无 UI 可解释的中间态（pendingAction 早已置 null，dismiss 也收不回来）。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!voiceStore.consentPending) return
  if (e.key === 'Escape') {
    e.preventDefault()
    // 显式停冒泡：本窗可由设置中心（CySettingsView 的 overlay 同样监听 Escape）作宿主，
    // 若让 Escape 继续冒泡，一次 Escape 会连带关掉**整个设置页**，而用户只是在回答本提示。
    e.stopPropagation()
    if (voiceStore.confirmDispatching) return
    onCancel()
    return
  }
  if (e.key === 'Tab') {
    e.stopPropagation()   // 同上：不和宿主的焦点陷阱抢同一次 Tab
    trapTab(e)
  }
}
</script>

<template>
  <div
    v-if="voiceStore.consentPending"
    ref="overlay"
    class="cy-consent-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="后端语音识别确认"
    @keydown="onKeydown"
  >
    <div class="cy-consent-box">
      <strong>语音将发送至后端识别</strong>
      <p>音频将发送至后端识别（本机不保留）。同意后不再提示。</p>
      <div class="cy-consent-actions">
        <button ref="cancelBtn" class="cy-consent-btn" data-testid="consent-cancel" :disabled="voiceStore.confirmDispatching" @click="onCancel">取消</button>
        <button class="cy-consent-btn cy-consent-confirm" data-testid="consent-confirm" :disabled="voiceStore.confirmDispatching" @click="onConfirm">同意</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-consent-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--cy-overlay);
}

.cy-consent-box {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-6);
  width: min(360px, 84vw);
  padding: var(--cy-space-9) 20px;
  border-radius: var(--cy-radius-7);
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  box-shadow: var(--cy-shadow);
}

.cy-consent-box strong {
  font-size: var(--cy-font-xl);
}

.cy-consent-box p {
  margin: 0;
  color: var(--cy-muted);
  font-size: var(--cy-font-lg);
  line-height: 1.5;
}

.cy-consent-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--cy-space-4);
  margin-top: var(--cy-space-2);
}

.cy-consent-btn {
  padding: var(--cy-space-3) var(--cy-space-8);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-4-5);
  background: var(--cy-surface);
  color: var(--cy-text);
  font-size: var(--cy-font-lg);
}

.cy-consent-btn:hover {
  background: var(--cy-surface-hover);
}

.cy-consent-confirm {
  border-color: var(--cy-accent);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
}

/* M-21 补：本窗此前复用全局 `button:focus-visible` 规则（CySettingsView 作用域内）覆盖不到，
    聊天页宿主下键盘焦点无视觉指示——补局部焦点环（token 与全局规则一致）。 */
.cy-consent-btn:focus-visible {
  outline: 2px solid var(--cy-accent-strong);
  outline-offset: 2px;
}
</style>
