// tests/unit/voice-session-model.spec.ts
// `voice/session` 的判别力测试：模式迁移表、会话栅栏、背压、TTS 流归属。
//
// 这些判据此前散在 store 的四个 `clear*State` 与十几个 `if` 里，只能经 1071 行的 store 集成用例
// 到达（且需要 mock api + fake capture）。下沉后可以穷举迁移表与栅栏边界。
import { describe, expect, it } from 'vitest'
import type { BackendEvent } from '../../src/shared/contracts'
import {
  MAX_UNACKED_FRAMES,
  MODE_AFTER_START_REJECTED,
  canTransitionVoiceMode,
  convergenceForViewChange,
  dictationEventBelongsToSession,
  modeAfterStartRejected,
  nextVoiceMode,
  shouldPauseCapture,
  shouldResumeCapture,
  transcriptBelongsToRecording,
  ttsEventBelongsToActiveCharacter,
  ttsStreamDecisionForStarted,
  ttsStreamIsCurrent,
  voiceSessionActive,
  voiceSessionEventBelongsToSession,
  voiceSessionEventId,
  type VoiceMode,
  type VoiceModeEvent
} from '../../src/renderer/src/voice/session'

const ALL_MODES: VoiceMode[] = ['idle', 'recording', 'record_pending', 'realtime', 'dictating']
const ALL_EVENTS: VoiceModeEvent[] = [
  'record-start-accepted',
  'record-start-rejected',
  'record-stopped',
  'record-cleared',
  'realtime-started',
  'realtime-start-rejected',
  'realtime-ended',
  'dictation-start-accepted',
  'dictation-start-rejected',
  'dictation-cancelled',
  'dictation-consumed'
]

describe('模式迁移表', () => {
  it('空闲是唯一的入口：三个 start 接受事件都只从 idle 放行', () => {
    expect(nextVoiceMode('idle', 'record-start-accepted')).toBe('recording')
    expect(nextVoiceMode('idle', 'realtime-started')).toBe('realtime')
    expect(nextVoiceMode('idle', 'dictation-start-accepted')).toBe('dictating')
    for (const mode of ALL_MODES.filter((m) => m !== 'idle')) {
      expect(nextVoiceMode(mode, 'record-start-accepted'), mode).toBeUndefined()
      expect(nextVoiceMode(mode, 'realtime-started'), mode).toBeUndefined()
      expect(nextVoiceMode(mode, 'dictation-start-accepted'), mode).toBeUndefined()
    }
  })

  it('录音：recording → record_pending → idle（停止与清态是两步）', () => {
    expect(nextVoiceMode('recording', 'record-stopped')).toBe('record_pending')
    expect(nextVoiceMode('record_pending', 'record-cleared')).toBe('idle')
    expect(nextVoiceMode('recording', 'record-cleared')).toBe('idle')   // capture 起失败时的直接收敛
    expect(nextVoiceMode('record_pending', 'record-stopped')).toBeUndefined()   // 已停止不得重复停止
  })

  it('实时会话只能经 ended 收回空闲（stop/cancel 之后仍停在 realtime，等 ended）', () => {
    expect(nextVoiceMode('realtime', 'realtime-ended')).toBe('idle')
    expect(nextVoiceMode('realtime', 'record-cleared')).toBeUndefined()
    expect(nextVoiceMode('realtime', 'record-stopped')).toBeUndefined()
  })

  it('转写：cancelled 与 consumed 都回空闲；其余事件在 dictating 下无迁移', () => {
    expect(nextVoiceMode('dictating', 'dictation-cancelled')).toBe('idle')
    expect(nextVoiceMode('dictating', 'dictation-consumed')).toBe('idle')
    expect(nextVoiceMode('dictating', 'record-cleared')).toBeUndefined()
  })

  it('未列出的 (模式, 事件) 组合一律拒绝（返回 undefined ⇒ 调用方保持原模式）', () => {
    // 穷举全表：只有与上表一致的组合允许迁移，其余必须 undefined。
    const allowed = new Set([
      'idle|record-start-accepted',
      'idle|realtime-started',
      'idle|dictation-start-accepted',
      'recording|record-stopped',
      'recording|record-cleared',
      'record_pending|record-cleared',
      'realtime|realtime-ended',
      'dictating|dictation-cancelled',
      'dictating|dictation-consumed'
    ])
    for (const mode of ALL_MODES) {
      for (const event of ALL_EVENTS) {
        const expected = allowed.has(`${mode}|${event}`)
        expect(canTransitionVoiceMode(mode, event), `${mode} + ${event}`).toBe(expected)
      }
    }
  })

  it('start 被拒 → 强制回空闲（三个入口都只从 idle 进入，拒绝即不进入任何会话）', () => {
    // 这是**安全网**而不是状态迁移：基线的失败分支无条件 `mode.value = 'idle'`。
    // 早期重构把它写成「按迁移表推导」（`nextVoiceMode(from,'*-start-rejected') ?? from`），
    // 而拒绝事件本就不在任何迁移行里 ⇒ 退化成空操作、安全网消失（对抗复核实测）。
    expect(modeAfterStartRejected()).toBe('idle')
    expect(MODE_AFTER_START_REJECTED).toBe('idle')
  })
})

describe('voiceSessionActive / convergenceForViewChange', () => {
  it('只有 idle 不算活跃', () => {
    expect(voiceSessionActive('idle')).toBe(false)
    for (const mode of ALL_MODES.filter((m) => m !== 'idle')) expect(voiceSessionActive(mode), mode).toBe(true)
  })

  it('离开聊天区：录音与待确认走取消、实时走取消、空闲与转写不动', () => {
    expect(convergenceForViewChange('recording')).toBe('discard-record')
    expect(convergenceForViewChange('record_pending')).toBe('discard-record')
    expect(convergenceForViewChange('realtime')).toBe('cancel-realtime')
    expect(convergenceForViewChange('idle')).toBe('none')
    expect(convergenceForViewChange('dictating')).toBe('none')   // 松手/失焦即收敛
  })
})

describe('背压窗口：暂停与恢复必须是同一判据的两面', () => {
  it('恰在窗口内（差值 200）不暂停；越窗（201）暂停', () => {
    expect(shouldPauseCapture(MAX_UNACKED_FRAMES, 0)).toBe(false)
    expect(shouldPauseCapture(MAX_UNACKED_FRAMES + 1, 0)).toBe(true)
  })

  it('恢复判据是暂停判据的取反——不存在「暂停了永不恢复」的窗口', () => {
    for (const unacked of [0, 1, MAX_UNACKED_FRAMES, MAX_UNACKED_FRAMES + 1, MAX_UNACKED_FRAMES + 500]) {
      for (const lastAcked of [0, 1, MAX_UNACKED_FRAMES]) {
        expect(shouldResumeCapture(unacked, lastAcked)).toBe(!shouldPauseCapture(unacked, lastAcked))
      }
    }
  })

  it('ack 推进到接近 unacked 时恢复（背压随 ack 解除）', () => {
    expect(shouldPauseCapture(500, 0)).toBe(true)
    expect(shouldResumeCapture(500, 500)).toBe(true)
    expect(shouldResumeCapture(500, 301)).toBe(true)   // 差值 199 ≤ 200
    expect(shouldResumeCapture(500, 299)).toBe(false)  // 差值 201 > 200
  })
})

describe('录音字幕归属：recordingId 栅栏', () => {
  it('相符 → 接受', () => {
    expect(transcriptBelongsToRecording('rec_1', 'rec_1')).toBe(true)
  })

  it('discard/commit 清掉 id 后，迟到的旧字幕一律丢弃', () => {
    expect(transcriptBelongsToRecording('rec_1', undefined)).toBe(false)
  })

  it('换到新录音后，旧录音的字幕不得写入新会话（跨会话污染）', () => {
    expect(transcriptBelongsToRecording('rec_1', 'rec_2')).toBe(false)
  })
})

describe('转写终态归属：clientRequestId 栅栏（本批修掉的跨会话草稿污染）', () => {
  it('当前打开的转写会话 id 相符 → 接受', () => {
    expect(dictationEventBelongsToSession('req_x', 'req_x')).toBe(true)
  })

  it('已取消 / 已消费 / 断线 reset 之后（id 已清）→ 迟到终态被拒', () => {
    expect(dictationEventBelongsToSession('req_x', undefined)).toBe(false)
  })

  it('会话 A 的终态在会话 B 期间到达 → 被拒（A 不得经 CyChatInput 的 watch 插入 B 的草稿）', () => {
    expect(dictationEventBelongsToSession('req_a', 'req_b')).toBe(false)
  })
})

describe('实时会话事件归属：sessionId 栅栏', () => {
  it('已确认的会话 id：同 id 接受、异 id 拒绝（迟到的 ended/ack 不得作用于下一次会话）', () => {
    expect(voiceSessionEventBelongsToSession('vs_1', 'vs_1', true)).toBe(true)
    expect(voiceSessionEventBelongsToSession('vs_old', 'vs_1', true)).toBe(false)
  })

  it('本次会话尚未确认（undefined）且会话活跃 → 放行，由首个带 id 的事件完成确认', () => {
    expect(voiceSessionEventBelongsToSession('vs_1', undefined, true)).toBe(true)
  })

  it('已无实时会话 → 一律拒绝（否则上次会话结束后到达的 ack/ended 会落到「无会话」状态上）', () => {
    expect(voiceSessionEventBelongsToSession('vs_1', 'vs_1', false)).toBe(false)
    expect(voiceSessionEventBelongsToSession('vs_1', undefined, false)).toBe(false)
  })

  it('只有实时会话族事件带 id；其它语音事件不参与该栅栏', () => {
    const withId = [
      { event: 'voice_session.started', sessionId: 'vs_1' },
      { event: 'voice_session.partial', sessionId: 'vs_1' },
      { event: 'voice_session.turn', sessionId: 'vs_1' },
      { event: 'voice_session.ack', sessionId: 'vs_1' },
      { event: 'voice_session.ended', sessionId: 'vs_1' }
    ] as unknown as BackendEvent[]
    for (const e of withId) expect(voiceSessionEventId(e), e.event).toBe('vs_1')
    const withoutId = [
      { event: 'voice.transcript', recordingId: 'rec_1', text: 't' },
      { event: 'dictation.partial', text: 't' },
      { event: 'dictation.final', clientRequestId: 'r', text: 't' },
      { event: 'dictation.cancelled', clientRequestId: 'r' },
      { event: 'voice.error', code: 'X' },
      { event: 'audio.session.started', streamId: 1 }
    ] as unknown as BackendEvent[]
    for (const e of withoutId) expect(voiceSessionEventId(e), e.event).toBeUndefined()
  })
})

describe('TTS 角色归属：legacy fail-open、能力开启后 fail-closed', () => {
  const binding = { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 }
  const matching = { conversationId: 'conv-1', ...binding }

  it('能力未开启 → 一律放行（旧后端不带角色身份，按身份拒会静默掉全部播放）', () => {
    expect(ttsEventBelongsToActiveCharacter({}, { profilesEnabled: false, conversationId: undefined, binding: undefined })).toBe(true)
  })

  it('能力开启且四元组相符 → 放行', () => {
    expect(ttsEventBelongsToActiveCharacter(matching, { profilesEnabled: true, conversationId: 'conv-1', binding })).toBe(true)
  })

  it('能力开启后：缺会话绑定即拒（音频可能在切换会话后才组装完成）', () => {
    expect(ttsEventBelongsToActiveCharacter(matching, { profilesEnabled: true, conversationId: 'conv-1', binding: undefined })).toBe(false)
  })

  it.each([
    ['会话不同', { ...matching, conversationId: 'conv-2' }],
    ['角色不同', { ...matching, characterId: 'char-2' }],
    ['实例不同', { ...matching, characterInstanceId: 'inst-2' }],
    ['revision 不同', { ...matching, characterRevision: 4 }],
    ['缺 conversationId', { ...binding }],
    ['缺 characterId', { conversationId: 'conv-1', characterInstanceId: 'inst-1', characterRevision: 3 }],
    ['缺 revision', { conversationId: 'conv-1', characterId: 'char-1', characterInstanceId: 'inst-1' }]
  ])('能力开启后 %s → 拒', (_label, event) => {
    expect(ttsEventBelongsToActiveCharacter(event, { profilesEnabled: true, conversationId: 'conv-1', binding })).toBe(false)
  })
})

describe('TTS 播放流归属', () => {
  it('没有在播的流 → 只记 id；同一流重复 started → 不打断自己', () => {
    expect(ttsStreamDecisionForStarted(1, { playing: false, playingStreamId: undefined })).toBe('record')
    expect(ttsStreamDecisionForStarted(1, { playing: true, playingStreamId: 1 })).toBe('record')
  })

  it('另一条流在播 → supersede（新句打断旧播放）', () => {
    expect(ttsStreamDecisionForStarted(2, { playing: true, playingStreamId: 1 })).toBe('supersede')
  })

  it('已接受但尚未播放（playing=false）时新流不触发 supersede（没有播放态可清）', () => {
    expect(ttsStreamDecisionForStarted(2, { playing: false, playingStreamId: 1 })).toBe('record')
  })

  it('ready/cancelled 只认当前已接受的流：旧 stream 的迟到事件被拒', () => {
    expect(ttsStreamIsCurrent(1, 1)).toBe(true)
    expect(ttsStreamIsCurrent(1, 2)).toBe(false)
    expect(ttsStreamIsCurrent(1, undefined)).toBe(false)
  })
})
