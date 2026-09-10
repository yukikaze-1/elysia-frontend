import { safeError } from '../lib/redact.ts'
import type { StageHScenario } from './types.ts'

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

  const draft = draftFrom(setup.detail)
  const validation = await page.evaluate(async (value) => window.desktopApi.validateCharacter(value), draft) as AnyRecord
  const preview = await page.evaluate(async (input) => window.desktopApi.previewCharacter(input), {
    draft,
    userMessage: `Stage H preview ${config.marker}：请用一句简短的话介绍自己。`
  }) as AnyRecord

  const afterPreview = await page.evaluate(async (input) => {
    const detail = await window.desktopApi.getCharacter(input.characterId)
    const conversations = await window.desktopApi.listConversations({ limit: 100 })
    const state = input.instanceId ? await window.desktopApi.getCharacterState(input.instanceId) : null
    return { detail, conversationCount: conversations.items.length, state }
  }, { characterId: setup.characterId, instanceId: setup.instanceId }) as AnyRecord

  const invalidDraft = clone(draft)
  const currentPersonality = typeof invalidDraft.promptProfile.corePersonality === 'string'
    ? invalidDraft.promptProfile.corePersonality
    : ''
  invalidDraft.promptProfile.corePersonality = `${currentPersonality}\n<conflict_rules>`
  const invalidValidation = await page.evaluate(async (value) => window.desktopApi.validateCharacter(value), invalidDraft) as AnyRecord
  const invalidSave = await capture(() => page.evaluate(async (input) => window.desktopApi.updateCharacter(input), {
    characterId: setup.characterId,
    expectedRevision: setup.detail.current.revision,
    statePolicy: 'preserve',
    draft: invalidDraft
  }))
  const finalDetail = await page.evaluate(async (id) => window.desktopApi.getCharacter(id), setup.characterId) as AnyRecord
  const issues = Array.isArray(invalidValidation.issues) ? invalidValidation.issues : []
  const previewDetails = asRecord(preview)
  const afterDetail = asRecord(afterPreview.detail)
  const beforeCurrent = asRecord(setup.detail.current)
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
