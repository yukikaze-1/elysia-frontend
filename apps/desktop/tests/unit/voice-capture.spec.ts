// tests/unit/voice-capture.spec.ts
// Task 10：PcmCapture（getUserMedia → AudioContext(16000) → AudioWorklet → 640B/20ms chunk → onChunk；
// AudioWorklet 失败 → ScriptProcessorNode 降级；stop → onStop AudioBuffer）+ floatToPcm16 纯函数。
// node 环境无 navigator.mediaDevices/AudioContext/AudioWorkletNode——vi.stubGlobal 注入 fake。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  floatToPcm16,
  PcmCapture,
  PcmChunkAggregator,
  PCM_CHUNK_BYTES,
  PCM_CHUNK_SAMPLES,
  PCM_PROCESSOR_NAME,
  PCM_SAMPLE_RATE
} from '../../src/renderer/src/voice/voice-capture'

// —— fakes（结构镜像 voice-capture 消费的 Web Audio API 面）——

interface FakeNode {
  connects: unknown[]
  connect: (target: unknown) => void
  disconnect: () => void
  channelCount: number
  channelCountMode: string
}

function makeFakeNode(): FakeNode {
  const connects: unknown[] = []
  return {
    connects,
    connect: vi.fn((target: unknown) => {
      connects.push(target)
    }),
    disconnect: vi.fn(),
    channelCount: 1,
    channelCountMode: 'explicit'
  }
}

interface FakeScriptProcessor {
  onaudioprocess: ((event: unknown) => void) | null
  connect: (target: unknown) => void
  disconnect: () => void
}

interface FakeBuffer {
  channels: number
  length: number
  sampleRate: number
  copied: Float32Array | null
  copyToChannel: (source: Float32Array, channelNumber: number) => void
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null
  static shouldRejectAddModule = false

  sampleRate = 16000
  destination: Record<string, never> = {}
  audioWorklet: { addModule: ReturnType<typeof vi.fn> }
  sourceNodes: FakeNode[] = []
  gains: Array<FakeNode & { gain: { value: number } }> = []
  scriptProcessors: FakeScriptProcessor[] = []
  buffers: FakeBuffer[] = []
  suspend = vi.fn(() => Promise.resolve())
  resume = vi.fn(() => Promise.resolve())
  close = vi.fn(() => Promise.resolve())

  constructor(_options?: { sampleRate?: number }) {
    this.audioWorklet = {
      addModule: FakeAudioContext.shouldRejectAddModule
        ? vi.fn(() => Promise.reject(new Error('module load failed')))
        : vi.fn(() => Promise.resolve())
    }
    FakeAudioContext.last = this
  }

  createMediaStreamSource(_stream: unknown): FakeNode {
    const n = makeFakeNode()
    this.sourceNodes.push(n)
    return n
  }

  createGain(): FakeNode & { gain: { value: number } } {
    const n = makeFakeNode() as FakeNode & { gain: { value: number } }
    n.gain = { value: 1 }
    this.gains.push(n)
    return n
  }

  createScriptProcessor(_bufferSize?: number, _in?: number, _out?: number): FakeScriptProcessor {
    const p: FakeScriptProcessor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() }
    this.scriptProcessors.push(p)
    return p
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const b: FakeBuffer = {
      channels,
      length,
      sampleRate,
      copied: null,
      copyToChannel: vi.fn((source: Float32Array) => {
        b.copied = source
      })
    }
    this.buffers.push(b)
    return b
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []

  port: { onmessage: ((event: { data: unknown }) => void) | null }
  connect: (target: unknown) => void
  disconnect: () => void
  name: string

  constructor(_context: unknown, name: string, _options?: unknown) {
    this.name = name
    this.port = { onmessage: null }
    this.connect = vi.fn()
    this.disconnect = vi.fn()
    FakeAudioWorkletNode.instances.push(this)
  }
}

interface FakeStream {
  getTracks: () => Array<{ stop: () => void }>
  getAudioTracks: () => Array<{ stop: () => void }>
}

function makeFakeStream(): { stream: FakeStream; tracks: Array<{ stop: () => void }> } {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
  const stream = {
    getTracks: vi.fn(() => tracks),
    getAudioTracks: vi.fn(() => tracks)
  }
  return { stream, tracks }
}

function makeChunk(sampleValue: number): Uint8Array {
  const out = new Uint8Array(PCM_CHUNK_BYTES)
  const view = new DataView(out.buffer)
  for (let i = 0; i < PCM_CHUNK_SAMPLES; i++) view.setInt16(i * 2, sampleValue, true)
  return out
}

// —— 共享状态 ——

let capturedChunks: Uint8Array[]
let stopBuffer: unknown

beforeEach(() => {
  FakeAudioContext.last = null
  FakeAudioContext.shouldRejectAddModule = false
  FakeAudioWorkletNode.instances = []
  capturedChunks = []
  stopBuffer = null
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// —— 纯函数 ——

describe('floatToPcm16', () => {
  it('±1.0 边界、越界截断、0、负值', () => {
    const input = new Float32Array([1.0, -1.0, 0, 2.0, -2.0, 0.25, -0.25])
    expect(Array.from(floatToPcm16(input))).toEqual([32767, -32767, 0, 32767, -32767, 8192, -8192])
  })

  it('空输入 → 空输出', () => {
    expect(floatToPcm16(new Float32Array(0)).length).toBe(0)
  })
})

describe('PcmChunkAggregator', () => {
  it('320 样本聚合 640B chunk；不足整块保留到后续补满', () => {
    const agg = new PcmChunkAggregator()
    const one = agg.push(new Int16Array(PCM_CHUNK_SAMPLES).fill(1))
    expect(one).toHaveLength(1)
    expect(one[0].byteLength).toBe(PCM_CHUNK_BYTES)
    expect(one[0][0]).toBe(1) // LE：样本 1 → 字节 0x01 0x00
    expect(one[0][1]).toBe(0)

    expect(agg.push(new Int16Array([2, 3, 4]))).toHaveLength(0) // 不足整块
    const tail = agg.push(new Int16Array(317).fill(5)) // 3+317=320 → 补满
    expect(tail).toHaveLength(1)
    expect(tail[0][0]).toBe(2)
    expect(tail[0][2]).toBe(3)
    expect(tail[0][4]).toBe(4)
    expect(tail[0][6]).toBe(5)
  })
})

// —— PcmCapture ——

describe('PcmCapture', () => {
  it('AudioWorklet 路径：chunk 经 onChunk 送达；stop 产出 AudioBuffer 并停轨道', async () => {
    const { stream, tracks } = makeFakeStream()
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    const capture = new PcmCapture()
    await capture.start({
      onChunk: (b) => {
        capturedChunks.push(b)
      },
      onStop: (ab) => {
        stopBuffer = ab
      }
    })

    const ctx = FakeAudioContext.last!
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1)
    const url = ctx.audioWorklet.addModule.mock.calls[0][0] as string
    expect(url.endsWith('/pcm-worklet.js')).toBe(true)

    const worklet = FakeAudioWorkletNode.instances[0]
    expect(worklet).toBeDefined()
    expect(worklet.name).toBe(PCM_PROCESSOR_NAME)
    expect(worklet.port.onmessage).toBeTypeOf('function')
    // graph 接线：source → worklet；worklet → 静音增益 → destination
    expect(ctx.sourceNodes[0].connects[0]).toBe(worklet)
    expect(ctx.gains[0].gain.value).toBe(0)
    expect(worklet.connect).toHaveBeenCalledWith(ctx.gains[0])
    expect(ctx.gains[0].connect).toHaveBeenCalledWith(ctx.destination)

    // 模拟 worklet 发来 3 个 640B chunk（16384 / -16384 / 0）
    const sent = [makeChunk(16384), makeChunk(-16384), makeChunk(0)]
    for (const chunk of sent) worklet.port.onmessage!({ data: chunk })

    expect(capturedChunks).toHaveLength(3)
    sent.forEach((chunk, i) => {
      expect(capturedChunks[i].byteLength).toBe(PCM_CHUNK_BYTES)
      expect(capturedChunks[i]).not.toBe(chunk) // onChunk 收到独立拷贝
    })
    expect(capturedChunks[0][0]).toBe(0x00)
    expect(capturedChunks[0][1]).toBe(0x40)

    await capture.pause()
    expect(ctx.suspend).toHaveBeenCalledTimes(1)
    await capture.resume()
    expect(ctx.resume).toHaveBeenCalledTimes(1)

    await capture.stop()
    expect(ctx.close).toHaveBeenCalledTimes(1)
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(tracks[1].stop).toHaveBeenCalled()
    // onStop AudioBuffer：3×320 样本，Int16→Float32 解码
    expect(stopBuffer).toBe(ctx.buffers[0])
    expect(ctx.buffers[0].length).toBe(960)
    expect(ctx.buffers[0].sampleRate).toBe(PCM_SAMPLE_RATE)
    const copied = ctx.buffers[0].copied!
    expect(copied).toHaveLength(960)
    expect(copied[0]).toBeCloseTo(16384 / 32767, 7)
    expect(copied[320]).toBeCloseTo(-16384 / 32767, 7)
    expect(copied[640]).toBe(0)
  })

  it('getUserMedia 约束：16k mono + EC/NS/AGC + deviceId 透传', async () => {
    const { stream } = makeFakeStream()
    const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    const capture = new PcmCapture()
    await capture.start({ onChunk: () => undefined, deviceId: 'dev-123' })

    const constraints = getUserMedia.mock.calls[0][0] as unknown as { audio: MediaTrackConstraints }
    expect(constraints.audio.channelCount).toBe(1)
    expect(constraints.audio.sampleRate).toBe(PCM_SAMPLE_RATE)
    expect(constraints.audio.echoCancellation).toBe(true)
    expect(constraints.audio.noiseSuppression).toBe(true)
    expect(constraints.audio.autoGainControl).toBe(true)
    expect(constraints.audio.deviceId).toBe('dev-123')
    await capture.stop()
  })

  it('addModule reject → ScriptProcessorNode 降级，chunk 仍送达（Important-7）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { stream } = makeFakeStream()
      const getUserMedia = vi.fn(async () => stream)
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
      FakeAudioContext.shouldRejectAddModule = true

      const capture = new PcmCapture()
      await capture.start({
        onChunk: (b) => {
          capturedChunks.push(b)
        },
        onStop: (ab) => {
          stopBuffer = ab
        }
      })

      const ctx = FakeAudioContext.last!
      expect(FakeAudioWorkletNode.instances).toHaveLength(0) // 未建 worklet 节点
      expect(ctx.scriptProcessors).toHaveLength(1) // 走降级
      expect(ctx.scriptProcessors[0].onaudioprocess).toBeTypeOf('function')
      expect(ctx.sourceNodes[0].connects[0]).toBe(ctx.scriptProcessors[0])
      expect(ctx.gains[0].gain.value).toBe(0)

      // 640 个 0.5 Float32 样本 → 2 个 640B chunk
      const input = new Float32Array(640).fill(0.5)
      ctx.scriptProcessors[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => input }
      } as unknown as AudioProcessingEvent)

      expect(capturedChunks).toHaveLength(2)
      expect(capturedChunks[0].byteLength).toBe(PCM_CHUNK_BYTES)
      expect(capturedChunks[1].byteLength).toBe(PCM_CHUNK_BYTES)
      // 跨事件聚合：再补 2 样本（不足整块）无输出
      ctx.scriptProcessors[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array([0.5, 0.5]) }
      } as unknown as AudioProcessingEvent)
      expect(capturedChunks).toHaveLength(2)

      await capture.stop()
      expect(ctx.buffers[0].length).toBe(640) // 尾部 2 样本（<20ms）未纳入
      expect(ctx.buffers[0].copied![0]).toBeCloseTo(0.5, 4)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('getUserMedia reject → start() reject（voiceStore 层转 micError）', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    const capture = new PcmCapture()
    await expect(capture.start({ onChunk: () => undefined })).rejects.toThrow('NotAllowedError')
    expect(FakeAudioContext.last).toBeNull() // 未创建 AudioContext
    expect(FakeAudioWorkletNode.instances).toHaveLength(0)
  })

  it('navigator.mediaDevices 缺失 → start() reject（PcmCaptureError）', async () => {
    vi.stubGlobal('navigator', {})
    const capture = new PcmCapture()
    await expect(capture.start({ onChunk: () => undefined })).rejects.toThrow('navigator.mediaDevices 不可用')
  })

  it('重复 start 抛 PcmCaptureError（ALREADY_STARTED）', async () => {
    const { stream } = makeFakeStream()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
    const capture = new PcmCapture()
    await capture.start({ onChunk: () => undefined })
    await expect(capture.start({ onChunk: () => undefined })).rejects.toThrow('PcmCapture 已启动')
    await capture.stop()
  })
})
