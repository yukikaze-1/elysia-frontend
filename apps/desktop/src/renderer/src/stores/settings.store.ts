// src/renderer/src/stores/settings.store.ts
// 阶段 4 批次 B（spec §5.10）：语音/转写本地设置 store——前端自有设置（settings.json，Main SettingsService 持久化，无 backend 端点）。
// 阶段 5 批次 A（A6，D5A-10）：增 live2d 子树（enabled/modelId）——setLive2d 复制 setVoice 模式；
// hydrate/scheduleSave/persist 三处接线（缺则静默丢 live2d 持久化；500ms 防抖窗口内 voice/dictation/live2d
// 混改时 pending 三键累积合并，不丢任何子树）。
// - hydrate() 启动装载：成功覆盖 state + loaded=true；失败 fail-open 保留默认（不阻塞启动）；
// - setVoice/setDictation/setLive2d/setAppearance：本地改 + 500ms 防抖 api.settingsSave(patch)（patch 累积合并，防窗口内丢更新）；
//   **保存失败不再丢弃 patch**（M-19，2026-09-13）：失败 → merge 回 pending + 一次自动重试 + saveError 置位（code 形态）
//   + unsaved 保持 true，供 UI 如实告知（此前 `pending = {}` 在 await 之前执行，失败即静默丢弃）；
// - applyDictationInsert（D-P4）：转写 final 插入草稿——insertMode='replace_selection' 且有选区 → 替换区间，
//   否则追加草稿末尾；纯函数 insertDictationText 导出供单测。无活动会话 no-op。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppearanceSettings, DictationSettings, Live2DSettings, SettingsPatch, VoiceSettings } from '@shared/contracts'
import { DEFAULT_APPEARANCE, DEFAULT_LIVE2D, DEFAULT_SETTINGS } from '@shared/schemas'
import { api } from './desktop-api'
import { getCurrentConversationId } from './session'
import { useDraftStore } from './draft.store'
import { parsePublicError, type PublicError } from '../utils/public-error'

export const SETTINGS_SAVE_DEBOUNCE_MS = 500
/**
 * 失败后的自动重试间隔（M-19，2026-09-13）。
 *
 * 为什么不是"沿用 500ms 防抖重试"：磁盘满 / 权限不足这类失败是**持续**的，按防抖节奏重试等于
 * 每 500ms 打一次盘（热循环）。故只安排**一次**、且退到更长的间隔；再失败就把 patch 留在队列里，
 * 交由下一次修改或退出 flush 再试——同时错误状态一直显示着，用户不会以为已保存。
 */
export const SETTINGS_SAVE_RETRY_MS = 3000

/** 转写插入选区（textarea selectionStart/selectionEnd 透传） */
export interface DictationSelection { start: number; end: number }

/**
 * patch 合并（M-19 判别点之一）：`older` 是失败后要放回队列的那一份，`newer` 是等待期间用户
 * 新产生的改动——**新的优先**，否则重试会把用户刚改的值覆盖回失败前那一份。
 */
export function mergeSettingsPatch(older: SettingsPatch, newer: SettingsPatch): SettingsPatch {
  return {
    voice: older.voice || newer.voice ? { ...older.voice, ...newer.voice } : undefined,
    dictation: older.dictation || newer.dictation ? { ...older.dictation, ...newer.dictation } : undefined,
    live2d: older.live2d || newer.live2d ? { ...older.live2d, ...newer.live2d } : undefined,
    tools: older.tools || newer.tools ? { ...older.tools, ...newer.tools } : undefined,
    appearance: older.appearance || newer.appearance ? { ...older.appearance, ...newer.appearance } : undefined
  }
}

/** 是否还有任何子树待写（早退判据的唯一来源：新增子树时只改这一处） */
export function hasPendingPatch(patch: SettingsPatch): boolean {
  return Boolean(patch.voice || patch.dictation || patch.live2d || patch.tools || patch.appearance)
}

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
  const appearance = ref<AppearanceSettings>({ ...DEFAULT_APPEARANCE }) // 外观（2026-09-13）：全局字体缩放
  const loaded = ref(false)
  /**
   * 最近一次保存失败（M-19，2026-09-13）。
   *
   * 形态是 **code**（`PublicError`）而不是原始 message：措辞归 UI 层（`utils/error-message.ts`），
   * 与 2026-09-10「多套 UI 基础」定下的分工一致；原始跨进程文本不再直接显示。
   */
  const saveError = ref<PublicError>()
  /** 是否存在**未确认写入**的改动（M-19）：失败后保持 true——patch 已被保留并会重试，UI 据此说真话 */
  const unsaved = ref(false)
  const saved = ref(false)

  /** 防抖窗口内待持久化 patch（累积合并，500ms 内多次修改合并为一次 save，不丢字段） */
  let pending: SettingsPatch = {}
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  /** 失败后是否已安排过一次自动重试（防持续失败时按防抖节奏热循环打盘） */
  let retryScheduled = false

  async function hydrate(): Promise<void> {
    try {
      const state = await api.settingsLoad()
      if (state) {
        voice.value = { ...state.voice }
        dictation.value = { ...state.dictation }
        live2d.value = { ...state.live2d } // ① 接线：读 state.live2d（缺 live2d 段时 SettingsStateSchema.default 已补默认）
        appearance.value = { ...state.appearance } // 外观：同上（缺 appearance 段时 schema.default 补 {fontScale:100}）
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
    // M-19（2026-09-13）：合并逻辑收口到 `mergeSettingsPatch`（同一份语义也被失败回滚路径复用）。
    pending = mergeSettingsPatch(pending, patch)
    saved.value = false
    unsaved.value = true
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; void persist() }, SETTINGS_SAVE_DEBOUNCE_MS)
  }

  async function persist(): Promise<void> {
    if (!hasPendingPatch(pending)) return // ③ 早退条件含 live2d / 外观（判据见 hasPendingPatch）
    const patch = pending
    pending = {}
    try {
      const state = await api.settingsSave(patch)
      if (state) {
        voice.value = { ...state.voice }
        dictation.value = { ...state.dictation }
        live2d.value = { ...state.live2d } // ③ 回写：post-save 镜像 Main merge 结果
        appearance.value = { ...state.appearance } // 外观：同上
      }
      saveError.value = undefined
      saved.value = true
      unsaved.value = false
      retryScheduled = false
    } catch (e) {
      // M-19 的核心修复：**失败不丢 patch**。此前 `pending = {}` 在 await 之前执行，失败即丢弃——
      // 用户看到开关生效（本地态已改）、重启后被静默还原。现把这一份放回队列（等待期间的新改动优先）。
      pending = mergeSettingsPatch(patch, pending)
      unsaved.value = true
      saved.value = false
      saveError.value = parsePublicError(e instanceof Error ? e.message : String(e))
      if (!retryScheduled) {
        retryScheduled = true
        if (saveTimer !== undefined) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => { saveTimer = undefined; void persist() }, SETTINGS_SAVE_RETRY_MS)
      }
    }
  }

  /**
   * 退出前 flush（H-04，2026-09-11）：取消 500ms 防抖并立刻落盘待写 patch。
   * 背景：此前无任何退出 flush，拨动开关后立刻关窗（≤500ms）的修改静默丢失，重启才发现被还原。
   * `persist()` 内部已 fail-open（失败写 saveError，不外抛）。
   */
  async function flush(): Promise<void> {
    if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined }
    await persist()
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

  /** 外观（2026-09-13）：全局字体缩放局部更新——本地改（即时预览）+ 防抖持久化 appearance 子树 */
  function setAppearance(patch: Partial<AppearanceSettings>): void {
    appearance.value = { ...appearance.value, ...patch }
    scheduleSave({ appearance: patch })
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
    voice, dictation, live2d, appearance, loaded, saveError, unsaved, saved,
    hydrate, setVoice, setDictation, setLive2d, setAppearance, applyDictationInsert, flush
  }
})
