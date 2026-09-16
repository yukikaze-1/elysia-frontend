// tests/unit/character-draft-patch.spec.ts
// `character-editor/draft-patch` 的判别力测试：JSON Pointer / dot-path 写入的守卫边界。
//
// 这些边界（`~0`/`~1` 反转义次序、原型污染三段名、数组越界、非自有属性叶子）此前内嵌在
// `character-editor.store.updateField` 里，582 行的 store spec 中**没有任何一条**直接打它们。
import { describe, expect, it } from 'vitest'
import { applyDraftPatch, parseDraftPath } from '../../src/renderer/src/character-editor/draft-patch'

interface Draft {
  displayName: string
  aliases: string[]
  promptProfile: { corePersonality: string; examples: string[] }
  presentation: Record<string, unknown>
}

function draft(): Draft {
  return {
    displayName: '小夜',
    aliases: ['夜', 'Yoru'],
    promptProfile: { corePersonality: '温柔', examples: ['a', 'b'] },
    presentation: {}
  }
}

describe('parseDraftPath', () => {
  it('斜杠开头按 JSON Pointer 解析；否则按点号分段', () => {
    expect(parseDraftPath('/promptProfile/corePersonality')).toEqual(['promptProfile', 'corePersonality'])
    expect(parseDraftPath('promptProfile.corePersonality')).toEqual(['promptProfile', 'corePersonality'])
  })

  it('JSON Pointer 转义：~1 → "/"、~0 → "~"，且 ~1 先于 ~0（次序承重）', () => {
    // 先 ~1 后 ~0：`~01` 必须解成 `~1`（若次序反了会解成 `/`）
    expect(parseDraftPath('/a~1b')).toEqual(['a/b'])
    expect(parseDraftPath('/a~0b')).toEqual(['a~b'])
    expect(parseDraftPath('/a~01b')).toEqual(['a~1b'])
  })

  it.each([
    ['__proto__', '/__proto__/polluted'],
    ['prototype', '/prototype/x'],
    ['constructor', '/constructor/x'],
    ['嵌套的 __proto__', '/promptProfile/__proto__/corePersonality'],
    ['空分段', '/promptProfile//x'],
    ['尾随空分段', '/promptProfile/'],
    ['点号路径里的 __proto__', '__proto__.polluted']
  ])('拒绝原型污染与空分段：%s', (_label, path) => {
    expect(parseDraftPath(path)).toBeUndefined()
  })
})

describe('applyDraftPatch：合法写入', () => {
  it('叶子是自有属性 → 写入并返回**新的**草稿对象（不改原对象）', () => {
    const before = draft()
    const next = applyDraftPatch(before, '/promptProfile/corePersonality', '活泼')
    expect(next?.promptProfile.corePersonality).toBe('活泼')
    expect(before.promptProfile.corePersonality).toBe('温柔')   // 原对象未被触碰
    expect(next).not.toBe(before)
  })

  it('数组元素按索引写入', () => {
    const next = applyDraftPatch(draft(), '/aliases/1', 'Yoru')
    expect(next?.aliases).toEqual(['夜', 'Yoru'])
  })

  it('点号路径与 JSON Pointer 等价', () => {
    expect(applyDraftPatch(draft(), 'displayName', '新名')?.displayName).toBe('新名')
    expect(applyDraftPatch(draft(), '/displayName', '新名')?.displayName).toBe('新名')
  })

  it('写入的值被深拷贝：调用方之后改动传入对象不影响草稿', () => {
    const payload = { themeColor: '#fff' }
    const next = applyDraftPatch(draft(), '/presentation', payload)
    expect(next?.presentation).toEqual({ themeColor: '#fff' })
    payload.themeColor = '#000'
    expect(next?.presentation).toEqual({ themeColor: '#fff' })
  })
})

describe('applyDraftPatch：拒绝路径必须**完全不改动**草稿', () => {
  it.each([
    ['未知叶子（非自有属性）', '/displayNameTypo'],
    ['未知中间层', '/nope/deeper'],
    ['数组越界（尾索引）', '/aliases/2'],
    ['数组负索引', '/aliases/-1'],
    ['数组非整数索引', '/aliases/1.5'],
    ['原型污染', '/__proto__/polluted'],
    ['原型污染（中间层）', '/promptProfile/__proto__/x'],
    ['穿过标量', '/displayName/nested']
  ])('%s → undefined', (_label, path) => {
    const before = draft()
    const snapshot = JSON.stringify(before)
    expect(applyDraftPatch(before, path, 'x')).toBeUndefined()
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('原型未被污染：拒绝 __proto__ 写入后 Object.prototype 上没有任何新键', () => {
    applyDraftPatch(draft(), '/__proto__/polluted', 'yes')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('数组索引 0 与 length-1 是合法边界（不是越界）', () => {
    expect(applyDraftPatch(draft(), '/aliases/0', 'A')?.aliases[0]).toBe('A')
    expect(applyDraftPatch(draft(), '/aliases/1', 'B')?.aliases[1]).toBe('B')
  })

  it('嵌套数组：examples 索引写入', () => {
    const next = applyDraftPatch(draft(), '/promptProfile/examples/0', '开场')
    expect(next?.promptProfile.examples).toEqual(['开场', 'b'])
  })
})
