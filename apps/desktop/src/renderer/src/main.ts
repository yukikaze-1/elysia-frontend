import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './tokens.css'
import './reduced-motion.css'
import { setDesktopApi } from './stores/desktop-api'
import { useConnectionStore } from './stores/connection.store'
import { useMessageStore } from './stores/message.store'
import { useConversationStore } from './stores/conversation.store'
import { useLayoutStore } from './stores/layout.store'
import { useDraftStore } from './stores/draft.store'
import { useCacheStore } from './stores/cache.store'
import { useVoiceStore } from './stores/voice.store'
import { useSettingsStore } from './stores/settings.store'
import { useLive2dStore } from './stores/live2d.store'
import { useToolStore } from './stores/tool.store'
import { useAttachmentStore } from './stores/attachment.store'
import { useIdentityStore } from './stores/identity.store'
import { useCharacterCatalogStore } from './stores/character-catalog.store'
import { useCharacterEditorStore } from './stores/character-editor.store'
import { useCharacterRuntimeStore } from './stores/character-runtime.store'
import { createCharacterRuntimeCoordinator } from './stores/character-runtime-coordinator'
import { createRendererBootstrap } from './bootstrap'
import { createReduceMotionGate, REDUCE_MOTION_QUERY } from './utils/reduce-motion'
import { applyFontScale } from './utils/appearance'

const app = createApp(App)
app.use(createPinia())

// C-17（#35）：Renderer JS 全局错误兜底（可观测性加固，非修复屏）——捕获未处理错误归集到 console.error，
// 避免错误导致白屏却无痕（7B 覆盖进程崩溃 render-process-gone → reload + banner；JS 异常是独立候选）。
// 注意：Vue 3.5 的 app.config.errorHandler 存在时**接管**组件错误处理——handleError 里 `if (errorHandler) { callWithErrorHandling(errorHandler); return }`
// 直接 return 不再走默认 logError（console.error 输出）。因此这里**不是**「不吞仍默认传播」，而是在 handler 内显式记录。
// 同时补 Vue 外的全局错误源：window 'error'（同步 JS）与 'unhandledrejection'（未处理 promise），
// 三者统一接到 rendererError 记录，标注来源，错误仍会中断当前渲染帧/触发浏览器默认行为（不静默吞）。
function rendererError(source: string, detail: unknown, extra?: unknown): void {
  console.error(`[renderer:js-error:${source}]`, detail, extra)
}
app.config.errorHandler = (err, _instance, info) => rendererError('vue', err, info)
window.addEventListener('error', (e) => rendererError('window', e.message, `${e.filename}:${e.lineno}:${e.colno}`))
window.addEventListener('unhandledrejection', (e) => rendererError('unhandledrejection', e.reason))

// G1（spec §4.5/P2-2）：createPinia 之后、mount 之前同步 hydrate 布局偏好，避免首帧闪默认布局
useLayoutStore().hydrate()

// M-24（2026-09-12，全量评审）：「减少动态」门控。此前 `prefers-reduced-motion` 零支持，且自有开关
// （settings.live2d.reduceMotion）只管 Live2D 的鼠标跟随/点击动作，6 处 `animation: … infinite`
// 完全无门控 ⇒ doc 03 §14 的对应条款长期未满足。现把两个来源（OS 偏好 ∨ 自有开关）折算成根元素
// 的 `cy-reduce-motion` 类，由 reduced-motion.css 统一关掉那些持续动画（覆盖完整性另有门禁）。
// 放在 mount 之前：首帧即生效，避免"先动一下再停"。settings 是异步水合（fail-open），故 watch 兜住。
const settingsStore = useSettingsStore()
const reduceMotionGate = createReduceMotionGate({
  root: document.documentElement,
  media: typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_MOTION_QUERY) : { matches: false },
  readSetting: () => settingsStore.live2d.reduceMotion
})
reduceMotionGate.sync()
watch(() => settingsStore.live2d.reduceMotion, () => { reduceMotionGate.sync() })

// 外观（2026-09-13）：全局字体缩放（doc 03 §12.4 / doc 11 §7.2）。把百分比写到根节点的
// `--cy-user-font-scale` 上，`tokens.css` 的整条字号阶梯乘它 ⇒ 一次改动覆盖全部字号引用。
// 与"减少动态"同款：mount 之前先同步一次（首帧即生效，避免先按 100% 画一帧再跳），
// settings 异步水合完成后由 watch 兜住（= doc 11 §7.2 要的"即时预览"，无需重载）。
const syncFontScale = (): void => { applyFontScale(document.documentElement, settingsStore.appearance.fontScale) }
syncFontScale()
watch(() => settingsStore.appearance.fontScale, syncFontScale)

// P2-1 + R3:Pinia install 之后接线(Pinia 已 setActivePinia,use*Store() 才可用)——注入 api + 常驻订阅(store 级,组件卸载无关)。
// P0-01:订阅与启动 snapshot 水合编排收敛到 bootstrap(epoch 防迟到 snapshot 覆盖新 push)。
// P3-6:desktopApi 守卫——仅 Electron preload contextBridge 注入;普通浏览器打开产物时 window.desktopApi 为 undefined,不接线不抛错。
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  const connectionStore = useConnectionStore()
  const conversationStore = useConversationStore()
  const characterRuntimeStore = useCharacterRuntimeStore()
  createRendererBootstrap(window.desktopApi, {
    connection: connectionStore,
    message: useMessageStore(),
    conversation: conversationStore,
    draft: useDraftStore(),
    cache: useCacheStore(),
    voice: useVoiceStore(),
    settings: useSettingsStore(),
    identity: useIdentityStore(),
    characterCatalog: useCharacterCatalogStore(),
    characterEditor: useCharacterEditorStore(),
    characterRuntime: characterRuntimeStore,
    characterRuntimeCoordinator: createCharacterRuntimeCoordinator(conversationStore, connectionStore, characterRuntimeStore),
    live2d: useLive2dStore(), // 批次 C（C3）：live2d.directive 分发（handleDirective 消费）
    layout: useLayoutStore(), // H-04：退出前 flush 布局偏好（localStorage 200ms 防抖）
    tools: useToolStore() // 阶段 6 批次 B（Task 7）：tool.* 事件旁路 + tool:event 常驻订阅 + generation 清终态接线
  }).register()
}

// C1（批次 C）口型集成探针：仅 dev / test 构建暴露（生产不暴露测试面）。Playwright 经
// window.__cyreneTest.getMouthLevel() 断言口型电平随 CYRENE_MOCK_MOUTH_LEVEL 合成包络变化。
// getTtsState()（CI 稳健化补充）：失败转储 voiceStore.tts 三字段 + readySeen（ready 是否曾到达，cancel 后仍可查）
// ——定位「ready 未到达 / autoReadReply 门控 / 播放态回落」断点；getMouthInfo() 返回口部源种类（step/sine/real），
// 区分「合成包络未水合（读静音恒 0）」与「attach/播放断链」。
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  ;(window as unknown as {
    __cyreneTest?: {
      getMouthLevel: () => number
      getTtsState: () => {
        url: string | null
        playing: boolean
        playingStreamId: number | null
        readySeen: boolean
        autoReadReply: boolean
        ttsAudioElPresent: boolean
      }
      // L6（2026-09-15）：kind 增加 'degraded'（attach 真的没挂上）——此前它与 'real'/'step'/'sine'
      // 混为一谈，探针无法区分「attach 失败」与「确实没在说话」。
      getMouthInfo: () => { kind: 'step' | 'sine' | 'real' | 'degraded' | null; moved: boolean; settled: boolean }
      // 阶段 6 批次 B（Task 7）：工具实时区探针（Task 8 集成测试消费）
      getToolState: () => {
        records: Record<string, import('@shared/contracts/tool').ToolCallRecord>
        liveOrder: string[]
        activeConversationId: string | undefined
        waitingForApproval: boolean
        pendingPathSummary: { callId: string; pathSummary: string } | null
      }
      getPermissionPending: () => import('@shared/contracts/tool').ToolCallRecord | null
      /** H-10（2026-09-11）：生成生命周期探针（集成用例断言「卡住后真的释放了活动代」） */
      getGenerationState: () => {
        activeGenerationId: string | null
        sending: boolean
        lastErrorCode: string | null
        stalled: boolean
        conversationReady: boolean
        conversationBusy: boolean
        currentId: string | null
        droppedEvents: number
        voiceMode: string
        attachmentBlockReason: string | null
        sendButtonCount: number
        draftFromStore: string
        connectionStatus: string
        featureCharacterProfiles: boolean | null
      }
    }
  }).__cyreneTest = {
    getMouthLevel: () => useLive2dStore().mouthLevel,
    getTtsState: () => {
      const v = useVoiceStore()
      const t = v.tts
      return {
        url: t.url ?? null,
        playing: t.playing,
        playingStreamId: t.playingStreamId ?? null,
        readySeen: v.ttsReadySeen,
        autoReadReply: useSettingsStore().voice.autoReadReply,
        ttsAudioElPresent: v.getTtsAudioEl() !== null
      }
    },
    getMouthInfo: () => {
      const s = useLive2dStore()
      return { kind: s.mouthSourceKind, moved: s.mouthMoved, settled: s.mouthSettled }
    },
    getToolState: () => { const s = useToolStore(); return { records: s.records, liveOrder: s.liveOrder, activeConversationId: s.activeConversationId, waitingForApproval: s.waitingForApproval, pendingPathSummary: s.pendingPathSummary } },
    getPermissionPending: () => { const s = useToolStore(); return s.liveRecords().find(r => r?.status === 'awaiting_permission') ?? null },
    /**
     * H-10（2026-09-11）：生成生命周期探针——集成用例据此断言「卡住后**真的**释放了活动代」，
     * 而不是只看流式占位的出现/消失（DOM 只能证明表象，且 H-04 那批已有一次 e2e 断言选错对象的教训）。
     * 同时暴露 composer 的发送门控输入，便于失败时一眼看出是哪一项挡住了发送。
     */
    getGenerationState: () => {
      const m = useMessageStore()
      const c = useConversationStore()
      return {
        activeGenerationId: m.activeGenerationId ?? null,
        sending: m.sending,
        lastErrorCode: m.lastError?.code ?? null,
        stalled: m.lastError?.code === 'GENERATION_STALLED',
        conversationReady: c.ready,
        conversationBusy: c.busy,
        currentId: c.currentId ?? null,
        droppedEvents: m.droppedEvents,
        voiceMode: useVoiceStore().mode,
        attachmentBlockReason: useAttachmentStore().canSend.blockReason ?? null,
        sendButtonCount: document.querySelectorAll('.cy-send-btn').length,
        draftFromStore: c.currentId ? (useDraftStore().drafts[c.currentId] ?? '') : '',
        connectionStatus: useConnectionStore().state.status,
        featureCharacterProfiles: useConnectionStore().state.features?.characterProfiles ?? null
      }
    }
  }
}

app.mount('#app')
