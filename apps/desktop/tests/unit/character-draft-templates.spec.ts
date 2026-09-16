// tests/unit/character-draft-templates.spec.ts
// `character-editor/draft-templates` 的判别力测试。
//
// 重点在**错误字符串的往返**：三个构造器生成 `[CODE] [backendCode=X] msg` 形态的消息，
// 而 `utils/public-error` 的 `parsePublicError` 正是它的逆。这条往返此前只被 store 集成用例
// 间接带过（断言的是最终 code），没有直接钉住「构造 → 解析」这一对。
import { describe, expect, it } from 'vitest'
import type { CharacterDetail } from '../../src/shared/contracts'
import { parsePublicError } from '../../src/renderer/src/utils/public-error'
import {
  draftFromDetail,
  emptyDraft,
  errorFromValidation,
  isRevisionConflict,
  isValidStatePolicy,
  missingApiError,
  offlineError,
  publicError
} from '../../src/renderer/src/character-editor/draft-templates'

function detail(): CharacterDetail {
  return {
    summary: { characterId: 'c1', displayName: '小夜', currentRevision: 3 },
    current: {
      revision: 3,
      displayName: '小夜',
      description: '描述',
      aliases: ['夜'],
      promptProfile: {
        corePersonality: '温柔', relationshipStyle: '亲密', emotionStyle: '细腻',
        speakingStyle: '轻', conversationInitiative: '主动', examples: ['例']
      },
      runtimeDefaults: {
        voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
        proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
      },
      presentation: {}
    }
  } as unknown as CharacterDetail
}

describe('emptyDraft：新建草稿骨架', () => {
  it('缺省名称为「新角色」，且各嵌套对象都是完整骨架（不是 undefined 占位）', () => {
    const draft = emptyDraft()
    expect(draft.displayName).toBe('新角色')
    expect(draft.aliases).toEqual([])
    expect(draft.promptProfile.examples).toEqual([])
    expect(draft.runtimeDefaults.emotion.idleExpressions).toEqual([])
    expect(draft.runtimeDefaults.proactive).toEqual({ enabled: false, intervalSeconds: 3600, triggers: [] })
    expect(draft.presentation).toEqual({})
  })

  it('显式名称生效；openingMessage 缺省**不带该键**（strict 草稿 schema 不接受多余键）', () => {
    expect(emptyDraft('自定义').displayName).toBe('自定义')
    expect(Object.prototype.hasOwnProperty.call(emptyDraft(), 'openingMessage')).toBe(false)
  })

  it('每次调用返回独立对象（改一份不影响另一份）', () => {
    const a = emptyDraft()
    const b = emptyDraft()
    a.aliases.push('x')
    expect(b.aliases).toEqual([])
  })
})

describe('draftFromDetail：详情 → 草稿', () => {
  it('拷贝当前内容（不取 summary），并深拷贝到独立对象', () => {
    const source = detail()
    const draft = draftFromDetail(source)
    expect(draft.displayName).toBe('小夜')
    expect(draft.description).toBe('描述')
    // 改草稿不得穿透到详情
    draft.aliases.push('污染')
    expect(source.current.aliases).toEqual(['夜'])
    draft.promptProfile.corePersonality = '改了'
    expect(source.current.promptProfile.corePersonality).toBe('温柔')
  })

  it('openingMessage 存在时带上；缺省时不带该键', () => {
    const withOpening = detail()
    ;(withOpening.current as { openingMessage?: string }).openingMessage = '你好'
    expect(draftFromDetail(withOpening).openingMessage).toBe('你好')
    expect(Object.prototype.hasOwnProperty.call(draftFromDetail(detail()), 'openingMessage')).toBe(false)
  })
})

describe('errorFromValidation / publicError：错误构造与解析往返', () => {
  it('校验结果 → PublicError 带出 issues 的副本（改原数组不影响 error）', () => {
    const issues = [{ path: 'displayName', code: 'REQUIRED', severity: 'error' as const, message: '必填' }]
    const error = errorFromValidation({ valid: false, issues })
    expect(error).toMatchObject({ code: 'BACKEND_REJECTED', backendCode: 'CHARACTER_VALIDATION', message: 'LOCAL:CHARACTER_VALIDATION' })
    expect(error.issues).toEqual(issues)
    issues.push({ path: 'x', code: 'REQUIRED', severity: 'error' as const, message: 'y' })
    expect(error.issues).toHaveLength(1)
  })

  it('publicError 用 parsePublicError 反解 Error.message（含 IPC 前缀形态）', () => {
    expect(publicError(new Error('[NOT_CONNECTED] 未连接')).code).toBe('NOT_CONNECTED')
    expect(publicError('[CHARACTER_REVISION_CONFLICT] 冲突').code).toBe('CHARACTER_REVISION_CONFLICT')
    expect(publicError(new Error('裸文本')).code).toBe('UNKNOWN')
  })
})

describe('isRevisionConflict：三种冲突码', () => {
  it.each([
    'CHARACTER_REVISION_CONFLICT',
    'CHARACTER_STATE_CONFLICT',
    'CHARACTER_STATE_VERSION_CONFLICT'   // D-2：mock 后端实发码
  ])('%s → true', (code) => {
    expect(isRevisionConflict({ code: 'BACKEND_REJECTED', backendCode: code, message: 'm' })).toBe(true)
  })

  it.each(['CHARACTER_BUSY', 'CHARACTER_VALIDATION', 'AGENT_BUSY', undefined])('%s → false', (code) => {
    expect(isRevisionConflict({ code: 'BACKEND_REJECTED', backendCode: code, message: 'm' })).toBe(false)
  })
})

describe('offlineError / missingApiError：与 parsePublicError 的往返', () => {
  it('offlineError 解析回 CHARACTER_OFFLINE 与 NOT_CONNECTED', () => {
    const parsed = parsePublicError(offlineError().message)
    expect(parsed.code).toBe('NOT_CONNECTED')
    expect(parsed.backendCode).toBe('CHARACTER_OFFLINE')
  })

  it('missingApiError 解析回 CHARACTER_PROFILES_UNAVAILABLE（两种占位都成立）', () => {
    for (const name of ['草稿保存', '草稿列表', '草稿恢复', '草稿删除']) {
      const parsed = parsePublicError(missingApiError(name).message)
      expect(parsed.code, name).toBe('CHARACTER_PROFILES_UNAVAILABLE')
      expect(parsed.backendCode, name).toBe('CHARACTER_PROFILES_UNAVAILABLE')
    }
  })
})

describe('isValidStatePolicy：两值白名单', () => {
  it('只接受 preserve / reset_evolution', () => {
    expect(isValidStatePolicy('preserve')).toBe(true)
    expect(isValidStatePolicy('reset_evolution')).toBe(true)
    expect(isValidStatePolicy('reset')).toBe(false)
    expect(isValidStatePolicy('')).toBe(false)
    expect(isValidStatePolicy('PRESERVE')).toBe(false)
  })
})
