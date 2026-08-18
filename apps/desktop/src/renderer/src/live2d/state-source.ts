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
//   emotion（最后完成 assistant message .emotion）经 normalizeEmotionCode 本地归一（happy/sad/surprised）→ 对应
//   情绪态，未命中忽略（F-1：后端 mood 为 LLM 自由文本，中英文别名表见下）
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
import { statePriority, type CharacterState } from './state-machine'
import type { MoodEmotion } from './controller'

export interface Live2dStateSourceInputs {
  connection: () => ConnectionState
  isGenerating: () => boolean
  isSpeaking: () => boolean
  /** 最后完成 assistant message 的 `.emotion`（未知码忽略） */
  emotion: () => string | undefined
  /** 建议强度仲裁（C3）：当前机器优先级（生产 = live2dStore 注入真实 controller 优先级 getter；
   *  缺省读自身 currentState 优先级镜像——镜像在所有机器优先级变化时同步，含 client setState/指令 push） */
  getCurrentPriority?: () => number
  /** 指令瞬态结束回调（C3）：directiveOverride 超时或 client 2/3 级 watch 重组合覆盖时调用
   *  （live2dStore 经此清 directiveExpressionActive，恢复 emotion→表情自动映射） */
  onDirectiveEnd?: () => void
}

export type Live2dStateSourcePush = (s: CharacterState) => void

/** live2dStateSource 句柄（C2 D5C-04：GPU 重建后恢复 CharacterState 需 recompose 重组合） */
export interface Live2dStateSource {
  /** 退订：停 watch + 清 N1 mood/error 回退 timers（幂等） */
  unsub: () => void
  /** 重组合（GPU 重建后恢复当前 CharacterState）：按当前业务源重新组合并 push（经 handleCompose——瞬态重启
   *  超时 timer、business 态清 timer、同态不重推） */
  recompose: () => void
  /** 后端表现指令建议（C3）：按建议强度仲裁置入指令瞬态（directiveOverride）并 push；
   *  建议强度 < 当前机器优先级 → 丢弃（只记最新，不覆盖 client 2/3 级现实态）。
   *  @returns 是否实际置入指令瞬态（false = 建议强度不足被丢弃；store 据此决定是否抑制 emotion 自动映射） */
  pushDirective: (state: CharacterState, strength: number, durationMs?: number) => boolean
}

/** F-1（联调前整改清单）：后端 `generation.completed.mood` 为 LLM 自由文本（如「开心」「平静」），本地归一为
 *  `MoodEmotion` 枚举码。ASCII 大小写不敏感（`raw.toLowerCase()`）；中文按字面精确匹配（不 trim、不做标点/
 *  近义处理——真实联调发现新写法再扩表）。未命中 → `undefined`（落 idle，行为不变）。 */
const MOOD_EMOTION_ALIASES: Readonly<Record<MoodEmotion, readonly string[]>> = {
  happy: ['happy', '开心', '高兴', '愉快', '喜悦', '兴奋'],
  sad: ['sad', '难过', '悲伤', '伤心', '沮丧', '低落'],
  surprised: ['surprised', '惊讶', '惊喜', '吃惊', '诧异']
}

const MOOD_CODES: readonly MoodEmotion[] = ['happy', 'sad', 'surprised']

/** 归一后端 mood 自由文本 → `MoodEmotion`；未命中 → `undefined`。只做本地归一（不把未知码当动作/表达式名），
 *  CyLive2DPanel 中文徽标继续按目标态显示（happy→开心），此处不重复维护标签。 */
export function normalizeEmotionCode(raw: string | undefined): MoodEmotion | undefined {
  if (raw === undefined) return undefined
  const norm = raw.toLowerCase()
  for (const code of MOOD_CODES) {
    if (norm === code || MOOD_EMOTION_ALIASES[code].includes(norm)) return code
  }
  return undefined
}

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
  const mood = normalizeEmotionCode(emotion) // F-1：中/英文自由文本归一；未命中 undefined → idle
  if (mood !== undefined) return mood
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
  let currentPriorityMirror = 0 // C3：当前机器优先级镜像（每次 push 同步；缺省 getCurrentPriority 读它）
  let moodTimer: ReturnType<typeof setTimeout> | undefined
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false // 退订后 recompose no-op（防 teardown 后陈旧重组合误 push）
  // C3（后端表现指令建议）：directiveOverride = 指令瞬态（置入后作为当前组合态，超时/2-3 级覆盖时清除）
  let directiveOverride: { state: CharacterState; until: number } | undefined
  let directiveTimer: ReturnType<typeof setTimeout> | undefined

  function clearMoodTimer(): void {
    if (moodTimer) clearTimeout(moodTimer)
    moodTimer = undefined
  }
  function clearErrorTimer(): void {
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = undefined
  }
  function clearDirectiveTimer(): void {
    if (directiveTimer) clearTimeout(directiveTimer)
    directiveTimer = undefined
  }

  /** C3：统一落点——记录当前态 + 同步优先级镜像 + push（镜像在所有机器优先级变化时同步） */
  function applyPush(s: CharacterState): void {
    currentState = s
    currentPriorityMirror = statePriority(s)
    push(s)
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
    if (isTransient(s)) {
      if (s === 'error') startErrorTimer()
      else startMoodTimer()
    }
    applyPush(s)
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
   *  落到 controller.setState（N2）。
   *  C3：指令瞬态存活期间，仅 client 2/3 级现实态（priority ≥ 2）经 watch 重组合覆盖（重组合优先取 client
   *  现实态）；低优先（情绪 1 / idle 0 / offline 0）保持指令瞬态（指令是表现建议，不因情绪/空闲被抹掉）。 */
  function handleCompose(s: CharacterState): void {
    if (directiveOverride) {
      if (statePriority(s) < 2) return // 低优先组合不打断指令瞬态
      clearDirectiveTimer()
      directiveOverride = undefined
      sources.onDirectiveEnd?.() // client 2/3 级覆盖 → 通知 store 清 directiveExpressionActive
    }
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
    applyPush(s)
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

  /** 重组合（C2 D5C-04）：按当前业务源重新组合并 push（handleCompose 全权管理 timer/去重）；退订后 no-op。
   *  C3：指令瞬态存活期间，低优先重组合保持指令（handleCompose 内 guard）；2/3 级覆盖时清指令态。 */
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

  /** C3：后端表现指令建议置入。`strength = clamp01(≤1)`（越界钳 1）；入口守卫 `strength ≥ (getCurrentPriority
   *  ?.() ?? currentPriorityMirror)` 才置入 directiveOverride（否则丢弃——指令永不覆盖 client 2/3 级现实态，
   *  状态自然优先级只决定表现）。置入前 clearMoodTimer + clearErrorTimer（防旧 timer 提前 pushRecomposed 打断
   *  指令瞬态）；到 durationMs（缺省沿用对应态 N1 超时）→ pushRecomposed 回业务态；超时/2-3 级覆盖清指令态
   *  + onDirectiveEnd。 */
  function pushDirective(state: CharacterState, strength: number, durationMs?: number): boolean {
    const clamped = Math.min(1, Math.max(0, strength))
    const cur = sources.getCurrentPriority?.() ?? currentPriorityMirror
    if (clamped < cur) return false // 建议强度不足 → 丢弃（只记最新，不置入）
    clearMoodTimer()
    clearErrorTimer()
    clearDirectiveTimer()
    const timeoutMs =
      durationMs !== undefined ? Math.min(30000, Math.max(0, durationMs)) : directiveDefaultTimeout(state)
    directiveOverride = { state, until: Date.now() + timeoutMs }
    directiveTimer = setTimeout(() => {
      directiveTimer = undefined
      directiveOverride = undefined
      sources.onDirectiveEnd?.() // 指令瞬态超时 → 通知 store 清 directiveExpressionActive
      pushRecomposed({ emotion: undefined }) // 回业务态（指令瞬态结束，情绪不作为持久源）
    }, timeoutMs)
    applyPush(state)
    return true
  }

  return {
    unsub: () => {
      stopped = true
      stop()
      clearMoodTimer()
      clearErrorTimer()
      clearDirectiveTimer()
    },
    recompose,
    pushDirective
  }
}

/** C3：指令态缺省超时 = 对应态 N1 超时（happy/sad/surprised → MOOD_TIMEOUT_MS；error → ERROR_TIMEOUT_MS；
 *  error 已从 DirectiveState 剔除，此处仅为防御；idle/listening/thinking/speaking 非 N1 瞬态，沿用 MOOD 兜底） */
function directiveDefaultTimeout(state: CharacterState): number {
  return state === 'error' ? ERROR_TIMEOUT_MS : MOOD_TIMEOUT_MS
}
