// tests/unit/renderer-crash-contracts.spec.ts（node 环境）
import { describe, expect, it } from 'vitest'
import { RendererCrashEventSchema } from '../../src/shared/schemas/ipc-response'
import { IpcChannels, PushChannels } from '../../src/shared/contracts/ipc'
import type { RendererCrashEvent } from '../../src/shared/contracts/diagnostics'

describe('RendererCrashEventSchema（strict + reason 闭合枚举 + exitCode int）', () => {
  const base: RendererCrashEvent = { reason: 'crashed', exitCode: 1 }
  it('合法条目', () => {
    expect(RendererCrashEventSchema.safeParse(base).success).toBe(true)
    expect(RendererCrashEventSchema.safeParse({ ...base, reason: 'oom' }).success).toBe(true)
  })
  it('未知 reason 拒（闭合枚举）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, reason: 'garbage' }).success).toBe(false)
  })
  it('exitCode 非整数拒（.int()）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, exitCode: 1.5 }).success).toBe(false)
  })
  it('未知键拒（strict）', () => {
    expect(RendererCrashEventSchema.safeParse({ ...base, content: 'x' }).success).toBe(false)
  })
})

describe('IpcChannels.diagnosticsLastCrash（invoke）+ PushChannels.rendererCrash 占位', () => {
  it('invoke 键值 + push 占位', () => {
    expect(IpcChannels.diagnosticsLastCrash).toBe('diagnostics:last-crash')
    expect(PushChannels.rendererCrash).toBe('renderer:crash')
  })
  it('renderer:crash 不入 IpcChannels invoke 枚举（纯 push 占位）', () => {
    expect(Object.values(IpcChannels)).not.toContain('renderer:crash')
  })
})
