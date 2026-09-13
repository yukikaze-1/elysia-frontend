/**
 * 阶段 4 批次 B（P4-B）语音领域契约 —— spec 5.1 全量类型。
 * 三种语音（普通录音 / 实时会话 / 输入法转写）、二进制上行、TTS 播放控制、本地设置。
 * wire 侧映射见 docs/02 §12/§13（BackendAdapter 消费，UI 只消费本文件领域类型）。
 * 阶段 5 批次 A（A6）：本文件 SettingsState/SettingsPatch 增 live2d（D5A-10，本地设置面扩展）。
 * 阶段 6 批次 C（D6C-02）：SettingsState/SettingsPatch 增 tools（目录授权子树）。
 */
import type { Live2DSettings } from './live2d'
import type { ToolsSettings } from './tool'
import type { AppearanceSettings } from './appearance'

/** 音频输入描述（wire 唯一支持 pcm_s16le/16000/1；缺省按默认处理）。本批 start 帧不带此字段（采集即默认格式），仅供契约文档 */
export interface AudioInputDescriptor { codec: 'pcm_s16le'; sampleRate: 16000; channels: 1 }

export type VoiceInputMode = 'record' | 'realtime' | 'dictation'

// —— 普通录音 ——
export interface VoiceRecordStartInput { recordingId: string }          // wire voice.record.start 仅 {recordingId, audio?}（无 conversationId；会话归属在 commit）
export interface VoiceRecordStopInput { recordingId: string }
export interface VoiceCommitInput {
  recordingId: string; text: string; conversationId: string
  clientRequestId: string; clientMessageId: string
}
export interface VoiceDiscardInput { recordingId: string }

// —— 实时语音会话 ——
export interface RealtimeVoiceStartInput { sessionId: string; conversationId?: string }
export interface RealtimeVoiceControlInput { sessionId: string }

// —— 输入法转写 ——
export interface DictationStartInput { clientRequestId: string; sttProfileId?: string }
export interface DictationStopInput { clientRequestId: string }

// —— 二进制上行（单向 send，非 invoke） ——
export interface AudioChunkInput { bytes: Uint8Array }

// —— TTS 播放控制 ——
export interface AudioCancelInput { streamId: number }

// —— 本地设置（P4-B 前端自有持久化，backend 无对应端点；存 Main dirs.config/settings.json） ——
export interface VoiceSettings {
  enabled: boolean           // 语音输入总开关：普通录音 + 输入法转写入口（doc 11 §3.3 启用语音输入）
  realtimeEnabled: boolean   // 实时语音会话子开关（独立于 enabled，独立启停）
  autoReadReply: boolean     // TTS 自动朗读 AI 回复（D3；本地播放门 D-P1）
  showCaptions: boolean      // 显示直接语音字幕
  consentBackendStt: boolean // 后端 STT 首次操作一次性同意已接受（D-P16；默认 false → 首个 backend-STT 操作前弹确认）
  micDeviceId?: string       // 麦克风设备（缺省默认设备）
  /** 语音活动检测 / 静音结束（doc 11 §3.3，2026-09-13）：连续静音达 silenceStopMs 自动结束录音。
   *  默认**关闭**（opt-in）——它会改变"什么时候停止录音"这一既有行为，不应当默认替用户决定。 */
  silenceAutoStop: boolean
  /** 静音结束时长（ms，1000–5000，默认 2000；仅 silenceAutoStop 为真时生效） */
  silenceStopMs: number
}
export interface DictationSettings {
  sttProfileId?: string      // 独立 STT Profile（<provider>/<model>；缺省 → dictation.start 不带 → 全局活动 STT，D-P14）
  insertMode: 'append' | 'replace_selection'  // final 插入位置（D-P4）
}
export interface SettingsState {
  version: 1
  voice: VoiceSettings
  dictation: DictationSettings
  live2d: Live2DSettings   // 阶段 5 批次 A（D5A-10）：Live2D 本地设置（enabled/modelId）
  tools: ToolsSettings   // 阶段 6 批次 C（D6C-02）：目录授权子树
  appearance: AppearanceSettings   // 外观（2026-09-13）：全局字体缩放；doc 03 §12.4 / doc 11 §7.2
}
export type SettingsPatch = Partial<{ voice: Partial<VoiceSettings>; dictation: Partial<DictationSettings>; live2d: Partial<Live2DSettings>; tools: Partial<ToolsSettings>; appearance: Partial<AppearanceSettings> }>

/** 语音族错误码（D-P15）：real-backend 对这类错误额外 emit `voice.error`；connectionStore 对它们不展示全局连接错误横幅 */
export const VOICE_ERROR_CODES = [
  'STT_UNAVAILABLE', 'STT_PROFILE_NOT_FOUND', 'VOICE_SESSION_CONFLICT', 'VOICE_SESSION_NOT_FOUND',
  'VOICE_RECORDING_TOO_LONG', 'VOICE_RECORDING_NOT_FOUND', 'DICTATION_NOT_FOUND', 'PLAYBACK_NOT_FOUND'
] as const
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number]
