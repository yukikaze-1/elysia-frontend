// renderer/src/character-editor/draft-templates.ts
// 角色编辑器的草稿模板与错误构造（无 Vue / 无 Pinia）。
//
// 为什么单独存在：这些是编辑器会话的**输入侧纯函数**（空草稿骨架、详情 → 草稿映射、
// 校验结果/异常 → `PublicError`、冲突码判定）。此前它们已在 `character-editor.store` 的模块作用域里
// （即本来就无响应性依赖），但与 store 同文件使它们只能经 store 集成用例到达；
// 其中三个错误构造器还会生成 `[CODE] [backendCode=X] msg` 形态的字符串，而 `utils/public-error`
// 的解析正是它的逆——这条往返此前没有直接断言。
import type {
  CharacterDetail,
  CharacterDraft,
  CharacterStatePolicy,
  CharacterValidationResult
} from '@shared/contracts'
import { cloneValue } from '@shared/domain'
import { parsePublicError, type PublicError } from '../utils/public-error'

/** 新建草稿骨架（`displayName` 缺省为「新角色」）。 */
export function emptyDraft(displayName = '新角色'): CharacterDraft {
  return {
    displayName,
    description: '',
    aliases: [],
    promptProfile: {
      corePersonality: '', relationshipStyle: '', emotionStyle: '', speakingStyle: '',
      conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: {}, emotion: { idleExpressions: [] }, wakeWords: [],
      proactive: { enabled: false, intervalSeconds: 3600, triggers: [] }
    },
    presentation: {}
  }
}

/**
 * 角色详情 → 可编辑草稿（深拷贝）。
 *
 * `openingMessage` 缺省时**不带该键**（而不是带 undefined）：`CharacterDraftSchema` 是 strict 的，
 * 多一个值为 undefined 的可选键在部分路径上会被判成多余字段。
 */
export function draftFromDetail(detail: CharacterDetail): CharacterDraft {
  const current = detail.current
  return cloneValue({
    displayName: current.displayName,
    description: current.description,
    aliases: current.aliases,
    promptProfile: current.promptProfile,
    runtimeDefaults: current.runtimeDefaults,
    presentation: current.presentation,
    ...(current.openingMessage !== undefined ? { openingMessage: current.openingMessage } : {})
  })
}

/** 后端校验结果 → 可供 UI 展示的 `PublicError`（issues 一并带出，供校验面板逐条渲染）。 */
export function errorFromValidation(result: CharacterValidationResult): PublicError {
  return {
    code: 'BACKEND_REJECTED',
    backendCode: 'CHARACTER_VALIDATION',
    message: 'LOCAL:CHARACTER_VALIDATION',
    issues: cloneValue(result.issues)
  }
}

/**
 * 已知冲突码三种：`CHARACTER_REVISION_CONFLICT`／`CHARACTER_STATE_CONFLICT`／
 * `CHARACTER_STATE_VERSION_CONFLICT`（D-2 2026-09-15：mock 后端实际发带 VERSION 的码，此前未认）。
 */
export function isRevisionConflict(error: PublicError): boolean {
  return error.backendCode === 'CHARACTER_REVISION_CONFLICT' || error.backendCode === 'CHARACTER_STATE_CONFLICT'
    || error.backendCode === 'CHARACTER_STATE_VERSION_CONFLICT'
}

/** 任意异常 → `PublicError`（`parsePublicError` 的 message 口径统一收口）。 */
export function publicError(cause: unknown): PublicError {
  return parsePublicError(cause instanceof Error ? cause.message : String(cause))
}

/** 未连接：角色远端操作**不排队**（fail-closed，而不是静默丢弃）。 */
export function offlineError(): Error {
  return new Error('[NOT_CONNECTED] [backendCode=CHARACTER_OFFLINE] 当前未连接，角色远端操作不会排队')
}

/** 能力未装配（preload 未提供该具名方法）。 */
export function missingApiError(name: string): Error {
  return new Error(`[CHARACTER_PROFILES_UNAVAILABLE] [backendCode=CHARACTER_PROFILES_UNAVAILABLE] 角色${name} API 尚未装配`)
}

/** 状态策略的两值白名单（越界一律拒绝，不做「default 分支」静默接受）。 */
export function isValidStatePolicy(policy: string): policy is CharacterStatePolicy {
  return policy === 'preserve' || policy === 'reset_evolution'
}
