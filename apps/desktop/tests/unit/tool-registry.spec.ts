import { describe, expect, it } from 'vitest'
import { createToolRegistry, TOOL_NAMES } from '../../src/main/tools/tool-registry'

describe('tool-registry', () => {
  it('四工具注册齐全（TOOL_NAMES 全含）', () => {
    const r = createToolRegistry()
    for (const name of TOOL_NAMES) expect(r.has(name)).toBe(true)
    expect(r.size).toBe(4)
  })
  it('未知名 → 无定义', () => { expect(createToolRegistry().has('desktop.command.run')).toBe(false) })
  it('inputSchema strict 拒未知字段 + 缺必填', () => {
    const r = createToolRegistry()
    expect(r.get('desktop.file.read')!.inputSchema.safeParse({ path: '/a', extra: 1 }).success).toBe(false)
    expect(r.get('desktop.file.read')!.inputSchema.safeParse({}).success).toBe(false)
  })
  it('capture inputSchema 放行 region:null（H1/M-6）', () => {
    expect(createToolRegistry().get('desktop.screen.capture')!.inputSchema.safeParse({ region: null }).success).toBe(true)
  })
  it('permissionMode/localRisk 映射闭合（D6B-03）', () => {
    const r = createToolRegistry()
    expect(r.get('desktop.file.select')!.permissionMode).toBe('automatic')
    expect(r.get('desktop.file.read')!.permissionMode).toBe('scoped_or_prompt')
    expect(r.get('desktop.file.write')!.permissionMode).toBe('always_prompt')
    expect(r.get('desktop.screen.capture')!.permissionMode).toBe('always_prompt')
    expect(r.get('desktop.file.select')!.localRisk).toBe('safe')
    expect(r.get('desktop.file.write')!.localRisk).toBe('high')
  })
})
