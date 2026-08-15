// src/main/models/model-handlers.ts
// 阶段 4 批次 A（spec §4.6）：模型服务 Profile 管理 + TTS 试听/声音 九通道 handler 装配。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）。
// previewTts：adapter 返回 raw（二进制 bytes），此处写入 MediaService 一次性缓存，返回 cyrene://renderer media URL——
// 传输面永不回传二进制/base64（spec P1：TtsPreviewOutcome 是 Renderer 唯一可见形态）。
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '@shared/contracts'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import {
  modelsListProfilesSchema, modelsSaveProfileSchema, modelsDeleteProfileSchema, modelsTestProfileSchema,
  modelsActivateProfileSchema, modelsGetActiveSelectionSchema, ttsListVoicesSchema, ttsPreviewSchema, ttsSetVoiceSchema
} from '../ipc/channels'
import {
  ModelProfilesSchema, ModelProfileTestResultSchema, ActiveModelSelectionSchema, TtsVoiceListResultSchema, TtsPreviewOutcomeSchema, ModelProfileSchema
} from '@shared/schemas'
import type { BackendAdapter } from '../transport/backend-adapter'
import { MEDIA_PATH_PREFIX, type MediaService } from '../attachments/media-service'
import type { MessageSanitizer } from '../diagnostics/sanitize'

export function registerModelHandlers(deps: { adapter: BackendAdapter; media: Pick<MediaService, 'putTtsPreview'>; sanitize: MessageSanitizer; logger: import('../diagnostics/logger').Logger }): void {
  const { adapter, media } = deps
  registerHandler(IpcChannels.modelsListProfiles, createIpcHandler(modelsListProfilesSchema, ModelProfilesSchema, ({ type }) => adapter.listModelProfiles(type), { sanitize: deps.sanitize, channel: IpcChannels.modelsListProfiles, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsSaveProfile, createIpcHandler(modelsSaveProfileSchema, ModelProfileSchema, (input) => adapter.saveModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsSaveProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsDeleteProfile, createIpcHandler(modelsDeleteProfileSchema, z.undefined(), (input) => adapter.deleteModelProfile(input.service, input.name), { sanitize: deps.sanitize, channel: IpcChannels.modelsDeleteProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsTestProfile, createIpcHandler(modelsTestProfileSchema, ModelProfileTestResultSchema, (input) => adapter.testModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsTestProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsActivateProfile, createIpcHandler(modelsActivateProfileSchema, z.undefined(), (input) => adapter.activateModelProfile(input), { sanitize: deps.sanitize, channel: IpcChannels.modelsActivateProfile, logger: deps.logger }), 1)
  registerHandler(IpcChannels.modelsGetActiveSelection, createIpcHandler(modelsGetActiveSelectionSchema, ActiveModelSelectionSchema, () => adapter.getActiveModelSelection(), { sanitize: deps.sanitize, channel: IpcChannels.modelsGetActiveSelection, logger: deps.logger }), 0)
  registerHandler(IpcChannels.ttsListVoices, createIpcHandler(ttsListVoicesSchema, TtsVoiceListResultSchema, () => adapter.listTtsVoices(), { sanitize: deps.sanitize, channel: IpcChannels.ttsListVoices, logger: deps.logger }), 0)
  registerHandler(IpcChannels.ttsPreview, createIpcHandler(ttsPreviewSchema, TtsPreviewOutcomeSchema, async (input) => {
    const raw = await adapter.previewTts(input)
    if (!raw.ok) return { ok: false, ...(raw.error ? { error: raw.error } : {}) }
    const id = `ttsp-${randomUUID()}`
    media.putTtsPreview(id, raw.bytes ?? new Uint8Array(), raw.mime ?? 'audio/wav')
    return { ok: true, audioUrl: `cyrene://renderer${MEDIA_PATH_PREFIX}tts-preview/${id}`, ...(raw.durationMs !== undefined ? { durationMs: raw.durationMs } : {}) }
  }, { sanitize: deps.sanitize, channel: IpcChannels.ttsPreview, logger: deps.logger }), 1)
  registerHandler(IpcChannels.ttsSetVoice, createIpcHandler(ttsSetVoiceSchema, z.undefined(), (input) => adapter.setTtsVoice(input), { sanitize: deps.sanitize, channel: IpcChannels.ttsSetVoice, logger: deps.logger }), 1)
}
