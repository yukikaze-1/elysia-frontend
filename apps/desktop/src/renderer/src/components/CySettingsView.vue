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
import { useSettingsStore } from '../stores/settings.store'
import { errorMessage } from '../utils/error-message'

const voiceStore = useVoiceStore()
const identityStore = useIdentityStore()
const characterEditorStore = useCharacterEditorStore()
const appStore = useAppStore()
const settingsStore = useSettingsStore()

/**
 * 设置保存状态（M-19，2026-09-13）。
 *
 * 修前的事实：`settings.store` 的 `saveError` / `saved` 是**死状态**——全仓没有任何组件渲染它们
 * （grep 只命中 store 自身），而 Live2D 子页却写着"500ms 自动保存"。于是"拨动开关 → 界面正常 →
 * 重启后被还原"这条链上用户拿不到任何信号。现挂在设置中心**头部下方**（不随子页切换消失），
 * 三态：保存失败（alert）> 正在保存 > 已保存；文案经 `errorMessage()` 单一来源。
 */
const saveErrorMessage = computed(() => errorMessage(settingsStore.saveError, '设置保存失败：改动没有写入磁盘。'))

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
  { key: 'model', label: '模型服务', icon: '<rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" />', placeholder: '' },
  { key: 'identity', label: '我的档案', icon: '<circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" />', placeholder: '' },
  { key: 'characters', label: '角色', icon: '<circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a2.5 2.5 0 0 1 0 5M16 14a4 4 0 0 1 4.5 4" />', placeholder: '' },
  { key: 'voice', label: '语音', icon: '<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />', placeholder: '普通录音/实时语音会话/输入法转写/TTS 自动朗读' },
  { key: 'appearance', label: '外观与 Live2D', icon: '<path d="M12 3 14 8l5 .5-3.8 3.3 1.2 5.2-4.4-2.7L7.6 17l1.2-5.2L5 8.5 10 8z" />', placeholder: '' },
  { key: 'security', label: '安全与权限', icon: '<path d="M12 3 19 6v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6z" /><path d="m9 12 2 2 4-4" />', placeholder: '安全策略/权限审批/已授权命令' },
  { key: 'diagnostics', label: '开发与诊断', icon: '<rect x="4" y="5" width="16" height="14" rx="2" /><path d="m8 10 2 2-2 2M12 14h4" />', placeholder: '开发者模式/日志' }
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

      <!-- M-19（2026-09-13）：设置保存状态。失败必须可见、且说明"改动没丢"——
           本仓库既有教训是"失败以什么都没有的形式到达用户"，这里刻意把三者放在同一处常驻显示。 -->
      <div v-if="settingsStore.saveError" class="cy-settings-save-state is-error" role="alert" data-testid="settings-save-error">
        <span class="cy-save-state-dot" aria-hidden="true" />
        <span>{{ saveErrorMessage }}</span>
        <span class="cy-save-state-hint">改动仍保留在待写队列，会自动重试一次；也可再改一次或关闭窗口时重试。</span>
      </div>
      <div v-else-if="settingsStore.unsaved" class="cy-settings-save-state" role="status" data-testid="settings-saving">
        <span class="cy-save-state-dot is-pending" aria-hidden="true" />
        <span>正在保存设置…</span>
      </div>
      <div v-else-if="settingsStore.saved" class="cy-settings-save-state is-ok" role="status" data-testid="settings-saved">
        <span class="cy-save-state-dot is-ok" aria-hidden="true" />
        <span>设置已保存</span>
      </div>

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
            <span class="cy-settings-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <g v-html="item.icon" />
              </svg>
            </span>
            <span class="cy-settings-nav-copy">{{ item.label }}</span>
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
  padding: clamp(var(--cy-space-4), 3vw, var(--cy-space-8));
  background-color: var(--cy-overlay);
  background-image: linear-gradient(var(--cy-overlay), var(--cy-overlay)), var(--cy-settings-background);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  backdrop-filter: blur(10px) saturate(115%);
}
.cy-settings {
  display: flex;
  flex-direction: column;
  width: min(1180px, calc(100vw - 48px));
  height: min(760px, 84vh);
  min-height: 0;           /* 允许收缩：面板不被内容撑破高度（FE-S3-RUN2-P1-01 同款纪律） */
  border-radius: var(--cy-radius-7);
  overflow: hidden;
  background: var(--cy-surface-strong);
  border: 1px solid var(--cy-border);
  box-shadow: var(--cy-shadow-panel);
}
.cy-settings-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cy-space-6);
  padding: var(--cy-space-6) var(--cy-space-8);
  border-bottom: 1px solid var(--cy-border);
  background: var(--cy-surface-glass);
}
.cy-settings-title { display: flex; align-items: baseline; gap: var(--cy-space-4); }

/* M-19：保存状态条常驻在头部下方（不随子页切换消失），失败时用警示色 + alert 角色 */
.cy-settings-save-state {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--cy-space-4);
  padding: var(--cy-space-3) var(--cy-space-8);
  border-bottom: 1px solid var(--cy-border);
  background: var(--cy-surface-soft);
  color: var(--cy-muted);
  font-size: var(--cy-font-sm);
}
.cy-settings-save-state.is-error { color: var(--cy-danger); background: var(--cy-surface); }
.cy-settings-save-state.is-ok { color: var(--cy-success); }
.cy-save-state-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: var(--cy-radius-circle); background: var(--cy-muted); }
.cy-save-state-dot.is-pending { background: var(--cy-warning); }
.cy-save-state-dot.is-ok { background: var(--cy-success); }
.cy-settings-save-state.is-error .cy-save-state-dot { background: var(--cy-danger); }
.cy-save-state-hint { color: var(--cy-muted); }
.cy-settings-title strong { font-size: calc(20px * var(--cy-user-font-scale)); }
.cy-close-btn { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--cy-border); border-radius: var(--cy-radius-4); background: var(--cy-surface); color: var(--cy-muted); font-size: calc(18px * var(--cy-user-font-scale)); }
.cy-settings-layout { flex: 1 1 0; display: flex; min-height: 0; }
.cy-settings-nav {
  flex: 0 0 216px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-2);
  padding: var(--cy-space-5) var(--cy-space-4);
  border-right: 1px solid var(--cy-border);
  background: color-mix(in srgb, var(--cy-surface-soft) 76%, transparent);
}
.cy-settings-nav-item {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: var(--cy-space-3);
  min-height: 44px;
  padding: var(--cy-space-4) var(--cy-space-5);
  border-radius: var(--cy-radius-4-5);
  border: 1px solid transparent;
  color: var(--cy-muted);
  font-size: var(--cy-font-lg);
  text-align: left;
}
.cy-settings-nav-item:hover { color: var(--cy-accent-strong); background: var(--cy-surface-hover); }
.cy-settings-nav-item.active { color: var(--cy-accent-text); background: var(--cy-accent-tint); border-color: color-mix(in srgb, var(--cy-accent-strong) 22%, transparent); }
.cy-settings-nav-icon { display: inline-grid; flex: 0 0 22px; place-items: center; color: currentColor; }
.cy-settings-nav-icon svg { width: 20px; height: 20px; }
.cy-settings-nav-copy { min-width: 0; }
.cy-nav-mark { margin-left: auto; padding: var(--cy-space-0-5) var(--cy-space-3); border: 1px solid color-mix(in srgb, var(--cy-warning) 50%, transparent); border-radius: var(--cy-radius-pill); color: var(--cy-warning); font-size: calc(9px * var(--cy-user-font-scale)); }
.cy-settings-nav-item.active .cy-nav-mark { color: currentColor; border-color: currentColor; }
.cy-settings-body {
  flex: 1 1 0;
  min-width: 0;
  overflow-y: auto;   /* 内容区内部滚动，面板不溢出窗口 */
  scrollbar-gutter: stable;   /* D4-UI（2026-09-15，整改清单 §3）：滚动条出现/消失不改变内容宽度 */
  padding: var(--cy-space-8) var(--cy-space-9);
  background: color-mix(in srgb, var(--cy-pane) 92%, transparent);
  /* 问题 7（字型级重渲染）：hover 重绘时字形在合成层边界/亚像素相位间重光栅化产生 ~1px 上移。
     内容包装层提升为稳定合成层，消除 hover 重绘引起的相位翻转（transform/opacity only，§10 合规；缓解非根除）。 */
  transform: translateZ(0);
}
.cy-settings-placeholder {
  display: flex;
  flex-direction: column;
  gap: var(--cy-space-3);
  padding: 40px var(--cy-space-6);
  color: var(--cy-text);
  text-align: center;
}
.cy-muted { color: var(--cy-muted); font-size: var(--cy-font-md); }
.cy-settings-toast {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 20;
  max-width: 70vw;
  padding: var(--cy-space-4) var(--cy-space-7);
  color: var(--cy-accent-text);
  background: var(--cy-accent);
  border: 1px solid var(--cy-border);
  border-radius: var(--cy-radius-6);
  font-size: var(--cy-font-md);
  box-shadow: var(--cy-shadow);
}
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--cy-accent-strong); outline-offset: 2px; }
</style>
