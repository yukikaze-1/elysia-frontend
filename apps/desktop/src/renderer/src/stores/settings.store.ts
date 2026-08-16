// src/renderer/src/stores/settings.store.ts
// 阶段 4 批次 B（spec §5.10）：语音/转写本地设置 store——前端自有设置（settings.json，Main SettingsService 持久化，无 backend 端点）。
// - hydrate() 启动装载：成功覆盖 state + loaded=true；失败 fail-open 保留默认（不阻塞启动）；
// - setVoice/setDictation：本地改 + 500ms 防抖 api.settingsSave(patch)（patch 累积合并，防窗口内丢更新）；
//   saveError 置位失败；saved 供 UI 展示「已保存」态；
// - applyDictationInsert（D-P4）：转写 final 插入草稿——insertMode='replace_selection' 且有选区 → 替换区间，
//   否则追加草稿末尾；纯函数 insertDictationText 导出供单测。无活动会话 no-op。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DictationSettings, SettingsPatch, VoiceSettings } from '@shared/contracts'
import { DEFAULT_SETTINGS } from '@shared/schemas'
import { api } from './desktop-api'
import { useConversationStore } from './conversation.store'
import { useDraftStore } from './draft.store'

export const SETTINGS_SAVE_DEBOUNCE_MS = 500

/** 转写插入选区（textarea selectionStart/selectionEnd 透传） */
export interface DictationSelection { start: number; end: number }

/**
 * D-P4 纯函数：insertMode='append'（或无选区）→ draft + text；
 * 'replace_selection' 且有有效选区 → 替换区间；选区越界/倒置/非有限数 → 回退追加。
 */
export function insertDictationText(
  draft: string,
  text: string,
  mode: 'append' | 'replace_selection',
  selection?: DictationSelection
): string {
  if (mode !== 'replace_selection' || !selection) return draft + text
  const { start, end } = selection
  if (!Number.isFinite(start) || !Number.isFinite(end)) return draft + text
  const s = Math.max(0, Math.min(draft.length, Math.floor(start)))
  const e = Math.max(0, Math.min(draft.length, Math.floor(end)))
  if (s >= e) return draft + text // 无有效区间（倒置/空选区）→ 回退追加
  return draft.slice(0, s) + text + draft.slice(e)
}

export const useSettingsStore = defineStore('settings', () => {
  const voice = ref<VoiceSettings>({ ...DEFAULT_SETTINGS.voice })
  const dictation = ref<DictationSettings>({ ...DEFAULT_SETTINGS.dictation })
  const loaded = ref(false)
  const saveError = ref<string>()
  const saved = ref(false)

  /** 防抖窗口内待持久化 patch（累积合并，500ms 内多次修改合并为一次 save，不丢字段） */
  let pending: SettingsPatch = {}
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  async function hydrate(): Promise<void> {
    try {
      const state = await api.settingsLoad()
      if (state) {
        voice.value = { ...state.voice }
        dictation.value = { ...state.dictation }
      }
    } catch {
      // fail-open：装载失败保留默认（C1 同款），不阻塞启动
    }
    loaded.value = true
  }

  function scheduleSave(patch: SettingsPatch): void {
    pending = {
      ...(patch.voice ? { voice: { ...pending.voice, ...patch.voice } } : {}),
      ...(patch.dictation ? { dictation: { ...pending.dictation, ...patch.dictation } } : {})
    }
    saved.value = false
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void persist() }, SETTINGS_SAVE_DEBOUNCE_MS)
  }

  async function persist(): Promise<void> {
    if (!pending.voice && !pending.dictation) return
    const patch = pending
    pending = {}
    try {
      const state = await api.settingsSave(patch)
      if (state) {
        voice.value = { ...state.voice }
        dictation.value = { ...state.dictation }
      }
      saveError.value = undefined
      saved.value = true
    } catch (e) {
      saveError.value = e instanceof Error ? e.message : String(e)
    }
  }

  function setVoice(patch: Partial<VoiceSettings>): void {
    voice.value = { ...voice.value, ...patch }
    scheduleSave({ voice: patch })
  }

  function setDictation(patch: Partial<DictationSettings>): void {
    dictation.value = { ...dictation.value, ...patch }
    scheduleSave({ dictation: patch })
  }

  /** D-P4：转写 final 插入草稿——当前会话草稿末尾追加或替换选区；无活动会话 no-op */
  function applyDictationInsert(text: string, selection?: DictationSelection): void {
    const currentId = useConversationStore().currentId
    if (!currentId) return
    const draft = useDraftStore().drafts[currentId] ?? ''
    const next = insertDictationText(draft, text, dictation.value.insertMode, selection)
    useDraftStore().saveDraft(currentId, next)
  }

  return {
    voice, dictation, loaded, saveError, saved,
    hydrate, setVoice, setDictation, applyDictationInsert
  }
})
