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
import CyIdentityPane from './characters/CyIdentityPane.vue'
import CyCharacterPane from './characters/CyCharacterPane.vue'
import { useVoiceStore } from '../stores/voice.store'
import { useIdentityStore } from '../stores/identity.store'
import { useCharacterEditorStore } from '../stores/character-editor.store'
import { useAppStore } from '../stores/app.store'

const voiceStore = useVoiceStore()
const identityStore = useIdentityStore()
const characterEditorStore = useCharacterEditorStore()
const appStore = useAppStore()

const emit = defineEmits<{ close: [] }>()

// voiceStore.notice 瞬时提示（D-P20 转写回退全局 STT 等）——同 layout.notice 机制，3s 自动清除
let voiceNoticeTimer: ReturnType<typeof setTimeout> | undefined
watch(() => voiceStore.notice, (n) => {
  if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer)
  if (n) voiceNoticeTimer = setTimeout(() => voiceStore.clearNotice(), 3000)
})
onBeforeUnmount(() => { if (voiceNoticeTimer) clearTimeout(voiceNoticeTimer) })

// 问题 9：nav note（阶段4 P4-A 等）是开发期占位标签泄漏，子页全实现后未清理——删除 note 列；
// 面包屑去「· 阶段 N」。placeholder 仅占位兜底（五项都已实现，实际不触发）。
const NAV_ITEMS = [
  { key: 'model', label: '模型服务', placeholder: '' },
  { key: 'identity', label: '我的档案', placeholder: '' },
  { key: 'characters', label: '角色', placeholder: '' },
  { key: 'voice', label: '语音', placeholder: '普通录音/实时语音会话/输入法转写/TTS 自动朗读' },
  { key: 'appearance', label: '外观与 Live2D', placeholder: '' },
  { key: 'security', label: '安全与权限', placeholder: '安全策略/权限审批/已授权命令' },
  { key: 'diagnostics', label: '开发与诊断', placeholder: '开发者模式/日志' }
] as const

type NavKey = (typeof NAV_ITEMS)[number]['key']

const activeNav = ref<NavKey>(appStore.settingsSection)

const overlay = ref<HTMLElement>()
const closeBtn = ref<HTMLElement>()
let triggerElement: Element | null = null   // 打开前的活动元素（关闭后回焦点，仿 historyViewer）

const currentNavItem = computed(() => NAV_ITEMS.find((n) => n.key === activeNav.value) ?? NAV_ITEMS[0])
const currentNavLabel = computed(() => currentNavItem.value.label)
const currentNavPlaceholder = computed(() => currentNavItem.value.placeholder)

onMounted(() => {
  triggerElement = document.activeElement
  void nextTick(() => closeBtn.value?.focus())
})

function close(): void {
  if (!canLeaveActivePane()) return
  emit('close')
  if (triggerElement instanceof HTMLElement) triggerElement.focus()
}

function selectNav(next: NavKey): void {
  if (next === activeNav.value) return
  if (!canLeaveActivePane()) return
  activeNav.value = next
}

function canLeaveActivePane(): boolean {
  if (activeNav.value === 'identity' && identityStore.dirty) {
    return window.confirm('“我的档案”还有未保存修改。确定要离开并保留当前输入吗？')
  }
  if (activeNav.value === 'characters' && characterEditorStore.dirty) {
    const leave = window.confirm('“角色”还有未保存修改。确定离开并保留本地恢复草稿吗？')
    if (leave) void characterEditorStore.flushDraft()
    return leave
  }
  return true
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
          <span class="cy-muted">{{ currentNavLabel }}</span>
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
            @click="selectNav(item.key)"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.key === 'identity' && identityStore.profile && !identityStore.initialized" class="cy-nav-mark" aria-label="未完成初始化">未完成</span>
          </button>
        </nav>

        <div class="cy-settings-body">
          <CyModelServicesPane v-if="activeNav === 'model'" />
          <CyIdentityPane v-else-if="activeNav === 'identity'" />
          <CyCharacterPane v-else-if="activeNav === 'characters'" :initial-character-id="appStore.settingsCharacterId" />
          <CyVoicePane v-else-if="activeNav === 'voice'" />
          <CyLive2DPane v-else-if="activeNav === 'appearance'" />
          <CySecurityPane v-else-if="activeNav === 'security'" />
          <CyDiagnosticsPane v-else-if="activeNav === 'diagnostics'" />
          <div v-else class="cy-settings-placeholder" role="status">
            <strong>{{ currentNavLabel }}功能页</strong>
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
  inset: 0;   /* UII-QQ：应用内标题栏移除——全窗 overlay，全宽覆盖导航栏 */
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
.cy-nav-mark { padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--cy-warning) 50%, transparent); border-radius: 999px; color: var(--cy-warning); font-size: 9px; }
.cy-settings-nav-item.active .cy-nav-mark { color: currentColor; border-color: currentColor; }
.cy-settings-body {
  flex: 1 1 0;
  min-width: 0;
  overflow-y: auto;   /* 内容区内部滚动，面板不溢出窗口 */
  padding: 16px 18px;
  /* 问题 7（字型级重渲染）：hover 重绘时字形在合成层边界/亚像素相位间重光栅化产生 ~1px 上移。
     内容包装层提升为稳定合成层，消除 hover 重绘引起的相位翻转（transform/opacity only，§10 合规；缓解非根除）。 */
  transform: translateZ(0);
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
@media (max-width: 680px) {
  .cy-settings { width: min(96vw, 920px); height: min(92vh, 640px); }
  .cy-settings-nav { flex-basis: 150px; }
  .cy-settings-body { padding: 13px; }
}
</style>
