// apps/desktop/src/renderer/src/live2d/state-source.ts
// 阶段 5 批次 B（Task 4，B4 wiring / D5B-04）：live2dStateSource——薄状态编排层。
//
// 职责：组合 connection/message/voice store 的读值（经注入的 getter 函数）→ 仲裁出 `CharacterState` →
// 只经 `push(controller.setState(...))` 落到 Controller（N2：生产组合走 setState，不用 onEvent——Task 3 评审
// 确认 onEvent 只在纯状态机单测可达）。
//
// 组合顺序（spec §3.1 优先级收敛 + plan Task4 Step3，source 权威，直接采纳）：
//   connection disconnected → offline
//   isGenerating && !isSpeaking → thinking
//   isSpeaking（voiceStore.tts.playing 或当前生成已产出正文）→ speaking
//   emotion（最后完成 assistant message .emotion）命中本地映射（happy/sad/surprised）→ 对应情绪态，未知码忽略
//   connection.status==='error' → error
//   否则 → idle
//
// 订阅机制：`watch`（flush:'sync'）跟踪注入 getter 内 deref 的 Vue reactive 依赖（renderer 内 Pinia ref），
// 源变化同步重算并 push；CharacterState 为字符串返回值，watch 仅当结果变化才触发（天然幂等）。
//
// N1（时长上限回退，spec §3.1『回原业务态』）：状态机不退 transient 时，本 source 负责超时后 push 回退态——
//   情绪态（happy/sad/surprised）~2s 后回退到进入前业务态；error ~3s 后回退。用定时器，退订时清理。
//
// conversationStore 作为驱动源：批次 B 无「conversation→角色态」具体映射（无意义），本批不订阅，归阶段 6 / 后续。
import { watch, type WatchStopHandle } from 'vue'
import type { ConnectionState } from '@shared/contracts'
import type { CharacterState } from './state-machine'
import type { MoodEmotion } from './controller'

export interface Live2dStateSourceInputs {
  connection: () => ConnectionState
  isGenerating: () => boolean
  isSpeaking: () => boolean
  /** 最后完成 assistant message 的 `.emotion`（未知码忽略） */
  emotion: () => string | undefined
}

export type Live2dStateSourcePush = (s: CharacterState) => void

/** 已知情绪码（I-1 本地映射命中集；未知码忽略 → 保持业务态） */
const KNOWN_MOODS: ReadonlySet<string> = new Set<MoodEmotion>(['happy', 'sad', 'surprised'])

/** transient 态（进入时记录回退基底；结束时由 N1 超时回退到进入前业务态） */
function isTransient(s: CharacterState): boolean {
  return s === 'happy' || s === 'sad' || s === 'surprised' || s === 'error'
}

/** 纯组合（可独立单测）：按优先级收敛表把各源读值归约为最终 CharacterState。 */
export function composeCharacterState(inputs: {
  connection: ConnectionState
  isGenerating: boolean
  isSpeaking: boolean
  emotion: string | undefined
}): CharacterState {
  const { connection, isGenerating, isSpeaking, emotion } = inputs
  if (connection.status === 'disconnected') return 'offline'
  if (isGenerating && !isSpeaking) return 'thinking'
  if (isSpeaking) return 'speaking'
  if (emotion !== undefined && KNOWN_MOODS.has(emotion)) return emotion as MoodEmotion
  if (connection.status === 'error') return 'error'
  return 'idle'
}

const MOOD_TIMEOUT_MS = 2000 // 情绪态回退基（~2s）
const ERROR_TIMEOUT_MS = 3000 // error 回退基（~3s）

/**
 * 创建 live2dStateSource。
 * @param sources 各源 getter（读真实 store；测试注入可控读取）
 * @param push    落点（生产 = controller.setState；测试注入记录器）
 * @returns 退订函数：停 watch + 清 N1 定时器（幂等）。
 */
export function createLive2dStateSource(
  sources: Live2dStateSourceInputs,
  push: Live2dStateSourcePush
): () => void {
  let currentState: CharacterState | null = null // 最近一次真实 push 的态（去重：不重复 push 同态）
  let lastBusiness: CharacterState = 'idle' // 最近业务态（非 transient），瞬态回退基底
  let fallbackTarget: CharacterState = 'idle' // 当前 transient 进入前的业务态
  let moodTimer: ReturnType<typeof setTimeout> | undefined
  let errorTimer: ReturnType<typeof setTimeout> | undefined

  function clearMoodTimer(): void {
    if (moodTimer) clearTimeout(moodTimer)
    moodTimer = undefined
  }
  function clearErrorTimer(): void {
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = undefined
  }
  function startMoodTimer(): void {
    clearMoodTimer()
    moodTimer = setTimeout(() => {
      moodTimer = undefined
      currentState = fallbackTarget
      lastBusiness = fallbackTarget
      push(fallbackTarget)
    }, MOOD_TIMEOUT_MS)
  }
  function startErrorTimer(): void {
    clearErrorTimer()
    errorTimer = setTimeout(() => {
      errorTimer = undefined
      currentState = fallbackTarget
      lastBusiness = fallbackTarget
      push(fallbackTarget)
    }, ERROR_TIMEOUT_MS)
  }

  /** 组合结果落点：transient 态启动 N1 回退 timer（并记录进入前业务态为 fallbackTarget）；业务态清 timer 并更新
   *  业务基底；同态不重推（幂等）。一律只经 push 落到 controller.setState（N2）。 */
  function handleCompose(s: CharacterState): void {
    if (s === currentState) return
    if (isTransient(s)) {
      fallbackTarget = lastBusiness
      if (s === 'error') {
        clearMoodTimer()
        startErrorTimer()
      } else {
        clearErrorTimer()
        startMoodTimer()
      }
    } else {
      clearMoodTimer()
      clearErrorTimer()
      lastBusiness = s
    }
    currentState = s
    push(s)
  }

  const stop: WatchStopHandle = watch(
    () =>
      composeCharacterState({
        connection: sources.connection(),
        isGenerating: sources.isGenerating(),
        isSpeaking: sources.isSpeaking(),
        emotion: sources.emotion()
      }),
    (s) => handleCompose(s),
    { immediate: true, flush: 'sync' }
  )

  return () => {
    stop()
    clearMoodTimer()
    clearErrorTimer()
  }
}
