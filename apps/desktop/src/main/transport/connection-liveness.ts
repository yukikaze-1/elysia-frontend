// apps/desktop/src/main/transport/connection-liveness.ts
//
// 2026-09-16 审计 P1-3 / 立项 AUD-01（方案 B，见 docs/review/2026-09-16-三项待设计立项的方案与代价.md）。
//
// 问题：`real-backend` 原本**没有任何客户端存活探测**——连接状态的唯一来源是 socket 的 `close`/`error`。
// half-open（NAT 表过期、休眠唤醒、链路静默断开、对端被 SIGKILL 未发 FIN）两者都不触发，于是界面
// 长期停在**假 `connected`**：发送被 `ws.send` 静默吞掉、等满 ACK 超时后报成 `TIMEOUT`（用户看到的是
// 超时而非断线），且不会自动重连（`close` 从未发生）。
//
// ⚠️ 报告建议的「每 20–30s 发一次廉价 ping」**没有现成帧可复用**：协议两侧都没有 `ping`/`pong`
// （前端全仓 + 权威后端 grep 均 0 命中，2026-09-16 复核）。故本模块**不向 WS 发任何东西**，
// 而是用「本 socket 是否还收到过东西」+「宿主是否还能应答一条新的 REST 请求」两条独立证据判定。
//
// 判据（两条，都只在**有意义**时触发，不做无谓探测）：
//   ① 有在途请求（等 ACK）且距最后一帧已超过 `requestGraceMs` ⇒ 探测宿主：
//      宿主可达 ⇒ 这条 socket 已死（新连接能通、旧连接不响）⇒ 判失活；
//      宿主不可达 ⇒ 判失活（后端进程/主机没了）。
//   ② 完全空闲超过 `idleProbeMs` ⇒ 探测宿主：不可达 ⇒ 判失活；**可达则什么都不做**。
//
// 为什么 ② 不重连：后端空闲时本来就不发任何东西，若按静默无条件判死会造成持续连接抖动。
// 代价是「空闲期half-open 不会被立刻发现」——但那正是无害的场景；一旦用户真的发消息，
// ① 会在 ACK 超时**之前**发现并收敛，把"报超时"变成"自动重连"。
//
// 为什么纯模块 + 注入依赖：沿用本仓既有先例（`utils/generation-watchdog.ts`、`main/persistence/persist-flush.ts`），
// 使「探测节流」「到期只触发一次」「空闲不重连」「stop 后不再回调」这些边界可由单测确定性钉住，不必起真 socket。

/** 可注入定时器：单测用假定时器确定性驱动，不 sleep */
export interface LivenessTimers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface LivenessProbeResult {
  /** 宿主是否可达（任意 HTTP 响应码都算可达：能应答就说明进程与网络路径在） */
  hostReachable: boolean
}

export interface ConnectionLiveness {
  /** 建立/重建连接时调用：重置计时并起周期检查（重复调用等价于重置，便于重连复用） */
  start(): void
  /** 断开/退役时调用：停表。之后不再有任何回调 */
  stop(): void
  /** 任何入站字节（文本或二进制帧都算）——证明这条 socket 还活着 */
  noteFrame(): void
  /** 当前是否在监视 */
  isRunning(): boolean
  /** 供单测/诊断：最后一次收到帧的时刻 */
  lastFrameAt(): number | undefined
}

/**
 * 默认参数取值依据：
 * - `requestGraceMs = 8_000`：必须**小于** ACK 超时（`ACK_TIMEOUT_DEFAULT_MS = 15000`），
 *   否则用户已经先看到一次假的 `TIMEOUT` 了，收敛就失去意义。后端的 ACK 是收到即回（不含模型推理），
 *   8s 对慢网络也足够宽松。
 * - `idleProbeMs = 120_000`：空闲期只是"顺手确认宿主还在"，不必频繁。
 * - `tickMs = 2_000`：检查是纯内存比较，勤一点无成本；真正的探测受 `probeCooldownMs` 节流。
 * - `probeCooldownMs = 30_000`：探测本身是一条 REST 请求，两次之间至少隔这么久，且同一时刻只允许一条在途。
 */
export const LIVENESS_REQUEST_GRACE_MS = 8_000
export const LIVENESS_IDLE_PROBE_MS = 120_000
export const LIVENESS_TICK_MS = 2_000
export const LIVENESS_PROBE_COOLDOWN_MS = 30_000

export type LivenessDeathReason = 'request-unanswered' | 'host-unreachable'

export function createConnectionLiveness(opts: {
  /** 当前在途、仍在等后端回执的请求数（真实装配传 `pendingAcks.size`） */
  outstanding(): number
  /** 探测宿主可达性（真实装配用一条只读 REST；失败必须 resolve 成 `{hostReachable:false}`，不得抛） */
  probe(): Promise<LivenessProbeResult>
  /** 判定失活——调用方负责走**既有**的收敛/重连路径（本模块不碰 socket） */
  onDead(reason: LivenessDeathReason): void
  now(): number
  timers?: LivenessTimers
  requestGraceMs?: number
  idleProbeMs?: number
  tickMs?: number
  probeCooldownMs?: number
}): ConnectionLiveness {
  const timers: LivenessTimers = opts.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
  }
  const requestGraceMs = opts.requestGraceMs ?? LIVENESS_REQUEST_GRACE_MS
  const idleProbeMs = opts.idleProbeMs ?? LIVENESS_IDLE_PROBE_MS
  const tickMs = opts.tickMs ?? LIVENESS_TICK_MS
  const probeCooldownMs = opts.probeCooldownMs ?? LIVENESS_PROBE_COOLDOWN_MS

  let handle: unknown
  let running = false
  let lastFrame: number | undefined
  let lastProbeAt: number | undefined
  let probing = false
  /** 判死只回调一次：收敛后到 stop/start 之前不得重复触发 */
  let declaredDead = false

  async function runProbe(reason: LivenessDeathReason): Promise<void> {
    if (probing) return // 同一时刻只允许一条在途探测
    probing = true
    lastProbeAt = opts.now()
    let reachable = false
    try {
      reachable = (await opts.probe()).hostReachable
    } catch {
      // 探测本身抛错视为不可达（fail-closed：宁可判死走重连，也不留在假 connected）
      reachable = false
    } finally {
      probing = false
    }
    if (!running || declaredDead) return // 探测期间已 stop 或已判死：不得再动作
    if (!reachable) {
      declaredDead = true
      opts.onDead('host-unreachable')
      return
    }
    if (reason === 'request-unanswered') {
      // 宿主能应答新连接，但这条 socket 在宽限期内一个字节都没回 ⇒ 这就是 half-open
      declaredDead = true
      opts.onDead('request-unanswered')
    }
    // reason === 'host-unreachable' 且宿主可达：空闲期的正常情形（后端不发东西而已）。
    // **有意什么都不做、也不留日志**——空闲连接每 30s 打一行会把日志变成噪声，
    // 而真正的动作（判死并收敛）只在上面两条分支发生。
  }

  function tick(): void {
    if (!running || declaredDead) return
    const now = opts.now()
    const silentFor = lastFrame === undefined ? 0 : Math.max(0, now - lastFrame)
    const outstanding = opts.outstanding()
    const wantProbe = outstanding > 0 ? silentFor >= requestGraceMs : silentFor >= idleProbeMs
    if (!wantProbe) return
    if (lastProbeAt !== undefined && now - lastProbeAt < probeCooldownMs) return
    void runProbe(outstanding > 0 ? 'request-unanswered' : 'host-unreachable')
  }

  return {
    start(): void {
      if (handle !== undefined) timers.clearInterval(handle)
      running = true
      declaredDead = false
      probing = false
      lastProbeAt = undefined
      lastFrame = opts.now() // 新连接从"刚收到活动"起算：不得让上一代的静默时长跨代累积
      handle = timers.setInterval(tick, tickMs)
    },
    stop(): void {
      running = false
      if (handle !== undefined) { timers.clearInterval(handle); handle = undefined }
    },
    noteFrame(): void { lastFrame = opts.now() },
    isRunning: () => running,
    lastFrameAt: () => lastFrame
  }
}
