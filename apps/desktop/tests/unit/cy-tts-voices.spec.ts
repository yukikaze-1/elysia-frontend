// @vitest-environment happy-dom
// CyTtsVoices：试听只能由当前挂载周期内的用户点击触发；跨 TTS/STT tab 重新挂载不得补播旧 URL。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import CyTtsVoices from '../../src/renderer/src/components/CyTtsVoices.vue'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useModelServiceStore } from '../../src/renderer/src/stores/model-service.store'
import { createDesktopApiMock } from './helpers/desktop-api'

const previewTts = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  setDesktopApi(createDesktopApiMock({ previewTts, setTtsVoice: vi.fn() }))
  vi.clearAllMocks()
})

afterEach(() => vi.restoreAllMocks())

describe('CyTtsVoices 试听生命周期', () => {
  it('点击试听播放一次；卸载后重新挂载保留 controls，但不自动重播旧音频', async () => {
    previewTts.mockResolvedValue({
      ok: true,
      audioUrl: 'cyrene://renderer/__cyrene-media/tts-preview/ttsp-1'
    })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const store = useModelServiceStore()
    store.voices = [{ id: 'voice-1', name: 'Voice 1', languages: [], capabilities: [] }]

    const first = mount(CyTtsVoices)
    await first.get('.cy-tts-actions button:last-child').trigger('click')
    await flushPromises()

    expect(previewTts).toHaveBeenCalledWith({ voiceId: 'voice-1' })
    expect(play).toHaveBeenCalledTimes(1)
    expect(first.get('audio').attributes('autoplay')).toBeUndefined()
    first.unmount() // 模拟切到 STT

    const second = mount(CyTtsVoices) // 模拟切回 TTS；store 中仍保留上一条 preview URL
    await flushPromises()

    expect(second.get('audio').attributes('src')).toContain('ttsp-1')
    expect(play).toHaveBeenCalledTimes(1)
    second.unmount()
  })
})
