// src/main/voice/voice-handlers.ts
// 阶段 4 批次 B（spec §5.4）：语音控制帧 11 通道 invoke handler + voice:audio-chunk 单向二进制上行。
// 全部经 createIpcHandler（请求/响应 schema 双向校验 + 结构化错误上提）+ registerHandler（可信 sender/arity 守卫）；
// voice:audio-chunk 经 registerOneWayHandler（D-P18 单向，fire-and-forget：非受信 sender 拒收、schema 非法丢弃 + warn、
// 超 1MiB 丢弃 + warn——无响应面，向调用方回报无意义）。audio:cancel → backend.audioCancel（TTS 播放取消）。
import { z } from 'zod'
import { IpcChannels } from '@shared/contracts'
import { ClientRequestRefSchema } from '@shared/schemas'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler, registerOneWayHandler } from '../ipc/registry'
import {
  audioCancelSchema, voiceAudioChunkSchema, voiceCancelDictationSchema, voiceCancelRealtimeSchema,
  voiceCommitSchema, voiceDiscardSchema, voiceStartDictationSchema, voiceStartRealtimeSchema,
  voiceStartRecordSchema, voiceStopDictationSchema, voiceStopRealtimeSchema, voiceStopRecordSchema
} from '../ipc/channels'
import type { VoiceBackendPort } from '../transport/backend-ports'
import type { MediaService } from '../attachments/media-service'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import type { Logger } from '../diagnostics/logger'

/** 单向音频分块大小上限（docs/07 §6.3 IPC 消息预算内收紧：1MiB/块，避免整块直传 WS 放大内存） */
export const MAX_AUDIO_CHUNK_BYTES = 1024 * 1024

const voiceRecordRefSchema = z.object({ recordingId: z.string() })
const voiceRealtimeRefSchema = z.object({ sessionId: z.string() })
const voiceDictationRefSchema = z.object({ clientRequestId: z.string() })

/** 后端能力面：语音端口（12 个方法；架构整改 Prompt 3 前是聚合 BackendAdapter 的 43 个方法）。 */
export function registerVoiceHandlers(deps: { backend: VoiceBackendPort; media: MediaService; sanitize: MessageSanitizer; logger: Logger }): void {
  const { backend, sanitize, logger } = deps
  registerHandler(IpcChannels.voiceStartRecord, createIpcHandler(voiceStartRecordSchema, voiceRecordRefSchema, (input) => backend.startRecordVoice(input), { sanitize, channel: IpcChannels.voiceStartRecord, logger }), 1)
  registerHandler(IpcChannels.voiceStopRecord, createIpcHandler(voiceStopRecordSchema, z.undefined(), (input) => backend.stopRecordVoice(input), { sanitize, channel: IpcChannels.voiceStopRecord, logger }), 1)
  registerHandler(IpcChannels.voiceCommit, createIpcHandler(voiceCommitSchema, ClientRequestRefSchema, (input) => backend.commitVoice(input), { sanitize, channel: IpcChannels.voiceCommit, logger }), 1)
  registerHandler(IpcChannels.voiceDiscard, createIpcHandler(voiceDiscardSchema, z.undefined(), (input) => backend.discardVoice(input), { sanitize, channel: IpcChannels.voiceDiscard, logger }), 1)
  registerHandler(IpcChannels.voiceStartRealtime, createIpcHandler(voiceStartRealtimeSchema, voiceRealtimeRefSchema, (input) => backend.startRealtimeVoice(input), { sanitize, channel: IpcChannels.voiceStartRealtime, logger }), 1)
  registerHandler(IpcChannels.voiceStopRealtime, createIpcHandler(voiceStopRealtimeSchema, z.undefined(), (input) => backend.stopRealtimeVoice(input), { sanitize, channel: IpcChannels.voiceStopRealtime, logger }), 1)
  registerHandler(IpcChannels.voiceCancelRealtime, createIpcHandler(voiceCancelRealtimeSchema, z.undefined(), (input) => backend.cancelRealtimeVoice(input), { sanitize, channel: IpcChannels.voiceCancelRealtime, logger }), 1)
  registerHandler(IpcChannels.voiceStartDictation, createIpcHandler(voiceStartDictationSchema, voiceDictationRefSchema, (input) => backend.startDictation(input), { sanitize, channel: IpcChannels.voiceStartDictation, logger }), 1)
  registerHandler(IpcChannels.voiceStopDictation, createIpcHandler(voiceStopDictationSchema, z.undefined(), (input) => backend.stopDictation(input), { sanitize, channel: IpcChannels.voiceStopDictation, logger }), 1)
  registerHandler(IpcChannels.voiceCancelDictation, createIpcHandler(voiceCancelDictationSchema, z.undefined(), (input) => backend.cancelDictation(input), { sanitize, channel: IpcChannels.voiceCancelDictation, logger }), 1)
  registerHandler(IpcChannels.audioCancel, createIpcHandler(audioCancelSchema, z.undefined(), (input) => backend.audioCancel(input), { sanitize, channel: IpcChannels.audioCancel, logger }), 1)
  registerOneWayHandler(IpcChannels.voiceAudioChunk, voiceAudioChunkSchema, ({ bytes }) => {
    if (bytes.byteLength > MAX_AUDIO_CHUNK_BYTES) {
      logger.warn('voice:audio-chunk-too-large', { bytes: bytes.byteLength, limit: MAX_AUDIO_CHUNK_BYTES })
      return
    }
    backend.sendAudioBytes(bytes)
  }, { logger })
}
