// tests/unit/ipc-surface-alignment.spec.ts
// 门禁判别力批次（M-30 / P1-2）：把 IPC 的**三个面**放在一起对账——
//   ① 声明面 IpcChannels（shared/contracts/ipc.ts 的通道常量表）
//   ② 装配面 Main 实际注册的 handler（ipcMain.handle / ipcMain.on 的通道名，经 mock 捕获真实注册调用）
//   ③ 可达面 preload 真正 invoke/send 的通道（扫 src/preload/**/*.ts 的源码引用）
//
// 为什么需要这条门禁（此前三面各自为政，缺口无人覆盖）：
//  - tests/integration/ipc-security.spec.ts 只钉 preload 的**方法名字符串**集合（95 键），
//    它回答的是「暴露面有没有变大」，**不回答**「这些方法指向的通道 Main 到底注册了没有」；
//  - tests/unit/chat-handlers.spec.ts、model-handlers.spec.ts、voice-handlers.spec.ts 等各自只对账
//    自己模块注册的通道；
//  - 于是「通道在 IpcChannels 里声明了、preload 也在调、Main 却没人注册」这一类**功能永久坏掉**
//    的缺陷（调用方只会得到 Electron 的 "No handler registered for ..."）可以全门禁绿灯通过。
//    本仓库已发生过它的变体：ipc-security 的硬编码表曾长期停在 91 键、漏掉 `resetCharacterEvolution`，
//    于是唯一哨兵长期红灯、保护意义归零。
//
// 本轮的实测基线（2026-09-11，写入此处供下次漂移时对照）：三面**逐通道一一对应**，
// 声明 88 个 = Main 注册 88 个 = preload 引用 88 个（88 个引用点、88 个去重通道，即每通道恰好引用一次），
// 三张例外表均为空。也就是说本条门禁今天**没有发现任何违规**——它的价值是防未来漂移，
// 而不是解释现存缺陷；判别力由变异验证证明（见 doc 16 §3.1）。
//
// 判别力来源（刻意不做的事）：**不**从 IpcChannels 派生期望值。期望值来自另外两个面
// （mock 捕获的真实注册调用 + preload 源码文本），三者互为独立证据；派生会让断言恒真。
// 例外表同样是硬编码——它们的作用就是在漂移时逼一次人工确认，而不是自动跟随。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannels, PushChannels } from '@shared/contracts'

// —— electron mock：捕获 Main 侧真实注册调用（registry.ts 的 registerHandler / registerOneWayHandler）——
// 注意 registry.ts 内部还有模块级 `registered` Set（重复注册即抛），因此 registerHandlers 全文件只能调用一次。
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
  app: { getPath: (): string => 'C:/cyrene-surface-alignment' }, // 只喂 createSanitizePublicMessage，不触盘
  BrowserWindow: class {},
  ipcMain: mockIpcMain
}))

const { registerHandlers } = await import('../../src/main/ipc/handlers')

/**
 * 声明了、但当前装配**不**注册 handler 的通道（孤儿契约：有人声明、无人认领）。
 * 当前为空。非空必须在理由里写明为何允许存在。
 */
const DECLARED_BUT_UNREGISTERED: Record<string, string> = {}

/**
 * 注册了、但 preload 从不引用的通道（死 IPC 面：Main 挂着 handler，Renderer 永远调不到）。
 * 当前为空。刻意与下一张表分开——「契约还在但没人用」与「有人用但契约没接」是两种不同的缺陷。
 */
const UNREACHABLE_FROM_PRELOAD: Record<string, string> = {}

/**
 * preload 会调用、但 Main 没有 handler 的通道（**功能永久坏掉**，调用必然失败）。
 * 当前为空；本表的存在只为让「暂时停用某功能」这种情形有可记录的出口，正常修复路径是补 handler。
 */
const PRELOAD_WITHOUT_HANDLER: Record<string, string> = {}

/** 去掉注释但保留字符串内容：`cyrene://renderer` 这类字面量里的 `//` 不是注释，误删会吞掉同行引用 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue }
    out += ch
    i += 1
  }
  return out
}

/**
 * 扫整个 preload 目录（而非只扫 desktop-api.ts）：今天 88 个引用点全部在 desktop-api.ts，
 * 但把范围定在**整个可达面**，将来新增 preload 模块时门禁不用改也不会漏。
 */
function scanPreloadChannels(): Set<string> {
  const dir = join(__dirname, '../../src/preload')
  const channels = new Set<string>()
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.ts')).sort()) {
    const code = stripComments(readFileSync(join(dir, file), 'utf8'))
    for (const m of code.matchAll(/\bIpcChannels\.([A-Za-z0-9_]+)/g)) {
      const channel = IpcChannels[m[1] as keyof typeof IpcChannels]
      // 引用了 IpcChannels 上不存在的键：preload 侧写错名字（TS 之外的第二道，跨版本重命名时先红）
      if (typeof channel !== 'string') throw new Error(`${file} 引用了不存在的通道常量 IpcChannels.${m[1]}`)
      channels.add(channel)
    }
  }
  return channels
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

const declared = sorted(Object.values(IpcChannels))
const preloadChannels = sorted(scanPreloadChannels())

// 单一 `any` 断言块：本测试只关心 registerHandlers 的**注册调用**，不驱动任何 dep 的方法
// （各 register* 内的 handler 闭包都是惰性的，注册期不触碰 dep）。故只需形状占位。
// 刻意不用 Partial 逐字段伪造：那会随 deps 增长而失效，且此处并不验证 dep 行为。
const deps = {
  credentials: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  chat: {}, connectionConfig: {}, sessionStore: {},
  attachments: { svc: {}, media: {} }, models: { backend: {}, media: {} },
  settings: { svc: {} }, voice: { backend: {}, media: {} }, live2d: { registry: {} },
  tools: {}, grants: {}, auditDir: 'C:/cyrene-surface-alignment/audit',
  diagnostics: {}, characters: { service: {} }, characterDrafts: {},
  persistFlush: { request: vi.fn(), acknowledge: vi.fn() }
} as unknown as Parameters<typeof registerHandlers>[0]

registerHandlers(deps)

const mainChannels = sorted(mainRegistered)

/** 例外表自检：条目必须指向真实存在的通道面，且理由非空——文档必须与代码同真 */
function assertExceptionTable(table: Record<string, string>, universe: readonly string[], label: string): void {
  for (const [channel, reason] of Object.entries(table)) {
    expect(universe, `${label} 列了并不存在的通道 ${channel}`).toContain(channel)
    expect(reason.trim().length, `${label} 中 ${channel} 的例外理由不得为空`).toBeGreaterThan(0)
  }
}

describe('IPC 三面对齐（声明面 IpcChannels ↔ 装配面 Main handler ↔ 可达面 preload）', () => {
  it('声明面 ⇔ 装配面：每个声明过的通道都有人注册，且没有幽灵通道', () => {
    // 集合相等同时覆盖两个方向：多注册的通道（未声明）与漏注册的通道（声明却无人接）都会红。
    // 同时它也是**解析/装配退化哨兵**：registerHandlers 若整体没跑，mainChannels 为空集即红。
    expect(mainChannels).toEqual(declared.filter((c) => !(c in DECLARED_BUT_UNREGISTERED)))
  })

  it('装配面 ⇔ 可达面：preload 能调的通道都真的注册了，注册了的通道也都真的能被调', () => {
    const reachable = mainChannels.filter((c) => !(c in UNREACHABLE_FROM_PRELOAD))
    const invoked = preloadChannels.filter((c) => !(c in PRELOAD_WITHOUT_HANDLER))
    expect(invoked, 'preload 引用了 Main 未注册的通道 → 该功能调用必然失败（No handler registered）').toEqual(reachable)
  })

  it('可达面不得引用未声明通道（preload 侧写错名字）', () => {
    // scanPreloadChannels 内已对 «IpcChannels.X 键不存在» 直接抛错；此处补一层集合级断言，
    // 覆盖「键存在但值不在声明集合里」（例如有人手工写了通道字面量再混进集合）。
    expect(preloadChannels.filter((c) => !declared.includes(c))).toEqual([])
  })

  it('例外表自检：条目真实、理由非空（含检查器自身可红的正对照）', () => {
    // 2026-09-16 审计 P2：本用例原先在三张表**都为空**时循环体一次都不执行 ⇒ 零断言"通过"。
    // 空表不是"没问题"，而是"这条用例此刻什么都没验"——vitest 的 requireAssertions 门禁把它照出来了。
    // 故补两条正对照：合成的坏条目必须让检查器抛错，证明这个检查器真的会红而不是恒真。
    expect(() => assertExceptionTable({ 'no-such:channel': '理由' }, declared, 'synthetic')).toThrow()
    expect(() => assertExceptionTable({ [declared[0]]: '   ' }, declared, 'synthetic')).toThrow()
    // 真表的逐条校验（表非空时才产生断言；空表的"检查器有效"由上面两条正对照兜住）
    assertExceptionTable(DECLARED_BUT_UNREGISTERED, declared, 'DECLARED_BUT_UNREGISTERED')
    assertExceptionTable(UNREACHABLE_FROM_PRELOAD, mainChannels, 'UNREACHABLE_FROM_PRELOAD')
    assertExceptionTable(PRELOAD_WITHOUT_HANDLER, preloadChannels, 'PRELOAD_WITHOUT_HANDLER')
    // 豁免总数为 0（当前三面对齐 88=88=88、零豁免）。把这个数字钉住：新增任何豁免都必须显式改这一行，
    // 于是"悄悄给缺口开一张白名单"在 code review 里是可见的。
    expect(Object.keys(DECLARED_BUT_UNREGISTERED).length + Object.keys(UNREACHABLE_FROM_PRELOAD).length + Object.keys(PRELOAD_WITHOUT_HANDLER).length).toBe(0)
  })

  it('PushChannels 与命令面互不相交，且推送通道不得被注册成 invoke handler', () => {
    const push = sorted(Object.values(PushChannels))
    expect(push.filter((c) => declared.includes(c)), '同一通道名同时出现在推送表与命令表').toEqual([])
    expect(push.filter((c) => mainChannels.includes(c)), '推送通道被注册成了 Main handler（invoke 语义泄漏）').toEqual([])
  })
})
