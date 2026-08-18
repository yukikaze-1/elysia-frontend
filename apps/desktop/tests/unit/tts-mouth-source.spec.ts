// tests/unit/tts-mouth-source.spec.ts
// 批次 C（C1）F1 修复：Web Audio 限定每个 HTMLMediaElement 终生只能 createMediaElementSource 一次——第二次对
// 同一元素调用抛 InvalidStateError（被 catch 吞掉 → sample 恒 0 → 真实模式第二次 TTS 后口型停摆）。
// 修法：sourceNode 一次性创建并留存，attach 只重连 + ctx.resume()，detach 只断链 + ctx.suspend()。
// 测试用 analyserFactory 注入 fake graph（node 无 AudioContext）；断言 createMediaElementSource 每元素仅一次。
import { describe, expect, it, vi } from 'vitest'
import { createTtsMouthSource, type AnalyserPair } from '../../src/renderer/src/live2d/tts-mouth-source'

interface FakeGraph {
  createMediaElementSource: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  suspend: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  sourceNode: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  analyser: {
    fftSize: number
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    getFloatTimeDomainData: ReturnType<typeof vi.fn>
  }
  asPair: () => AnalyserPair
}

/** 可复用的 fake WebAudio graph：createMediaElementSource 每次调用都返回**新的** sourceNode（真实浏览器
 *  对同一元素二次调用会抛 InvalidStateError——本 fake 以「调用次数」断言，不模拟抛错本身） */
function makeFakeGraph(): FakeGraph {
  const createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  const sourceNode = { connect: vi.fn(), disconnect: vi.fn() }
  const analyser = {
    fftSize: 256,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buf: Float32Array) => { buf.fill(0) })
  }
  const context = {
    createMediaElementSource,
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    destination: {}
  }
  return {
    createMediaElementSource,
    resume: context.resume,
    suspend: context.suspend,
    close: context.close,
    sourceNode,
    analyser,
    asPair: () => ({ analyser: analyser as unknown as AnalyserNode, context: context as unknown as AudioContext })
  }
}

function makeElement(): HTMLAudioElement {
  return {} as HTMLAudioElement
}

describe('createTtsMouthSource（C1，F1 每元素 MediaElementSource 终生一次）', () => {
  it('attach→detach→再 attach：createMediaElementSource 仅调用一次；第二次 attach 不抛且 sample 可读', () => {
    const g = makeFakeGraph()
    const src = createTtsMouthSource(g.asPair)
    const el = makeElement()

    src.attach(el)
    src.detach()
    // 第二次 attach（同一元素）：不得再次 createMediaElementSource（复用留存 sourceNode），不抛
    expect(() => src.attach(el)).not.toThrow()
    expect(g.createMediaElementSource).toHaveBeenCalledTimes(1)
    // attach 态下 sample 可读（fake 全 0 数据 → rms=0 → 硬门 → 0）
    expect(typeof src.sample()).toBe('number')
    expect(src.sample()).toBe(0)
    // detach 后 sample 恒 0（不残留）
    src.detach()
    expect(src.sample()).toBe(0)
    src.dispose()
  })

  it('换元素 attach → 为每元素各建一次 sourceNode（旧元素 sourceNode 终生只绑旧元素，不误用）', () => {
    const g = makeFakeGraph()
    const src = createTtsMouthSource(g.asPair)
    const elA = makeElement()
    const elB = makeElement()

    src.attach(elA)
    src.detach()
    src.attach(elB) // 换元素 → 全量释放旧 graph，为新元素重建
    expect(g.createMediaElementSource).toHaveBeenCalledTimes(2)
    expect(src.sample()).toBe(0)
    src.dispose()
  })

  it('dispose 自建 context 会 close（factory 提供的 context 不 close，归工厂）', () => {
    const g = makeFakeGraph()
    const src = createTtsMouthSource(g.asPair)
    src.attach(makeElement())
    src.dispose()
    expect(g.close).not.toHaveBeenCalled() // factory 提供的 context 归工厂，dispose 不 close
  })
})
