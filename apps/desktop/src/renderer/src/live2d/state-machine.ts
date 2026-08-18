// apps/desktop/src/renderer/src/live2d/state-machine.ts
// 阶段 5 批次 B（Task 3，B1 状态机收敛表，spec §3.1）：CharacterStateMachine——Live2DController 的服务状态机。
// 纯逻辑类：无 Pinia、无 SDK 句柄，可在 node 单测直接驱动（收敛表全部转移）。
//
// 收敛表「事件→转入态→结束事件→回退态」（spec §3.1，D5B-05 消除二义性）：
//   | 触发事件            | 转入态              | 优先级 | 结束事件                          | 回退态       |
//   | connection 断开     | offline             | 0      | 重连 (reconnect)                  | idle         |
//   | 空闲（无活动）       | idle                | 0      | —（常态）                         | —            |
//   | 生成开始            | thinking            | 2      | 首个正文增量 / generation.completed | speaking/idle |
//   | 首个正文增量/TTS播放 | speaking            | 2      | generation.completed 或 TTS 停止   | idle         |
//   | mood 映射命中        | happy/sad/surprised | 1      | 时长上限或下一高优先事件            | 回原业务态   |
//   | 连接/生成/渲染错误   | error               | 3      | 错误清除或 ~3s                     | 回原业务态   |
//   | [阶段6] 工具等待/执行 | waiting_permission/working | 3/2 | [阶段6]                    | 回原业务态   |
//
// 规则：仅同/更高优先级事件可打断当前态（tryIntrude）；低优先级事件在高优先级态激活时丢弃（只保留最新，
// doc 05 §9）；结束事件（结束事件集）无条件回退到正确回退态（force/returnToBusiness，非一律 idle，
// D5B-05）；同态幂等（不重触发）。
//
// `listening/working/waiting_permission` 为定义完备的槽位（有优先级与收敛/回退），但本批驱动源 null
// （D5B-04）：不接线、不验收；其事件入口由本类保留，阶段 6 触发。
//
// 双入口：
//  - `onEvent(ev)`：事件驱动收敛表（含优先级仲裁与业务态回退）——纯状态机单测覆盖。
//  - `setState(s)`：Controller.setState 经此落进状态机——状态源（Task 4 live2dStateSource）已计算并仲裁
//    出最终 CharacterState（D5B-04 薄编排层），控制器直接采纳（source 权威；低散事件不再二次仲裁，
//    避免「source 已判定 speaking 却被仍在 3 级态 拦下」的清除死锁）。二者共享同一 current/business 状态。
//
// 业务态（businessState）：offline/idle/listening/thinking/speaking/working —— 进入时记录为回退基底；
// 瞬态（happy/sad/surprised/waiting_permission/error）保留进入前的业务态，结束时 returnToBusiness 回退。

export type CharacterState =
  | 'offline'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'waiting_permission'
  | 'working'
  | 'happy'
  | 'sad'
  | 'surprised'
  | 'error'

/** 优先级（spec §3.1 / doc 05 §6）：0=idle/offline；1=情绪（+listening 轻态）；2=speaking/working/thinking；
 *  3=error/waiting_permission */
export type StatePriority = 0 | 1 | 2 | 3

/** 状态→优先级查询（C3：state-source 建议强度仲裁 / live2dStore getCurrentPriority 注入复用） */
export function statePriority(s: CharacterState): StatePriority {
  return PRIORITY[s]
}

export type StateEvent =
  // 连接
  | 'disconnect'
  | 'reconnect'
  // 态态/常态
  | 'idle'
  // 生成 / 说话
  | 'generation_started'
  | 'first_content'
  | 'tts_start'
  | 'generation_completed'
  | 'tts_stop'
  // 情绪（本地映射命中）
  | 'mood_happy'
  | 'mood_sad'
  | 'mood_surprised'
  // 错误
  | 'error'
  | 'error_clear'
  // 槽位（本批驱动源 null，阶段 6）
  | 'listening_start'
  | 'listening_end'
  | 'working_start'
  | 'working_end'
  | 'waiting_permission_start'
  | 'waiting_permission_end'

const PRIORITY: Record<CharacterState, StatePriority> = {
  offline: 0,
  idle: 0,
  listening: 1,
  happy: 1,
  sad: 1,
  surprised: 1,
  thinking: 2,
  speaking: 2,
  working: 2,
  waiting_permission: 3,
  error: 3
}

/** 进入时同步为「回退基底」的业务态（稳定连接/会话/生成态）；瞬态（mood/error/waiting_permission 及
 *  slot 的 listening/working）不进此集合——其结束回退保留进入前的业务态（spec §3.1「回原业务态」） */
const BUSINESS_STATES: ReadonlySet<CharacterState> = new Set<CharacterState>([
  'offline',
  'idle',
  'thinking',
  'speaking'
])

export class CharacterStateMachine {
  private current: CharacterState
  private business: CharacterState

  constructor(initial: CharacterState = 'offline') {
    this.current = initial
    this.business = initial
  }

  get state(): CharacterState {
    return this.current
  }

  get priority(): StatePriority {
    return PRIORITY[this.current]
  }

  /** 事件驱动收敛表（含优先级仲裁与业务态回退）。返回转移后的当前态。 */
  onEvent(ev: StateEvent): CharacterState {
    switch (ev) {
      case 'disconnect':
        this.force('offline')
        break
      case 'reconnect':
        this.force('idle')
        break
      case 'idle':
        // 空闲常态：回退到 idle 基底（source/调度层判定无活动）
        this.force('idle')
        break
      case 'generation_started':
        this.tryIntrude('thinking')
        break
      case 'first_content':
      case 'tts_start':
        this.tryIntrude('speaking')
        break
      case 'generation_completed':
      case 'tts_stop':
        // 结束事件：无条件回到正确的回退态（非一律由业务态仲裁，D5B-05）
        this.force('idle')
        break
      case 'mood_happy':
        this.tryIntrude('happy')
        break
      case 'mood_sad':
        this.tryIntrude('sad')
        break
      case 'mood_surprised':
        this.tryIntrude('surprised')
        break
      case 'error':
        // 3 级：可打断任何低优先态（瞬态，回退保留进入前业务态）
        this.tryIntrude('error')
        break
      case 'error_clear':
        this.returnToBusiness()
        break
      case 'listening_start':
        this.tryIntrude('listening')
        break
      case 'listening_end':
      case 'working_end':
      case 'waiting_permission_end':
        this.returnToBusiness()
        break
      case 'working_start':
        this.tryIntrude('working')
        break
      case 'waiting_permission_start':
        this.tryIntrude('waiting_permission')
        break
    }
    return this.current
  }

  /** 直接落进状态源已仲裁的目标态（Controller.setState 入口）：幂等；业务态同步为回退基底。 */
  setState(s: CharacterState): CharacterState {
    if (s === this.current) return this.current
    this.current = s
    if (BUSINESS_STATES.has(s)) this.business = s
    return this.current
  }

  /** 瞬态结束回退到进入前的业务态（非一律 idle）；已在业务态则幂等保持。 */
  private returnToBusiness(): void {
    this.current = this.business
  }

  /** 强制转移（结束事件/常态基底）：同态幂等；业务态同步为回退基底。 */
  private force(target: CharacterState): void {
    if (this.current === target) return
    this.current = target
    if (BUSINESS_STATES.has(target)) this.business = target
  }

  /** 侵入式转移（优先级仲裁）：仅同/更高优先级可打断当前态（低不打断高，丢弃只保留最新）；同态幂等；
   *  业务态同步为回退基底。 */
  private tryIntrude(target: CharacterState): void {
    if (this.current === target) return
    if (PRIORITY[target] < PRIORITY[this.current]) return // 低优先级被高优先态丢弃
    this.current = target
    if (BUSINESS_STATES.has(target)) this.business = target
  }
}
