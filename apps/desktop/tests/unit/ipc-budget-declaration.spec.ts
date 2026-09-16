// tests/unit/ipc-budget-declaration.spec.ts
// P1-1（2026-09-11）：把「单一收口」从路由点提升为**可枚举、可断言**的声明。
//
// 背景（评审核实）：doc 07 §6.3 声明「单条 IPC ≤ MAX_IPC_MESSAGE_BYTES（4 MiB）」为全局不变量，
// 但 `registry.ts` 只校验 arity（不查大小），实际只有 `session-store` 一处执行它；
// 而 `ipc-limit.spec.ts` 只断言常量值本身。于是「谁能守住这条不变量」取决于每个 handler 作者
// **是否记得**自己加校验——漏掉既不会红、也无处可查，是**无证缺口**而非已知取舍。
//
// 本用例把缺口变成红灯：**枚举实际注册的通道**（经 electron mock 捕获真实注册调用，与
// `ipc-surface-alignment.spec.ts` 同款手法，不复用手写清单以免恒真），逐个核对它是否在
// `IPC_CHANNEL_BUDGETS` 里声明了规模上界（字节预算 / 字段级 schema 上界 / 无载荷三类之一）。
//
// 为什么不给 registerHandler 加运行时遍历（报告的另一条路）：逐次 invoke 做结构化遍历是
// **O(size) 每调用**，热通道（audio-chunk、streaming 相关）需要额外门控；而"枚举 + 断言声明"
// 零运行时成本，且同样能挡住"忘记"——报告本身也把后者列为推荐先做的一条。
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels, MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import {
  GLOBAL_IPC_INVARIANT_BYTES,
  IPC_CHANNEL_BUDGETS,
  summarizeChannelBudgets
} from '../../src/main/ipc/channel-budgets'

const { mockIpcMain, mainRegistered } = vi.hoisted(() => {
  const registered = new Set<string>()
  return {
    mockIpcMain: {
      handle: vi.fn((channel: string) => { registered.add(channel) }),
      on: vi.fn((channel: string) => { registered.add(channel) })
    },
    mainRegistered: registered
  }
})
vi.mock('electron', () => ({
  app: { getPath: (): string => 'C:/cyrene-budget-declaration' },
  BrowserWindow: class {},
  ipcMain: mockIpcMain
}))

const { registerHandlers } = await import('../../src/main/ipc/handlers')

// 单次注册（registry 内部有重复注册守卫，故全文件只调用一次）
const deps = {
  credentials: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  chat: {}, connectionConfig: {}, sessionStore: {},
  attachments: { svc: {}, media: {} }, models: { backend: {}, media: {} },
  settings: { svc: {} }, voice: { backend: {}, media: {} }, live2d: { registry: {} },
  tools: {}, grants: {}, auditDir: 'C:/cyrene-budget-declaration/audit',
  diagnostics: {}, characters: { service: {} }, characterDrafts: {},
  persistFlush: { request: vi.fn(), acknowledge: vi.fn() }
} as unknown as Parameters<typeof registerHandlers>[0]

registerHandlers(deps)

const declared = new Set(Object.keys(IPC_CHANNEL_BUDGETS))

describe('IPC 通道预算声明（P1-1）', () => {
  it('每个**实际注册**的通道都在声明表里登记（未登记即红灯，这是本表存在的全部意义）', () => {
    const registered = [...mainRegistered].sort()
    // 退化哨兵：注册面为空说明 mock 捕获失效，此时下面的差集会恒空
    expect(registered.length, '未捕获到任何注册通道——mock 或装配已失效').toBeGreaterThan(50)

    const undeclared = registered.filter((channel) => !declared.has(channel))
    expect(undeclared, `以下通道未在 IPC_CHANNEL_BUDGETS 声明规模上界（新增通道必须登记）：\n${undeclared.join('\n')}`).toEqual([])
  })

  it('声明表里没有已无人注册的条目（防反向漂移：通道删了却留声明）', () => {
    const stale = [...declared].filter((channel) => !mainRegistered.has(channel))
    expect(stale, `IPC_CHANNEL_BUDGETS 中已无对应注册通道的条目（可删除）：\n${stale.join('\n')}`).toEqual([])
  })

  it('所有声明键都是真实的通道名（拼错即红灯——否则声明会挂在一个不存在的通道上）', () => {
    const known = new Set<string>(Object.values(IpcChannels))
    const unknown = [...declared].filter((channel) => !known.has(channel))
    expect(unknown, `声明表含非法通道名：\n${unknown.join('\n')}`).toEqual([])
  })

  it('任何字节预算都不得超过全局不变量 4 MiB（局部围栏不得比全局更宽）', () => {
    expect(GLOBAL_IPC_INVARIANT_BYTES).toBe(MAX_IPC_MESSAGE_BYTES)
    const over = Object.entries(IPC_CHANNEL_BUDGETS)
      .filter(([, b]) => b.kind === 'bytes' && b.maxBytes > MAX_IPC_MESSAGE_BYTES)
      .map(([channel, b]) => `${channel}: ${(b as { maxBytes: number }).maxBytes}`)
    expect(over, `以下通道声明的预算超过全局不变量：\n${over.join('\n')}`).toEqual([])
  })

  it('字节类声明必须为正整数且注明执行点（否则声明无从核对）', () => {
    for (const [channel, budget] of Object.entries(IPC_CHANNEL_BUDGETS)) {
      if (budget.kind !== 'bytes') continue
      expect(Number.isSafeInteger(budget.maxBytes) && budget.maxBytes > 0, `${channel} 的 maxBytes 非法`).toBe(true)
      expect(budget.enforcedAt.trim().length, `${channel} 必须注明执行点`).toBeGreaterThan(0)
    }
  })

  it('每个字节类声明都指明**谁来度量**（json=路由点 / handler=二进制，安全边界而非实现细节）', () => {
    // P1-1 运行时收口后，measure 决定路由点是否对该通道做 JSON 度量。
    // 漏填/填错会把二进制载荷送进 JSON.stringify——实测 1 MiB Uint8Array 需 114ms 且膨胀 10.9×。
    const kinds = new Set<string>()
    for (const [channel, budget] of Object.entries(IPC_CHANNEL_BUDGETS)) {
      if (budget.kind !== 'bytes') continue
      expect(['json', 'handler'], `${channel} 的 measure 取值非法`).toContain(budget.measure)
      kinds.add(budget.measure)
    }
    expect(kinds.size, '两类度量都应存在（全为 json 说明二进制通道被漏标）').toBe(2)
  })

  it('schema 类声明必须写明依据（"没有独立预算"必须是明确判断，不是省略）', () => {
    for (const [channel, budget] of Object.entries(IPC_CHANNEL_BUDGETS)) {
      if (budget.kind !== 'schema') continue
      expect(budget.note.trim().length, `${channel} 的 schema 依据不得为空`).toBeGreaterThan(0)
    }
  })

  it('声明覆盖面可读（三类计数之和 = 全部通道，便于诊断"未声明"是否在增长）', () => {
    const s = summarizeChannelBudgets()
    expect(s.bytes + s.schema + s.none, '三类计数必须覆盖全部条目').toBe(declared.size)
    expect(s.bytes, '至少应有若干条真正的字节预算（全为 none/schema 说明本表退化了）').toBeGreaterThan(0)
  })

  it('报告点名的两个实例在表中如实标注（回归：H-01/M-03 的根因不得被"声明"掩盖）', () => {
    // 附件链的路径黑名单曾 0 次调用、IPC 大小只在 session-store 一处执行——这两条都已登记执行点，
    // 本用例钉住"它们确实被显式声明过"，防止将来有人把表改成一律 'none' 了事。
    expect(IPC_CHANNEL_BUDGETS['chat:cache-messages']?.kind).toBe('bytes')
    expect(IPC_CHANNEL_BUDGETS['attachments:upload']?.kind).toBe('bytes')
    expect(IPC_CHANNEL_BUDGETS['voice:audio-chunk']?.kind).toBe('bytes')
  })
})
