// tests/unit/clipboard.spec.ts —— copyText：navigator.clipboard 优先 + execCommand 兜底（依赖注入，spec §4.6.1）。
import { describe, expect, it, vi } from 'vitest'
import { copyText } from '../../src/renderer/src/utils/clipboard'

describe('copyText', () => {
  it('navigator.clipboard.writeText 优先', async () => {
    const writeText = vi.fn(async () => {})
    const env = { navigator: { clipboard: { writeText } } }
    await expect(copyText('hi', env)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hi')
  })
  it('clipboard 抛错 → execCommand 兜底（document 注入）', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied') })
    const execCommand = vi.fn(() => true)
    const doc = { createElement: () => ({ value: '', setAttribute: vi.fn(), style: {}, select: vi.fn(), remove: vi.fn() }), body: { appendChild: vi.fn(), removeChild: vi.fn() }, execCommand } as never
    await expect(copyText('hi', { navigator: { clipboard: { writeText } }, document: doc })).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })
  it('无 clipboard 无 document → false', async () => {
    await expect(copyText('hi', {})).resolves.toBe(false)
  })
})
