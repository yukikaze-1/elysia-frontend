// tests/unit/connection-liveness.spec.ts
//
// 2026-09-16 审计 P1-3 / 立项 AUD-01（方案 B）：客户端 WS 存活监视。
//
// 缺陷回顾：连接状态的唯一来源是 socket 的 `close`/`error`，而 half-open（NAT 超时、休眠唤醒、
// 对端 SIGKILL 未发 FIN）两者都不触发 ⇒ 界面停在**假 connected**：发送被静默吞掉、等满 ACK 超时
// 报成 `TIMEOUT`、且永不自动重连。报告建议的"发廉价 ping"**没有帧可复用**（协议两侧都无 ping/pong，
// 2026-09-16 复核），故本模块改用"这条 socket 还有没有收到过东西"+"宿主还能不能应答新请求"两条证据。
//
// 用**注入时钟 + 假 interval** 确定性驱动：真实 8s/120s 窗口无法在单测里等待，sleep 又慢又不可复现。
import { describe, expect, it, vi } from 'vitest'
import {
  createConnectionLiveness,
  LIVENESS_IDLE_PROBE_MS,
  LIVENESS_PROBE_COOLDOWN_MS,
  LIVENESS_REQUEST_GRACE_MS,
  type LivenessTimers
} from '../../src/main/transport/connection-liveness'

/** 手动驱动的 interval：记录待触发回调，可精确推进 */
function fakeTimers() {
  let nextHandle = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  const timers: LivenessTimers = {
    setInterval: (fn, ms) => { const h = nextHandle++; pending.set(h, { fn, ms }); return h },
    clearInterval: (h) => { pending.delete(h as number) }
  }
  return {
    timers,
    pendingCount: () => pending.size,
    delays: () => [...pending.values()].map((e) => e.ms),
    /**
     * 触发所有已注册的 tick。**不删除注册**——这是 interval 语义，不是 one-shot：
     * 早期版本在这里 `pending.delete(h)`，于是只有第一次 tick 生效、后续 tick 静默空转，
     * 把「节流后应再次探测」这类断言变成了永假的绿灯（本轮实测被这处测试装置本身绊了一次）。
     */
    tick(): void { for (const e of [...pending.values()]) e.fn() }
  }
}

function setup(over: { outstanding?: () => number; hostReachable?: boolean; probe?: () => Promise<{ hostReachable: boolean }> } = {}) {
  const clock = fakeTimers()
  let t = 1_000_000
  const onDead = vi.fn()
  const probe = vi.fn(over.probe ?? (async () => ({ hostReachable: over.hostReachable ?? true })))
  const liveness = createConnectionLiveness({
    now: () => t,
    timers: clock.timers,
    outstanding: over.outstanding ?? (() => 0),
    probe,
    onDead
  })
  return { liveness, onDead, probe, clock, advance: (ms: number) => { t += ms }, now: () => t }
}

/** 探测是异步的：推进时钟触发 tick 后需要把微任务/真实 I/O 放完 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('connection-liveness（AUD-01）', () => {
  it('start 起一个周期检查，stop 停表且之后不再回调', () => {
    const { liveness, clock } = setup()
    liveness.start()
    expect(liveness.isRunning()).toBe(true)
    expect(clock.pendingCount()).toBe(1)

    liveness.stop()
    expect(liveness.isRunning()).toBe(false)
    expect(clock.pendingCount()).toBe(0)
  })

  it('有在途请求 + 静默超过宽限期 + 宿主可达 ⇒ 判定该 socket 失效（half-open 的正面判据）', async () => {
    const { liveness, onDead, probe, clock, advance } = setup({ outstanding: () => 1, hostReachable: true })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    clock.tick()
    await flush()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(onDead).toHaveBeenCalledTimes(1)
    // 宿主可达却仍判死——这正是 half-open 的语义：新连接能通、旧连接不响
    expect(onDead).toHaveBeenCalledWith('request-unanswered')
  })

  it('有在途请求但**仍在宽限期内** ⇒ 不探测、不判死（慢 ACK 不得被误杀）', async () => {
    const { liveness, onDead, probe, clock, advance } = setup({ outstanding: () => 1 })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS - 1)
    clock.tick()
    await flush()

    expect(probe).not.toHaveBeenCalled()
    expect(onDead).not.toHaveBeenCalled()
  })

  it('空闲超过 idle 窗口但宿主可达 ⇒ **不判死**（后端空闲本来就不发东西，重连会造成抖动）', async () => {
    const { liveness, onDead, probe, clock, advance } = setup({ outstanding: () => 0, hostReachable: true })
    liveness.start()

    // 推进远超空闲阈值，连续多个 tick
    for (let i = 0; i < 3; i++) { advance(LIVENESS_IDLE_PROBE_MS); clock.tick(); await flush() }

    expect(probe, '空闲期仍应探测（用于发现宿主已死）').toHaveBeenCalled()
    expect(onDead, '宿主可达时空闲不是故障——绝不能因此重连').not.toHaveBeenCalled()
  })

  it('空闲且宿主不可达 ⇒ 判死（后端进程/主机没了，界面不得继续显示已连接）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 0, hostReachable: false })
    liveness.start()

    advance(LIVENESS_IDLE_PROBE_MS + 1)
    clock.tick()
    await flush()

    expect(onDead).toHaveBeenCalledWith('host-unreachable')
  })

  it('有在途请求且宿主不可达 ⇒ 判死为 host-unreachable（与 half-open 区分，便于诊断）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 1, hostReachable: false })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    clock.tick()
    await flush()

    expect(onDead).toHaveBeenCalledWith('host-unreachable')
  })

  it('收到任何帧即重置静默：半途有帧就不判死（正在流式输出的连接不得被误杀）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 1 })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS - 100)
    liveness.noteFrame()          // 后端刚发来一个 delta
    advance(LIVENESS_REQUEST_GRACE_MS - 100)
    clock.tick()
    await flush()

    expect(onDead).not.toHaveBeenCalled()
  })

  it('判死只回调一次（后续 tick 不得重复触发收敛）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 1, hostReachable: true })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    clock.tick(); await flush()
    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    clock.tick(); await flush()

    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('start 重置静默计时：上一代的静默时长不得跨代累积（重连后立刻被误判为死）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 1 })
    liveness.start()
    advance(LIVENESS_REQUEST_GRACE_MS * 10)   // 旧连接静默很久

    liveness.start()                          // 重连：重置
    clock.tick(); await flush()

    expect(onDead, '新连接必须从"刚有活动"起算').not.toHaveBeenCalled()
  })

  it('stop 之后即使 tick 仍在队列里也不回调（断开后不得再判死并触发重连）', async () => {
    const { liveness, onDead, clock, advance } = setup({ outstanding: () => 1 })
    liveness.start()
    const queued = clock
    liveness.stop()

    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    queued.tick(); await flush()   // 假定时器已被 clear，此处是空操作

    expect(onDead).not.toHaveBeenCalled()
  })

  it('探测有节流：cooldown 内不重复探测（探测本身是一条 REST 请求，不得变成流量尖峰）', async () => {
    // 用「空闲 + 宿主可达」这条不判死的路径来观察多次探测——它是唯一会重复探测的路径。
    const { liveness, onDead, probe, clock, advance } = setup({ outstanding: () => 0, hostReachable: true })
    liveness.start()

    advance(LIVENESS_IDLE_PROBE_MS + 1)
    clock.tick(); await flush()
    expect(probe).toHaveBeenCalledTimes(1)

    advance(LIVENESS_PROBE_COOLDOWN_MS - 1)
    clock.tick(); await flush()
    expect(probe, 'cooldown 内不得再探测').toHaveBeenCalledTimes(1)

    advance(2)
    clock.tick(); await flush()
    expect(probe, '过了 cooldown 才允许下一次').toHaveBeenCalledTimes(2)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('探测自身抛错视为不可达（fail-closed：宁可走重连也不留在假 connected）', async () => {
    const { liveness, onDead, clock, advance } = setup({
      outstanding: () => 1,
      probe: async () => { throw new Error('network blew up') }
    })
    liveness.start()

    advance(LIVENESS_REQUEST_GRACE_MS + 1)
    clock.tick(); await flush()

    expect(onDead).toHaveBeenCalledWith('host-unreachable')
  })

  it('生产常量之间的大小关系：宽限期必须小于 ACK 超时（15s），否则用户先看到假 TIMEOUT', () => {
    // 承重关系：requestGrace 若 ≥ ACK 超时，收敛就失去意义——用户已经先收到一次错误的超时归因。
    expect(LIVENESS_REQUEST_GRACE_MS).toBeLessThan(15_000)
    expect(LIVENESS_IDLE_PROBE_MS).toBeGreaterThan(LIVENESS_REQUEST_GRACE_MS)
  })
})
