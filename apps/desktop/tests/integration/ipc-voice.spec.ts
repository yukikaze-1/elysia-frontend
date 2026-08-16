// tests/integration/ipc-voice.spec.ts
// Task 9（P4-B）：语音/设置 IPC 经真实装配往返（launchApp 恒 mock；mock 装配下 voice.start* 无需先 connect，
// commitVoice 需 connect——mock 模式免 token 但需 endpoint）。仿 settings-model-services-ipc.spec.ts：
// 渲染进程访问必须用 page.evaluate（main 进程无 window.desktopApi）。voiceSendAudio 是单向 send——断言不抛即可。
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './helpers/app'

interface IpcVoiceApi {
  setEndpoint: (u: string) => Promise<unknown>
  connect: () => Promise<unknown>
  voiceStartRecord: (i: Record<string, unknown>) => Promise<{ recordingId: string }>
  voiceStopRecord: (i: Record<string, unknown>) => Promise<void>
  voiceCommit: (i: Record<string, unknown>) => Promise<{ clientRequestId: string; serverMessageId?: string }>
  voiceDiscard: (i: Record<string, unknown>) => Promise<void>
  voiceStartRealtime: (i: Record<string, unknown>) => Promise<{ sessionId: string }>
  voiceStopRealtime: (i: Record<string, unknown>) => Promise<void>
  voiceCancelRealtime: (i: Record<string, unknown>) => Promise<void>
  voiceStartDictation: (i: Record<string, unknown>) => Promise<{ clientRequestId: string }>
  voiceStopDictation: (i: Record<string, unknown>) => Promise<void>
  voiceCancelDictation: (i: Record<string, unknown>) => Promise<void>
  audioCancel: (i: Record<string, unknown>) => Promise<void>
  voiceSendAudio: (bytes: Uint8Array) => void
  onChatEvent: (h: (e: unknown) => void) => () => void
  settingsLoad: () => Promise<Record<string, unknown>>
  settingsSave: (p: Record<string, unknown>) => Promise<Record<string, unknown>>
}

/** 渲染进程内轮询等待事件（mock emit 异步/推送有延迟，Event-1）。page.evaluate 回调被序列化到渲染进程——
 *  模块作用域 helper 不可达，故 waitFor 必须定义在 evaluate 回调内部（此处仅留类型说明）。 */

describe('语音 IPC 契约（P4-B Task 9）', () => {
  it('录音控制帧往返：start→stop(transcript 事件)→commit(ack)→discard + realtime/dictation/audioCancel 不抛', async () => {
    const launched = await launchApp()
    try {
      const out = await launched.page.evaluate(async () => {
        const waitFor = (cond: () => boolean, timeoutMs = 3000): Promise<boolean> => new Promise((resolve) => {
          const t0 = Date.now()
          const tick = (): void => {
            if (cond()) { resolve(true); return }
            if (Date.now() - t0 > timeoutMs) { resolve(false); return }
            setTimeout(tick, 25)
          }
          tick()
        })
        const a = (window as unknown as { desktopApi: IpcVoiceApi }).desktopApi
        await a.setEndpoint('http://127.0.0.1:8765')
        await a.connect()

        const events: Array<{ event: string }> = []
        const unsub = a.onChatEvent((e) => events.push(e as { event: string }))

        const started = await a.voiceStartRecord({ recordingId: 'rec-it1' })
        await a.voiceStopRecord({ recordingId: 'rec-it1' })
        const transcriptArrived = await waitFor(() => events.some((e) => e.event === 'voice.transcript'))
        const ref = await a.voiceCommit({
          recordingId: 'rec-it1', text: '这是一段测试录音的转写文本',
          conversationId: 'conv-1001', clientRequestId: 'cc-it1', clientMessageId: 'cm-it1'
        })
        await a.voiceDiscard({ recordingId: 'rec-it2' })

        const rt = await a.voiceStartRealtime({ sessionId: 'vs-it1', conversationId: 'conv-1001' })
        a.voiceSendAudio(new Uint8Array([1, 2, 3])) // 单向 send：fire-and-forget，不抛即可
        await a.voiceStopRealtime({ sessionId: 'vs-it1' })
        await a.voiceCancelRealtime({ sessionId: 'vs-it2' })
        const d = await a.voiceStartDictation({ clientRequestId: 'd-it1' })
        await a.voiceStopDictation({ clientRequestId: 'd-it1' })
        await a.voiceCancelDictation({ clientRequestId: 'd-it2' })
        await a.audioCancel({ streamId: 7 })

        unsub()
        return { started, transcriptArrived, ref, rt, d }
      })
      expect(out.started).toEqual({ recordingId: 'rec-it1' })
      expect(out.transcriptArrived).toBe(true)
      expect(out.ref.clientRequestId).toBe('cc-it1')
      expect(out.ref.serverMessageId).toMatch(/^msg-/) // Task 12 乐观迁移依赖 serverMessageId
      expect(out.rt).toEqual({ sessionId: 'vs-it1' })
      expect(out.d).toEqual({ clientRequestId: 'd-it1' })
    } finally { await closeApp(launched) }
  })

  it('settings:load 返回默认；save patch 落盘 merge（enabled 翻转）', async () => {
    const launched = await launchApp()
    try {
      const out = await launched.page.evaluate(async () => {
        const a = (window as unknown as { desktopApi: IpcVoiceApi }).desktopApi
        const initial = await a.settingsLoad()
        const saved = await a.settingsSave({ voice: { enabled: false } })
        const reloaded = await a.settingsLoad()
        return { initial, saved, reloaded }
      })
      expect(out.initial).toMatchObject({ version: 1, voice: { enabled: true } })
      expect(out.saved.voice).toMatchObject({ enabled: false })
      expect(out.reloaded.voice).toMatchObject({ enabled: false }) // 持久化后 load 仍为关闭
    } finally { await closeApp(launched) }
  })
})
