// tests/unit/character-identity.spec.ts
// H-06/H-07 结构性修法（2026-09-11）：角色状态身份判据的唯一来源。
//
// 背景：这条「三方相等」规则此前在仓库里有两份副本，反应还不同
// （store 抛 `CHARACTER_STATE_IDENTITY_MISMATCH`；组件返回 undefined）。
// 两份各自演化就会出现「一个入口拦截、另一个入口放行」的裂缝——而本项的两个**确定性**缺陷
// （修订号不跟随、自建角色无状态）正是长期潜伏在这类裂缝里。现收敛为 `characterIdentityMismatch`。
//
// 本 spec 钉住三件事：三个字段**逐个**都能触发不匹配（漏一个就是裂缝）、判据顺序稳定（可诊断）、
// 以及两个消费点的**反应差异**被保留（store 抛错 / 组件返回空 —— 不应被"统一"掉）。
import { describe, expect, it } from 'vitest'
import {
  characterIdentityMatches,
  characterIdentityMismatch,
  type CharacterIdentityExpectation
} from '../../src/renderer/src/utils/character-identity'

const EXPECTED: CharacterIdentityExpectation = {
  characterId: 'builtin/elysia',
  characterInstanceId: 'instance-elysia',
  characterRevision: 2
}

function stateOf(over: Partial<{ characterId: string; characterInstanceId: string; characterRevision: number }> = {}) {
  return { characterId: EXPECTED.characterId, characterInstanceId: EXPECTED.characterInstanceId, characterRevision: EXPECTED.characterRevision, ...over }
}

describe('characterIdentityMismatch（H-06/H-07 唯一判据）', () => {
  it('三者全等 → 无 mismatch（匹配）', () => {
    expect(characterIdentityMismatch(stateOf(), EXPECTED)).toBeUndefined()
    expect(characterIdentityMatches(stateOf(), EXPECTED)).toBe(true)
  })

  it('**逐个字段**都能触发不匹配——漏掉任何一个就是裂缝', () => {
    // 这三条是本 spec 的核心：任一条被删（判据漏字段）即变红。
    expect(characterIdentityMismatch(stateOf({ characterId: 'builtin/cyrene' }), EXPECTED)).toBe('characterId')
    expect(characterIdentityMismatch(stateOf({ characterInstanceId: 'instance-cyrene' }), EXPECTED)).toBe('characterInstanceId')
    expect(characterIdentityMismatch(stateOf({ characterRevision: 3 }), EXPECTED)).toBe('characterRevision')
  })

  it('修订号不匹配是**真实发生过的缺陷形态**（rev 落后 ⇒ 必须被判为不匹配）', () => {
    // mock 后端的旧缺陷：状态修订号永不跟随角色推进，于是 activeState 的 rev 永远落后于绑定。
    // 判据必须在**两个方向**都不等（不能只查"状态比期望旧"）。
    expect(characterIdentityMismatch(stateOf({ characterRevision: 1 }), EXPECTED)).toBe('characterRevision')
    expect(characterIdentityMismatch(stateOf({ characterRevision: 9 }), EXPECTED)).toBe('characterRevision')
  })

  it('多字段同时不符时返回**固定顺序**的第一个（id → instance → revision，便于稳定断言与诊断）', () => {
    const allWrong = { characterId: 'x', characterInstanceId: 'y', characterRevision: 99 }
    expect(characterIdentityMismatch(allWrong, EXPECTED)).toBe('characterId')
  })

  it('布尔形式与判据同源（不得出现第二套判断）', () => {
    expect(characterIdentityMatches(stateOf({ characterRevision: 3 }), EXPECTED)).toBe(false)
    expect(characterIdentityMatches(stateOf({ characterId: 'other' }), EXPECTED)).toBe(false)
  })

  it('只读入参（纯函数：不得修改传入对象）', () => {
    const state = stateOf({ characterRevision: 3 })
    const snapshot = JSON.stringify(state)
    characterIdentityMismatch(state, EXPECTED)
    expect(JSON.stringify(state), '判据必须是纯函数').toBe(snapshot)
  })
})

describe('两个消费点的**反应差异**被保留（规则一处、反应各异）', () => {
  it('组件侧用的**同一判据**语义一致（避免两处再分叉）', () => {
    // 组件的反应（渲染空）由 cy-character-public-state.spec.ts 覆盖；
    // store 的反应（抛错 + 字段名）由 character-runtime.store.spec.ts 覆盖。
    // 本文件只钉住两者共用的是**同一个**判据函数，而不是各自又抄一份。
    expect(characterIdentityMatches(stateOf(), EXPECTED)).toBe(true)
    expect(characterIdentityMatches(stateOf({ characterRevision: 1 }), EXPECTED)).toBe(false)
    // 布尔形式与「取失配字段」形式必须同源：任意输入下结论一致
    for (const over of [{}, { characterId: 'x' }, { characterInstanceId: 'y' }, { characterRevision: 0 }]) {
      const s = stateOf(over)
      expect(characterIdentityMatches(s, EXPECTED)).toBe(characterIdentityMismatch(s, EXPECTED) === undefined)
    }
  })
})
