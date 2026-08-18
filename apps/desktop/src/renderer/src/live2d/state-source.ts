// apps/desktop/src/renderer/src/live2d/state-source.ts
// 阶段 5 批次 B（Task 4，B4 wiring / D5B-04）：live2dStateSource——薄状态编排层。
//
// 职责：组合 connection/message/voice store 的读值（经注入的 getter 函数）→ 仲裁出 `CharacterState` →
// 只经 `push(controller.setState(...))` 落到 Controller（N2：生产组合走 setState，不用 onEvent——Task 3 评审
// 确认 onEvent 只在纯状态机单测可达）。
//
// 组合顺序（spec §3.1 优先级收敛 + plan Task4 Step3，source 权威，直接采纳；I-4 error 优先级最高）：
//   connection disconnected → offline
//   connection.status==='error' → error（3 级，紧跟连接判定，高于 thinking/speaking 与 emotion）
//   isGenerating && !isSpeaking → thinking
//   isSpeaking（voiceStore.tts.playing 或当前生成已产出正文）→ speaking
//   emotion（最后完成 assistant message .emotion）命中本地映射（happy/sad/surprised）→ 对应情绪态，未知码忽略
//   否则 → idle
//
// 订阅机制：`watch`（flush:'sync'）跟踪注入 getter 内 deref 的 Vue reactive 依赖（renderer 内 Pinia ref），
// 源变化同步重算并 push；CharacterState 为字符串返回值，watch 仅当结果变化才触发（天然幂等）。
//
// N1（时长上限回退，spec §3.1『回原业务态』）：状态机不退 transient 时，本 source 负责超时后 push 回退态——
//   情绪态（happy/sad/surprised）~2s 后回退；error ~3s 后回退。I-1 修复：超时回调**重新组合当前业务态**再
//   push（mood timer 以 emotion 置空重跑 compose、error timer 以 connection 状态业务化重跑），落到「当前真实
//   业务态」而非记忆的 fallbackTarget（防生成已结束仍卡 thinking 等陈旧态）。退订时清理 timers。
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

/** live2dStateSource 句柄（C2 D5C-04：GPU 重建后恢复 CharacterState 需 recompose 重组合） */
export interface Live2dStateSource {
  /** 退订：停 watch + 清 N1 mood/error 回退 timers（幂等） */
  unsub: () => void
  /** 重组合（GPU 重建后恢复当前 CharacterState）：按当前业务源重新组合并 push（经 handleCompose——瞬态重启
   *  超时 timer、business 态清 timer、同态不重推） */
  recompose: () => void
}

/** 已知情绪码（I-1 本地映射命中集；未知码忽略 → 保持业务态） */
const KNOWN_MOODS: ReadonlySet<string> = new Set<MoodEmotion>(['happy', 'sad', 'surprised'])

/** transient 态（进入时记录回退基底；结束时由 N1 超时回退到进入前业务态） */
function isTransient(s: CharacterState): boolean {
  return s === 'happy' || s === 'sad' || s === 'surprised' || s === 'error'
}

/** 纯组合（可独立单测）：按优先级收敛表把各源读值归约为最终 CharacterState。
 *  顺序（I-4 拍板：spec §3.1 优先级表 binding）：offline(0) → error(3) → thinking/speaking(2) →
 *  emotion(1) → idle(0)——error 优先级最高，紧跟连接判定，不被 thinking(2)/emotion(1) 遮蔽。 */
export function composeCharacterState(inputs: {
  connection: ConnectionState
  isGenerating: boolean
  isSpeaking: boolean
  emotion: string | undefined
}): CharacterState {
  const { connection, isGenerating, isSpeaking, emotion } = inputs
  if (connection.status === 'disconnected') return 'offline'
  // error=3（最高）：连接存活错误态优先于 thinking/speaking(2) 与 emotion(1)
  if (connection.status === 'error') return 'error'
  if (isGenerating && !isSpeaking) return 'thinking'
  if (isSpeaking) return 'speaking'
  if (emotion !== undefined && KNOWN_MOODS.has(emotion)) return emotion as MoodEmotion
  return 'idle'
}

const MOOD_TIMEOUT_MS = 2000 // 情绪态回退基（~2s）
const ERROR_TIMEOUT_MS = 3000 // error 回退基（~3s）

/**
 * 创建 live2dStateSource。
 * @param sources 各源 getter（读真实 store；测试注入可控读取）
 * @param push    落点（生产 = controller.setState；测试注入记录器）
 * @returns Live2dStateSource 句柄：{ unsub, recompose }。
 */
export function createLive2dStateSource(
  sources: Live2dStateSourceInputs,
  push: Live2dStateSourcePush
): Live2dStateSource {
  let currentState: CharacterState | null = null // 最近一次真实 push 的态（去重：不重复 push 同态）
  let moodTimer: ReturnType<typeof setTimeout> | undefined
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false // 退订后 recompose no-op（防 teardown 后陈旧重组合误 push）

  function clearMoodTimer(): void {
    if (moodTimer) clearTimeout(moodTimer)
    moodTimer = undefined
  }
  function clearErrorTimer(): void {
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = undefined
  }

  /** N1 超时回退（I-1 修复）：重组合「当前真实业务态」再 push——不 push 进入瞬态前记忆的 fallbackTarget（时间
   *  流逝后可能早已不成立）。mood timer 以 emotion 置空重跑（情绪为过去的瞬态，不作为持久源）；error timer 以
   *  connection 状态业务化重跑（视为已恢复）。若重组合结果仍是瞬态（罕见：mood 路径恰逢 connection error 等），
   *  重挂对应 timer 保持「瞬态必过期」不变量。 */
  function pushRecomposed(overrides: { emotion?: string; forceBusinessConnection?: boolean }): void {
    const conn = sources.connection()
    const s = composeCharacterState({
      connection: overrides.forceBusinessConnection ? { ...conn, status: 'connected' } : conn,
      isGenerating: sources.isGenerating(),
      isSpeaking: sources.isSpeaking(),
      emotion: overrides.emotion
    })
    currentState = s
    if (isTransient(s)) {
      if (s === 'error') startErrorTimer()
      else startMoodTimer()
    }
    push(s)
  }

  function startMoodTimer(): void {
    clearMoodTimer()
    moodTimer = setTimeout(() => {
      moodTimer = undefined
      pushRecomposed({ emotion: undefined })
    }, MOOD_TIMEOUT_MS)
  }
  function startErrorTimer(): void {
    clearErrorTimer()
    errorTimer = setTimeout(() => {
      errorTimer = undefined
      pushRecomposed({ forceBusinessConnection: true })
    }, ERROR_TIMEOUT_MS)
  }

  /** 组合结果落点：transient 态启动 N1 回退 timer；业务态清 timer；同态不重推（幂等）。一律只经 push
   *  落到 controller.setState（N2）。 */
  function handleCompose(s: CharacterState): void {
    if (s === currentState) return
    if (isTransient(s)) {
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

  /** 重组合（C2 D5C-04）：按当前业务源重新组合并 push（handleCompose 全权管理 timer/去重）；退订后 no-op。 */
  function recompose(): void {
    if (stopped) return
    handleCompose(
      composeCharacterState({
        connection: sources.connection(),
        isGenerating: sources.isGenerating(),
        isSpeaking: sources.isSpeaking(),
        emotion: sources.emotion()
      })
    )
  }

  return {
    unsub: () => {
      stopped = true
      stop()
      clearMoodTimer()
      clearErrorTimer()
    },
    recompose
  }
}
