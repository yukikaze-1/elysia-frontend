import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import {
  CharacterGetMeRequestSchema,
  CharacterGetMeResponseSchema,
  CharacterUpdateMeRequestSchema,
  CharacterUpdateMeResponseSchema,
  CharacterGetRequestSchema,
  CharacterGetResponseSchema,
  CharacterListRequestSchema,
  CharacterListResponseSchema,
  CharacterListRevisionsRequestSchema,
  CharacterListRevisionsResponseSchema,
  CharacterStateRequestSchema,
  CharacterStateResponseSchema,
  CharacterCreateRequestSchema, CharacterCreateResponseSchema,
  CharacterUpdateRequestSchema, CharacterUpdateResponseSchema,
  CharacterCloneRequestSchema, CharacterCloneResponseSchema,
  CharacterArchiveRequestSchema, CharacterArchiveResponseSchema,
  CharacterRollbackRequestSchema, CharacterRollbackResponseSchema,
  CharacterValidateRequestSchema, CharacterValidateResponseSchema,
  CharacterPreviewRequestSchema, CharacterPreviewResponseSchema
} from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import type { CharacterService } from './character-service'
import type { CharacterDraftStore } from '../persistence/character-draft-store'

type Handler = (raw: unknown) => Promise<IpcResult<unknown>>
type Register = (channel: IpcChannelName, executor: Handler, arity?: 0 | 1) => void

export interface CharacterHandlersDeps {
  service: Pick<CharacterService, 'getMe' | 'updateMe' | 'listCharacters' | 'getCharacter' | 'listCharacterRevisions' | 'getCharacterState' | 'createCharacter' | 'updateCharacter' | 'cloneCharacter' | 'archiveCharacter' | 'rollbackCharacter' | 'validateCharacter' | 'previewCharacter'>
  /** 归档成功后清理同角色未提交草稿；清理失败不得翻转远端归档结果。 */
  drafts?: Pick<CharacterDraftStore, 'deleteByCharacterId'>
  sanitize: MessageSanitizer
  logger?: Logger
  /** 单测可注入 collector；生产使用 registry.registerHandler。 */
  register?: Register
}

/** FE-D1 角色 IPC：身份、目录读写与预览/校验通道；所有公开返回值再次经过 shared domain schema。 */
export function registerCharacterHandlers(deps: CharacterHandlersDeps): void {
  const register = deps.register ?? registerHandler
  const options = (channel: string) => ({ sanitize: deps.sanitize, channel, logger: deps.logger })

  register(
    IpcChannels.profileGetMe,
    createIpcHandler(CharacterGetMeRequestSchema, CharacterGetMeResponseSchema, () => deps.service.getMe(), options(IpcChannels.profileGetMe)),
    0
  )
  register(
    IpcChannels.profileUpdateMe,
    createIpcHandler(CharacterUpdateMeRequestSchema, CharacterUpdateMeResponseSchema, (input) => deps.service.updateMe(input), options(IpcChannels.profileUpdateMe)),
    1
  )
  register(
    IpcChannels.charactersList,
    createIpcHandler(CharacterListRequestSchema, CharacterListResponseSchema, (input) => deps.service.listCharacters(input), options(IpcChannels.charactersList)),
    1
  )
  register(
    IpcChannels.charactersGet,
    createIpcHandler(CharacterGetRequestSchema, CharacterGetResponseSchema, (input) => deps.service.getCharacter(input.characterId), options(IpcChannels.charactersGet)),
    1
  )
  register(IpcChannels.charactersCreate, createIpcHandler(CharacterCreateRequestSchema, CharacterCreateResponseSchema, (input) => deps.service.createCharacter(input), options(IpcChannels.charactersCreate)), 1)
  register(IpcChannels.charactersUpdate, createIpcHandler(CharacterUpdateRequestSchema, CharacterUpdateResponseSchema, (input) => deps.service.updateCharacter(input), options(IpcChannels.charactersUpdate)), 1)
  register(IpcChannels.charactersClone, createIpcHandler(CharacterCloneRequestSchema, CharacterCloneResponseSchema, (input) => deps.service.cloneCharacter(input), options(IpcChannels.charactersClone)), 1)
  register(IpcChannels.charactersArchive, createIpcHandler(
    CharacterArchiveRequestSchema,
    CharacterArchiveResponseSchema,
    async (input) => {
      const result = await deps.service.archiveCharacter(input.characterId)
      try {
        await deps.drafts?.deleteByCharacterId(input.characterId)
      } catch {
        // 远端归档已成功；清理失败只留下安全可重试的仓库错误，不把归档伪装成失败。
        deps.logger?.warn('character-drafts:archive-cleanup-failed', { code: 'CHARACTER_DRAFT_STORAGE_UNAVAILABLE' })
      }
      return result
    },
    options(IpcChannels.charactersArchive)
  ), 1)
  register(IpcChannels.charactersRollback, createIpcHandler(CharacterRollbackRequestSchema, CharacterRollbackResponseSchema, (input) => deps.service.rollbackCharacter(input), options(IpcChannels.charactersRollback)), 1)
  register(IpcChannels.charactersValidate, createIpcHandler(CharacterValidateRequestSchema, CharacterValidateResponseSchema, (input) => deps.service.validateCharacter(input), options(IpcChannels.charactersValidate)), 1)
  register(IpcChannels.charactersPreview, createIpcHandler(CharacterPreviewRequestSchema, CharacterPreviewResponseSchema, (input) => deps.service.previewCharacter(input), options(IpcChannels.charactersPreview)), 1)
  register(
    IpcChannels.charactersListRevisions,
    createIpcHandler(CharacterListRevisionsRequestSchema, CharacterListRevisionsResponseSchema, (input) => deps.service.listCharacterRevisions(input), options(IpcChannels.charactersListRevisions)),
    1
  )
  register(
    IpcChannels.characterInstancesGetState,
    createIpcHandler(CharacterStateRequestSchema, CharacterStateResponseSchema, (input) => deps.service.getCharacterState(input.characterInstanceId), options(IpcChannels.characterInstancesGetState)),
    1
  )
}
