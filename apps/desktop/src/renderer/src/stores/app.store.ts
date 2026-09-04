// src/renderer/src/stores/app.store.ts
// 阶段 4 批次 A：轻量应用视图状态（doc 06 §3.1「当前页面」落地）——
// currentView 驱动 NavRail active 上提 与 App.vue 视图切换（chat 四区 / tasks 占位 / settings 全窗 overlay）。
// 不持久化（doc 11 设置中心「当前页」不记忆）；仅 UI 视图路由，不承载业务状态。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export type AppView = 'chat' | 'tasks' | 'settings'
export type SettingsSection = 'model' | 'identity' | 'characters' | 'voice' | 'appearance' | 'security' | 'diagnostics'

export const useAppStore = defineStore('app', () => {
  const currentView = ref<AppView>('chat')
  const settingsSection = ref<SettingsSection>('model')
  const settingsCharacterId = ref<string>()

  function setView(v: AppView): void {
    currentView.value = v
  }

  function openSettings(section: SettingsSection = 'model', characterId?: string): void {
    settingsSection.value = section
    settingsCharacterId.value = section === 'characters' ? characterId : undefined
    currentView.value = 'settings'
  }

  return { currentView, settingsSection, settingsCharacterId, setView, openSettings }
})
