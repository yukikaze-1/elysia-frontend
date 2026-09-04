// FE-D2：角色编辑草稿 IPC。只暴露具名 list/get/save/delete，禁止任意路径/任意 channel。
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import {
  CharacterDraftListRequestSchema,
  CharacterDraftListResponseSchema,
  CharacterDraftGetRequestSchema,
  CharacterDraftGetResponseSchema,
  CharacterDraftSaveRequestSchema,
  CharacterDraftSaveResponseSchema,
  CharacterDraftDeleteRequestSchema,
  CharacterDraftDeleteResponseSchema
} from '@shared/schemas'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import type { CharacterDraftStore } from '../persistence/character-draft-store'

type Handler = (raw: unknown) => Promise<IpcResult<unknown>>
type Register = (channel: IpcChannelName, executor: Handler, arity?: 0 | 1) => void

export interface CharacterDraftHandlersDeps {
  drafts: Pick<CharacterDraftStore, 'list' | 'get' | 'save' | 'delete'>
  sanitize: MessageSanitizer
  logger?: Logger
  /** 单测可注入 collector；生产使用 registry.registerHandler。 */
  register?: Register
}

/** Main repository → strict IPC handler → Preload 的完整草稿恢复面。 */
export function registerCharacterDraftHandlers(deps: CharacterDraftHandlersDeps): void {
  const register = deps.register ?? registerHandler
  const options = (channel: string) => ({ sanitize: deps.sanitize, channel, logger: deps.logger })

  register(
    IpcChannels.characterDraftsList,
    createIpcHandler(CharacterDraftListRequestSchema, CharacterDraftListResponseSchema, () => deps.drafts.list(), options(IpcChannels.characterDraftsList)),
    0
  )
  register(
    IpcChannels.characterDraftsGet,
    createIpcHandler(CharacterDraftGetRequestSchema, CharacterDraftGetResponseSchema, (input) => deps.drafts.get(input.key), options(IpcChannels.characterDraftsGet)),
    1
  )
  register(
    IpcChannels.characterDraftsSave,
    createIpcHandler(CharacterDraftSaveRequestSchema, CharacterDraftSaveResponseSchema, (input) => deps.drafts.save(input), options(IpcChannels.characterDraftsSave)),
    1
  )
  register(
    IpcChannels.characterDraftsDelete,
    createIpcHandler(CharacterDraftDeleteRequestSchema, CharacterDraftDeleteResponseSchema, (input) => deps.drafts.delete(input.key), options(IpcChannels.characterDraftsDelete)),
    1
  )
}
