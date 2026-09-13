import { safeError } from '../lib/redact.ts'
import type { StageHScenario } from './types.ts'
import type { CharacterDraft } from '@shared/contracts'

type AnyRecord = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function draftFrom(detail: AnyRecord): AnyRecord {
  const current = asRecord(detail.current)
  if (typeof current.displayName !== 'string' || current.promptProfile === undefined) throw new Error('角色详情缺少可预览的当前版本')
  return {
    displayName: current.displayName,
    ...(current.description === undefined ? {} : { description: current.description }),
    aliases: Array.isArray(current.aliases) ? current.aliases.slice() : [],
    promptProfile: clone(current.promptProfile),
    runtimeDefaults: clone(current.runtimeDefaults),
    presentation: clone(current.presentation),
    ...(current.openingMessage === undefined ? {} : { openingMessage: current.openingMessage })
  }
}

/**
 * 从角色详情里取必需字段：缺了就**抛**，不兜底。
 * 2026-09-13（type-aware lint 全集批次）：本文件此前不在任何 tsconfig 的 include 里，
 * `as AnyRecord` 之后的 `setup.detail` 一直是隐式 any 也没人报；接入 projectService 后
 * 17 处收窄错误一次性暴露。这里对所有必需字段统一取"缺失即失败"的口径——
 * 这是验收 harness，静默兜底会把"取不到数据"伪装成"检查通过"。
 */
function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`角色详情缺少 ${what}，无法构造该场景的命令`)
  return value
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' ? value as AnyRecord : {}
}

function records(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.filter((item): item is AnyRecord => Boolean(item && typeof item === 'object')) : []
}

async function capture<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: ReturnType<typeof safeError> }> {
  try {
    return { ok: true, value: await operation() }
  } catch (cause) {
    return { ok: false, error: safeError(cause) }
  }
}

export const runPreviewValidation: StageHScenario = async ({ config, page }) => {
  const active = asRecord(await page.evaluate(async () => window.desktopApi.listCharacters({ source: 'custom', status: 'active', limit: 100 })))
  const activeItems = records(active.items)
  const fallbackActive = config.characterId
    ? activeItems.find((item) => item.characterId === config.characterId)
    : activeItems[0]
  const selected = fallbackActive ?? (config.characterId ? { characterId: config.characterId } : undefined)
  const selectedCharacterId = selected?.characterId
  if (typeof selectedCharacterId !== 'string' || !selectedCharacterId) throw new Error('没有可用于 preview-validation 的 active custom character；请传 --character-id')

  const setup = await page.evaluate(async (input) => {
    const detail = await window.desktopApi.getCharacter(input.characterId)
    const conversations = await window.desktopApi.listConversations({ limit: 100 })
    const bound = input.conversationId
      ? conversations.items.find((item) => item.id === input.conversationId)
      : conversations.items.find((item) => item.character?.characterId === input.characterId)
    const instanceId = input.characterInstanceId ?? bound?.character?.characterInstanceId
    const state = instanceId ? await window.desktopApi.getCharacterState(instanceId) : null
    return {
      characterId: input.characterId,
      detail,
      conversationCount: conversations.items.length,
      instanceId: instanceId ?? null,
      state
    }
  }, { characterId: selectedCharacterId, conversationId: config.conversationId, characterInstanceId: config.characterInstanceId }) as AnyRecord

  // 逐层收窄（见 requireNumber 的注释）：`setup` 是按字段名用的记录，故每条路径显式取一次
  const setupDetail = asRecord(setup.detail)
  const setupCurrent = asRecord(setupDetail.current)
  const setupInstanceId = typeof setup.instanceId === 'string' ? setup.instanceId : null

  const draft = draftFrom(setupDetail)
  const validation = await page.evaluate(async (value) => window.desktopApi.validateCharacter(value), draft as unknown as CharacterDraft) as unknown as AnyRecord
  const preview = await page.evaluate(async (input) => window.desktopApi.previewCharacter(input), {
    draft: draft as unknown as CharacterDraft,
    userMessage: `Stage H preview ${config.marker}：请用一句简短的话介绍自己。`
  }) as unknown as AnyRecord

  const afterPreview = await page.evaluate(async (input) => {
    const detail = await window.desktopApi.getCharacter(input.characterId)
    const conversations = await window.desktopApi.listConversations({ limit: 100 })
    const state = input.instanceId ? await window.desktopApi.getCharacterState(input.instanceId) : null
    return { detail, conversationCount: conversations.items.length, state }
  }, { characterId: selectedCharacterId, instanceId: setupInstanceId }) as unknown as AnyRecord

  const invalidDraft = clone(draft)
  const invalidProfile = asRecord(invalidDraft.promptProfile)
  const currentPersonality = typeof invalidProfile.corePersonality === 'string' ? invalidProfile.corePersonality : ''
  invalidProfile.corePersonality = `${currentPersonality}\n<conflict_rules>`
  invalidDraft.promptProfile = invalidProfile
  const invalidValidation = await page.evaluate(async (value) => window.desktopApi.validateCharacter(value), invalidDraft as unknown as CharacterDraft) as unknown as AnyRecord
  const invalidSave = await capture(() => page.evaluate(async (input) => window.desktopApi.updateCharacter(input), {
    characterId: selectedCharacterId,
    expectedRevision: requireNumber(setupCurrent.revision, 'current.revision'),
    // `statePolicy` 是字面量联合（`'preserve' | 'reset_evolution'`）：不加 `as const` 会被
    // 拓宽成 string，而这里的参数对象不在 `updateCharacter` 的上下文类型里（它是 evaluate 的实参）。
    statePolicy: 'preserve' as const,
    draft: invalidDraft as unknown as CharacterDraft
  }))
  const finalDetail = await page.evaluate(async (id) => window.desktopApi.getCharacter(id), selectedCharacterId) as unknown as AnyRecord
  const issues = records(invalidValidation.issues)
  const previewDetails = asRecord(preview)
  const afterDetail = asRecord(afterPreview.detail)
  const beforeCurrent = setupCurrent
  const afterCurrent = asRecord(afterDetail.current)
  const beforeState = setup.state ? asRecord(setup.state) : null
  const afterState = afterPreview.state ? asRecord(afterPreview.state) : null

  const checks = {
    validDraftAccepted: validation.valid === true,
    previewEphemeral: previewDetails.ephemeral === true,
    previewReplyPresent: typeof previewDetails.reply === 'string' && previewDetails.reply.length > 0,
    previewModelPresent: typeof previewDetails.model === 'string' && previewDetails.model.length > 0,
    previewConversationCountUnchanged: afterPreview.conversationCount === setup.conversationCount,
    previewRevisionUnchanged: afterCurrent.revision === beforeCurrent.revision,
    previewStateVersionUnchanged: beforeState === null || afterState?.stateVersion === beforeState.stateVersion,
    invalidDraftRejected: invalidValidation.valid === false,
    invalidIssueMapped: issues.some((issue) => issue.path === '/promptProfile/corePersonality' && issue.severity === 'error'),
    invalidSaveRejected: invalidSave.ok === false && invalidSave.error.backendCode === 'CHARACTER_VALIDATION',
    invalidSaveRevisionUnchanged: asRecord(finalDetail.current).revision === beforeCurrent.revision
  }

  return {
    checks,
    details: {
      characterId: setup.characterId,
      revision: beforeCurrent.revision,
      boundInstanceId: setup.instanceId,
      conversationCount: setup.conversationCount,
      preview: {
        ephemeral: previewDetails.ephemeral === true,
        modelPresent: checks.previewModelPresent,
        replyPresent: checks.previewReplyPresent
      },
      invalidSaveError: invalidSave.ok ? null : invalidSave.error
    }
  }
}
