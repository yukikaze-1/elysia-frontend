// src/renderer/src/stores/settings.store.ts
// 阶段 4 批次 B（spec §5.10）：语音/转写本地设置 store——前端自有设置（settings.json，Main SettingsService 持久化，无 backend 端点）。
// 阶段 5 批次 A（A6，D5A-10）：增 live2d 子树（enabled/modelId）——setLive2d 复制 setVoice 模式；
// hydrate/scheduleSave/persist 三处接线（缺则静默丢 live2d 持久化；500ms 防抖窗口内 voice/dictation/live2d
// 混改时 pending 三键累积合并，不丢任何子树）。
// - hydrate() 启动装载：成功覆盖 state + loaded=true；失败 fail-open 保留默认（不阻塞启动）；
// - setVoice/setDictation/setLive2d：本地改 + 500ms 防抖 api.settingsSave(patch)（patch 累积合并，防窗口内丢更新）；
//   saveError 置位失败；saved 供 UI 展示「已保存」态；
// - applyDictationInsert（D-P4）：转写 final 插入草稿——insertMode='replace_selection' 且有选区 → 替换区间，
//   否则追加草稿末尾；纯函数 insertDictationText 导出供单测。无活动会话 no-op。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DictationSettings, Live2DSettings, SettingsPatch, VoiceSettings } from '@shared/contracts'
import { DEFAULT_LIVE2D, DEFAULT_SETTINGS } from '@shared/schemas'
import { api } from './desktop-api'
import { getCurrentConversationId } from './session'
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
  const live2d = ref<Live2DSettings>({ ...DEFAULT_LIVE2D }) // 阶段 5 批次 A（D5A-10）
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
        live2d.value = { ...state.live2d } // ① 接线：读 state.live2d（缺 live2d 段时 SettingsStateSchema.default 已补默认）
      }
    } catch {
      // fail-open：装载失败保留默认（C1 同款），不阻塞启动
    }
    loaded.value = true
  }

  function scheduleSave(patch: SettingsPatch): void {
    // 跨子树累积（评审 Important-1）：setDictation 后紧跟 setVoice 时，两棵子树的待持久化 patch 都保留，
    // 否则前一个子树的修改在 500ms 窗口内被丢（如 autoReadReply 与 STT Profile 同窗口操作后重启丢失）。
    // 阶段 5 批次 A（A6）：③ 增第三键 live2d——防 500ms 窗口内 voice 与 live2d 混改丢子树。
    pending = {
      voice: patch.voice ? { ...pending.voice, ...patch.voice } : pending.voice,
      dictation: patch.dictation ? { ...pending.dictation, ...patch.dictation } : pending.dictation,
      live2d: patch.live2d ? { ...pending.live2d, ...patch.live2d } : pending.live2d
    }
    saved.value = false
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void persist() }, SETTINGS_SAVE_DEBOUNCE_MS)
  }

  async function persist(): Promise<void> {
    if (!pending.voice && !pending.dictation && !pending.live2d) return // ③ 早退条件含 live2d
    const patch = pending
    pending = {}
    try {
      const state = await api.settingsSave(patch)
      if (state) {
        voice.value = { ...state.voice }
        dictation.value = { ...state.dictation }
        live2d.value = { ...state.live2d } // ③ 回写：post-save 镜像 Main merge 结果
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

  /** 阶段 5 批次 A（D5A-10）：Local2D 设置局部更新（复制 setVoice 模式）——本地改 + 防抖持久化 live2d 子树 */
  function setLive2d(patch: Partial<Live2DSettings>): void {
    live2d.value = { ...live2d.value, ...patch }
    scheduleSave({ live2d: patch })
  }

  /** D-P4：转写 final 插入草稿——当前会话草稿末尾追加或替换选区；无活动会话 no-op */
  function applyDictationInsert(text: string, selection?: DictationSelection): void {
    // 会话身份从单例读取（解环，2026-09-10）：此前读 useConversationStore().currentId，
    // 使 settings → conversation → message → voice → settings 成环。会话身份是零依赖单例，
    // 本模块不再需要 import conversation.store。
    const currentId = getCurrentConversationId()
    if (!currentId) return
    const draft = useDraftStore().drafts[currentId] ?? ''
    const next = insertDictationText(draft, text, dictation.value.insertMode, selection)
    useDraftStore().saveDraft(currentId, next)
  }

  return {
    voice, dictation, live2d, loaded, saveError, saved,
    hydrate, setVoice, setDictation, setLive2d, applyDictationInsert
  }
})
