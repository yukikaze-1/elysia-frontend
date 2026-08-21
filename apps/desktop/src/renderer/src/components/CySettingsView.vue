<script setup lang="ts">
// CySettingsView:全窗覆盖式设置中心（阶段 4 批次 A，spec §5.4 + doc 11 §1 导航分组）。
// 布局纪律同 CyHistoryViewer——fixed 定位于标题栏下方、面板定高、左右区域内部滚动、不溢出窗口视口。
// 模态无障碍:role=dialog + aria-modal、初始焦点关闭按钮、Tab 焦点陷阱、Esc 关闭 + 回焦触发按钮。
// 本批仅「模型服务」子页实现，其余分组占位（阶段 4 P4-B / 阶段 5 / 阶段 6）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CyModelServicesPane from './CyModelServicesPane.vue'
import CyVoicePane from './CyVoicePane.vue'
import CyLive2DPane from './CyLive2DPane.vue'
import CySecurityPane from './CySecurityPane.vue'
import CyDiagnosticsPane from './CyDiagnosticsPane.vue'
import CyVoiceConsentDialog from './CyVoiceConsentDialog.vue'
import { useVoiceStore } from '../stores/voice.store'

const voiceStore = useVoiceStore()

const emit = defineEmits<{ close: [] }>()

// voiceStore.notice 瞬时提示（D-P20 转写回退全局 STT 等）——同 layout.notice 机制，3s 自动清除
let voiceNoticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => voiceStore.notice, (n) => {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer)
  if (n) voiceNoticeTimer = setTimeout(() => voiceStore.clearNotice(), 3000)
})
onBeforeUnmount(() => { if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer) })

const NAV_ITEMS = [
  { key: 'model', label: '模型服务', note: '阶段4 P4-A', placeholder: '' },
  { key: 'voice', label: '语音', note: '阶段4 P4-B', placeholder: '普通录音/实时语音会话/输入法转写/TTS 自动朗读' },
  { key: 'security', label: '安全与权限', note: '阶段6', placeholder: '安全策略/权限审批/已授权命令' },
  { key: 'character', label: '角色与外观', note: '阶段5', placeholder: 'Live2D 角色与外观' },
  { key: 'diagnostics', label: '开发与诊断', note: '阶段7', placeholder: '开发者模式/日志' }
] as const

type NavKey = (typeof NAV_ITEMS)[number]['key']

const activeNav = ref<NavKey>('model')

const overlay = ref<HTMLElement>()
const closeBtn = ref<HTMLElement>()
let triggerElement: Element | null = null   // 打开前的活动元素（关闭后回焦点，仿 historyViewer）

const currentNavItem = computed(() => NAV_ITEMS.find((n) => n.key === activeNav.value) ?? NAV_ITEMS[0])
const currentNavLabel = computed(() => currentNavItem.value.label)
const currentNavNote = computed(() => currentNavItem.value.note)
const currentNavPlaceholder = computed(() => currentNavItem.value.placeholder)

onMounted(() => {
  triggerElement = document.activeElement
  void nextTick(() => closeBtn.value?.focus())
})

function close(): void {
  emit('close')
  if (triggerElement instanceof HTMLElement) triggerElement.focus()
}

/** Tab 焦点陷阱:循环回拦在可聚焦元素内；Esc 关闭（子组件 keydown 会 stopPropagation，互不冲突） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); close(); return }
  if (e.key !== 'Tab' || !overlay.value) return
  const focusables = overlay.value.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

onBeforeUnmount(() => { triggerElement = null })
</script>

<template>
  <div ref="overlay" class="cy-settings-overlay" role="dialog" aria-modal="true" aria-label="设置" @keydown="onKeydown">
    <div class="cy-settings">
      <header class="cy-settings-header">
        <div class="cy-settings-title">
          <strong>设置</strong>
          <span class="cy-muted">模型服务 · 阶段 4</span>
        </div>
        <button ref="closeBtn" class="cy-close-btn" aria-label="关闭设置" @click="close">✕</button>
      </header>

      <div class="cy-settings-layout">
        <nav class="cy-settings-nav" aria-label="设置分组">
          <button
            v-for="item in NAV_ITEMS"
            :key="item.key"
            class="cy-settings-nav-item"
            :class="{ active: activeNav === item.key }"
            :aria-pressed="activeNav === item.key"
            @click="activeNav = item.key"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.note" class="cy-settings-nav-note">{{ item.note }}</span>
          </button>
        </nav>

        <div class="cy-settings-body">
          <CyModelServicesPane v-if="activeNav === 'model'" />
          <CyVoicePane v-else-if="activeNav === 'voice'" />
          <CyLive2DPane v-else-if="activeNav === 'character'" />
          <CySecurityPane v-else-if="activeNav === 'security'" />
          <CyDiagnosticsPane v-else-if="activeNav === 'diagnostics'" />
          <div v-else class="cy-settings-placeholder" role="status">
            <strong>{{ currentNavLabel }}功能页</strong>
            <span>占位：{{ currentNavNote }} 落地</span>
            <span v-if="currentNavPlaceholder" class="cy-muted">{{ currentNavPlaceholder }}</span>
          </div>
        </div>
      </div>

      <!-- P4-B voiceStore 瞬时提示（D-P20 删除回退等），设置 overlay 内可读 -->
      <div v-if="voiceStore.notice" class="cy-settings-toast" role="status">{{ voiceStore.notice }}</div>
      <!-- P4-B consent（D-P16）：测试麦克风也走 backend-STT 确认 -->
      <CyVoiceConsentDialog />
    </div>
  </div>
</template>

<style scoped>
.cy-settings-overlay {
  position: fixed;
  inset: 36px 0 0 0;   /* 保留标题栏(36px,TITLEBAR_HEIGHT)；全宽覆盖导航栏——设置中心为全窗 overlay */
  z-index: 50;
  display: flex;           /* flex 居中面板，min(920px, 92vw) / min(640px, 84vh) 定高不溢出窗口 */
  align-items: center;
  justify-content: center;
  background: var(--cy-overlay);
  backdrop-filter: blur(2px);
}
.cy-settings {
  display: flex;
  flex-direction: column;
  width: min(920px, 92vw);
  height: min(640px, 84vh);
  min-height: 0;           /* 允许收缩：面板不被内容撑破高度（FE-S3-RUN2-P1-01 同款纪律） */
  border-radius: 14px;
  overflow: hidden;
  background: var(--cy-pane);
  border: 1px solid var(--cy-border);
  box-shadow: var(--cy-shadow);
}
.cy-settings-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--cy-border);
}
.cy-settings-title { display: flex; align-items: baseline; gap: 8px; }
.cy-settings-title strong { font-size: 15px; }
.cy-close-btn { padding: 4px 10px; border: 1px solid var(--cy-border); border-radius: 8px; background: var(--cy-surface); color: var(--cy-muted); }
.cy-settings-layout { flex: 1 1 0; display: flex; min-height: 0; }
.cy-settings-nav {
  flex: 0 0 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 8px;
  border-right: 1px solid var(--cy-border);
  background: var(--cy-surface-soft);
}
.cy-settings-nav-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  padding: 9px 11px;
  border-radius: 9px;
  color: var(--cy-muted);
  font-size: 13px;
  text-align: left;
}
.cy-settings-nav-item:hover { background: var(--cy-surface-hover); }
.cy-settings-nav-item.active { color: var(--cy-accent-text); background: var(--cy-accent); }
.cy-settings-nav-note { font-size: 10px; opacity: 0.75; }
.cy-settings-body {
  flex: 1 1 0;
  min-width: 0;
  overflow-y: auto;   /* 内容区内部滚动，面板不溢出窗口 */
  padding: 16px 18px;
}
.cy-settings-placeholder {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 40px 12px;
  color: var(--cy-text);
  text-align: center;
}
.cy-muted { color: var(--cy-muted); font-size: 12px; }
.cy-settings-toast {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 20;
  max-width: 70vw;
  padding: 8px 14px;
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: 12px;
  font-size: 12px;
  box-shadow: var(--cy-shadow);
}
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
