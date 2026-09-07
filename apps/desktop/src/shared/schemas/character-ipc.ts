import { z } from 'zod'
import {
  CharacterDetailSchema,
  CharacterIdSchema,
  CharacterListQuerySchema,
  CharacterPageSchema,
  CharacterRevisionQuerySchema,
  CharacterRevisionSummarySchema,
  CharacterPublicStateSchema,
  CharacterSummarySchema,
  UserIdentityProfileSchema,
  CharacterInstanceIdSchema,
  UpdateUserIdentityCommandSchema,
  CreateCharacterCommandSchema, UpdateCharacterCommandSchema, CloneCharacterCommandSchema,
  RollbackCharacterCommandSchema, CharacterDraftSchema, CharacterPreviewCommandSchema,
  CharacterMutationResultSchema, CharacterArchiveResultSchema, CharacterValidationResultSchema,
  CharacterPreviewResultSchema,
  ResetCharacterEvolutionCommandSchema,
  ResetCharacterEvolutionResultSchema,
  CharacterDraftKeySchema, CharacterDraftSummarySchema, PersistedCharacterDraftSchema
} from './character'

/**
 * 角色领域 IPC 的请求/响应 schema。
 * 请求只允许领域字段；响应由 Main service 产出领域对象后再次 strict 校验，
 * Preload 复用同一组 schema，Renderer 不接触 raw REST DTO。
 */
export const CharacterGetMeRequestSchema = z.undefined()
export const CharacterUpdateMeRequestSchema = UpdateUserIdentityCommandSchema
export const CharacterListRequestSchema = CharacterListQuerySchema
export const CharacterGetRequestSchema = z.object({ characterId: CharacterIdSchema }).strict()
export const CharacterListRevisionsRequestSchema = CharacterRevisionQuerySchema
export const CharacterStateRequestSchema = z.object({ characterInstanceId: CharacterInstanceIdSchema }).strict()
export const CharacterResetEvolutionRequestSchema = ResetCharacterEvolutionCommandSchema
export const CharacterCreateRequestSchema = CreateCharacterCommandSchema
export const CharacterUpdateRequestSchema = UpdateCharacterCommandSchema
export const CharacterCloneRequestSchema = CloneCharacterCommandSchema
export const CharacterArchiveRequestSchema = z.object({ characterId: CharacterIdSchema }).strict()
export const CharacterRollbackRequestSchema = RollbackCharacterCommandSchema
export const CharacterValidateRequestSchema = CharacterDraftSchema
export const CharacterPreviewRequestSchema = CharacterPreviewCommandSchema

export const CharacterGetMeResponseSchema = UserIdentityProfileSchema
export const CharacterUpdateMeResponseSchema = UserIdentityProfileSchema
export const CharacterListResponseSchema = CharacterPageSchema(CharacterSummarySchema)
export const CharacterGetResponseSchema = CharacterDetailSchema
export const CharacterListRevisionsResponseSchema = CharacterPageSchema(CharacterRevisionSummarySchema)
export const CharacterStateResponseSchema = CharacterPublicStateSchema
export const CharacterResetEvolutionResponseSchema = ResetCharacterEvolutionResultSchema
export const CharacterCreateResponseSchema = CharacterDetailSchema
export const CharacterUpdateResponseSchema = CharacterMutationResultSchema
export const CharacterCloneResponseSchema = CharacterDetailSchema
export const CharacterArchiveResponseSchema = CharacterArchiveResultSchema
export const CharacterRollbackResponseSchema = CharacterMutationResultSchema
export const CharacterValidateResponseSchema = CharacterValidationResultSchema
export const CharacterPreviewResponseSchema = CharacterPreviewResultSchema

// —— §12.3 本地未提交角色草稿：list 只返回摘要，get/save/delete 才触及完整 draft ——
export const CharacterDraftListRequestSchema = z.undefined()
export const CharacterDraftListResponseSchema = z.array(CharacterDraftSummarySchema).max(10)
export const CharacterDraftGetRequestSchema = z.object({ key: CharacterDraftKeySchema }).strict()
export const CharacterDraftGetResponseSchema = PersistedCharacterDraftSchema.optional()
export const CharacterDraftSaveRequestSchema = PersistedCharacterDraftSchema
export const CharacterDraftSaveResponseSchema = z.undefined()
export const CharacterDraftDeleteRequestSchema = z.object({ key: CharacterDraftKeySchema }).strict()
export const CharacterDraftDeleteResponseSchema = z.undefined()

// 复数命名别名与通道名保持一致，避免调用方因为历史单复数约定复制 schema。
export const CharacterDraftsListRequestSchema = CharacterDraftListRequestSchema
export const CharacterDraftsListResponseSchema = CharacterDraftListResponseSchema
export const CharacterDraftsGetRequestSchema = CharacterDraftGetRequestSchema
export const CharacterDraftsGetResponseSchema = CharacterDraftGetResponseSchema
export const CharacterDraftsSaveRequestSchema = CharacterDraftSaveRequestSchema
export const CharacterDraftsSaveResponseSchema = CharacterDraftSaveResponseSchema
export const CharacterDraftsDeleteRequestSchema = CharacterDraftDeleteRequestSchema
export const CharacterDraftsDeleteResponseSchema = CharacterDraftDeleteResponseSchema

// 兼容调用方使用“Input/Result”命名的显式别名；不复制 schema。
export const GetMeRequestSchema = CharacterGetMeRequestSchema
export const UpdateMeRequestSchema = CharacterUpdateMeRequestSchema
export const CharacterListInputSchema = CharacterListRequestSchema
export const CharacterGetInputSchema = CharacterGetRequestSchema
export const CharacterRevisionListInputSchema = CharacterListRevisionsRequestSchema
export const CharacterStateInputSchema = CharacterStateRequestSchema
export const CharacterResetEvolutionInputSchema = CharacterResetEvolutionRequestSchema
