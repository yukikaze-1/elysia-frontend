import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DictationSettingsSchema, SettingsPatchSchema, SettingsStateSchema, VoiceSettingsSchema } from '@shared/schemas'
import { VOICE_ERROR_CODES } from '@shared/contracts'

describe('语音/设置领域契约 schema（阶段4批次B）', () => {
  it('SettingsStateSchema.parse(DEFAULT_SETTINGS) 通过（默认值镜像 spec 5.1/M-7/D5A-10）', () => {
    const parsed = SettingsStateSchema.parse(DEFAULT_SETTINGS)
    expect(parsed).toEqual({
      version: 1,
      voice: {
        enabled: true, realtimeEnabled: false, autoReadReply: true,
        showCaptions: true, consentBackendStt: false
      },
      dictation: { insertMode: 'append' },
      live2d: { enabled: true, modelId: null } // 阶段 5 批次 A（D5A-10）
    })
  })

  it('带 micDeviceId / sttProfileId 的完整状态也通过', () => {
    const full: unknown = {
      version: 1,
      voice: { ...DEFAULT_SETTINGS.voice, micDeviceId: 'dev-1' },
      dictation: { sttProfileId: 'local/stt', insertMode: 'replace_selection' }
    }
    expect(SettingsStateSchema.safeParse(full).success).toBe(true)
  })

  it('version 非 1 / 缺必填字段被拒绝', () => {
    const badVersion: unknown = { ...DEFAULT_SETTINGS, version: 2 }
    expect(SettingsStateSchema.safeParse(badVersion).success).toBe(false)
    const noVoice: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete noVoice.voice
    expect(SettingsStateSchema.safeParse(noVoice).success).toBe(false)
    const noInsertMode: Record<string, unknown> = { ...DEFAULT_SETTINGS, dictation: { ...DEFAULT_SETTINGS.dictation } }
    delete (noInsertMode.dictation as Record<string, unknown>).insertMode
    expect(SettingsStateSchema.safeParse(noInsertMode).success).toBe(false)
  })

  it('patch 单项/多项/空 patch 均通过,非法 patch 被拒', () => {
    expect(SettingsPatchSchema.safeParse({ voice: { enabled: false } }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ dictation: { insertMode: 'replace_selection' } }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ voice: { enabled: false, autoReadReply: true }, dictation: { sttProfileId: 'local/stt' } }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ voice: { enabled: 'yes' } }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ dictation: { insertMode: 'cursor' } }).success).toBe(false)
  })

  it('patch merge 后 SettingsStateSchema 仍通过（settings:save 语义）', () => {
    const patch = { voice: { enabled: false }, dictation: { insertMode: 'replace_selection' } }
    const merged = { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, ...patch.voice }, dictation: { ...DEFAULT_SETTINGS.dictation, ...patch.dictation } }
    const parsed = SettingsStateSchema.parse(merged)
    expect(parsed.voice.enabled).toBe(false)
    expect(parsed.dictation.insertMode).toBe('replace_selection')
    // 未 patch 字段保持默认值
    expect(parsed.voice.autoReadReply).toBe(true)
    expect(parsed.dictation.sttProfileId).toBeUndefined()
  })

  it('VoiceSettingsSchema/DictationSettingsSchema 直接 parse 子对象', () => {
    expect(VoiceSettingsSchema.safeParse(DEFAULT_SETTINGS.voice).success).toBe(true)
    expect(DictationSettingsSchema.safeParse(DEFAULT_SETTINGS.dictation).success).toBe(true)
  })

  it('VOICE_ERROR_CODES 常量镜像 spec 5.2 错误码集', () => {
    expect(VOICE_ERROR_CODES).toEqual([
      'STT_UNAVAILABLE', 'STT_PROFILE_NOT_FOUND', 'VOICE_SESSION_CONFLICT', 'VOICE_SESSION_NOT_FOUND',
      'VOICE_RECORDING_TOO_LONG', 'VOICE_RECORDING_NOT_FOUND', 'DICTATION_NOT_FOUND', 'PLAYBACK_NOT_FOUND'
    ])
    // as const 元组：类型为字面量联合（D-P15 消费方按成员枚举）
    const code: (typeof VOICE_ERROR_CODES)[number] = VOICE_ERROR_CODES[0]
    expect(code).toBe('STT_UNAVAILABLE')
  })
})
