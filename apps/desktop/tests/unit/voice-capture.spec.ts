// tests/unit/voice-capture.spec.ts
// Task 10：PcmCapture（getUserMedia → AudioContext(16000) → AudioWorklet → 640B/20ms chunk → onChunk；
// AudioWorklet 失败 → ScriptProcessorNode 降级；stop → onStop AudioBuffer）+ floatToPcm16 纯函数。
// node 环境无 navigator.mediaDevices/AudioContext/AudioWorkletNode——vi.stubGlobal 注入 fake。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computePcmRms,
  computeRms,
  floatToPcm16,
  PcmAccumulator,
  PcmCapture,
  PcmChunkAggregator,
  PCM_CHUNK_BYTES,
  PCM_CHUNK_MS,
  PCM_CHUNK_SAMPLES,
  PCM_PROCESSOR_NAME,
  PCM_SAMPLE_RATE,
  SilenceTracker,
  SILENCE_RMS_THRESHOLD
} from '../../src/renderer/src/voice/voice-capture'

// —— doc 11 §3.3「语音活动检测／静音结束时长」（2026-09-13）：判据是纯逻辑，先钉死它 ——
// 真实麦克风在 CI 上不可控（听不到声音、也造不出确定的静音），所以"多久算说完"这条判据
// 必须是可确定性单测的纯函数/纯类；PcmCapture 只负责把每一帧的 RMS 喂进来。
describe('静音判定（doc 11 §3.3）', () => {
  it('computeRms：全零 0、满幅 1、正负相消（直流为零但交流有能量）', () => {
    expect(computeRms(new Float32Array(0))).toBe(0)
    expect(computeRms(new Float32Array([0, 0, 0, 0]))).toBe(0)
    expect(computeRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5)
    // ±交替的信号 RMS=幅值（均值恒 0，若实现错误地取平均会得 0）
    expect(computeRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 5)
  })

  // M-26（2026-09-14）：`computePcmRms`（Int16 直读）与 `computeRms(floatToPcm16(x)/32767)`
  // 的**数值等价**是整个改造的前提——正是因为等价，静音判定才不需要在热路径上把每帧解码成
  // Float32Array（那一份 float 数组原先是 30000 个对象 / 36.6MB）。这条用例把它钉住：
  // 若有人日后把任一侧的换算改得不一致（例如改成 `/32768`，或漏掉 clamp），这里立刻变红。
  it('computePcmRms：与 floatToPcm16→computeRms 等价（M-26 改造前提）', () => {
    // 用**波形**而非 ±1 这类定点值：那些值两条路径都恰好精确，测试会平凡通过、证明不了量化误差。
    const N = 1000
    const wave = new Float32Array(N)
    for (let i = 0; i < N; i++) wave[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000)
    const pcm = floatToPcm16(wave)

    const floatPath = computeRms(Float32Array.from(pcm, (v) => v / 32767))
    const pcmPath = computePcmRms(pcm)
    // 容差取量化步长的一半（1/32767）——足以覆盖 RMS 的舍入误差，又紧到任何换算改动都会红。
    expect(pcmPath).toBeCloseTo(floatPath, 0)
    expect(Math.abs(pcmPath - floatPath)).toBeLessThan(0.5 / 32767)
    // 同时证明它量到的确实是这个幅值（否则两边同为错误值也能"等价"）
    expect(pcmPath).toBeCloseTo(0.3 / Math.SQRT2, 2)

    expect(computePcmRms(new Int16Array(0))).toBe(0)
    expect(computePcmRms(new Int16Array([0, 0, 0, 0]))).toBe(0)
    expect(computePcmRms(new Int16Array([32767, -32767, 32767, -32767]))).toBeCloseTo(1, 5)
  })

  it('PcmAccumulator：跨扩容按序保留；extract 切出恰好尺寸并在取出后归零', () => {
    const agg = new PcmAccumulator()
    expect(agg.sampleCount).toBe(0)
    expect(agg.extract(), '未累积样本 → null（保持"无捕获样本不回调 onStop"语义）').toBeNull()

    agg.push(new Int16Array([1, 2, 3]))
    agg.push(new Int16Array([4, 5]))
    expect(agg.sampleCount).toBe(5)

    const out = agg.extract()
    expect(out).not.toBeNull()
    expect(Array.from(out as Int16Array)).toEqual([1, 2, 3, 4, 5])
    expect(agg.sampleCount).toBe(0)
    expect(agg.extract(), '取出后再取为 null（reset 语义）').toBeNull()
  })

  it('PcmAccumulator：超过初始容量后仍按序、不丢不漏（2 倍增长路径）', () => {
    const agg = new PcmAccumulator()
    // 初始容量 = PCM_CHUNK_SAMPLES × 1024 = 327,680 样本；推 2000 帧 = 640,000 → 触发一次扩容。
    const frames = 2000
    for (let f = 0; f < frames; f++) {
      const chunk = new Int16Array(PCM_CHUNK_SAMPLES)
      chunk.fill(f + 1) // 每帧一个可辨认的填充值，便于校验顺序
      agg.push(chunk)
    }
    expect(agg.sampleCount).toBe(frames * PCM_CHUNK_SAMPLES)
    const out = agg.extract()
    expect(out?.length).toBe(frames * PCM_CHUNK_SAMPLES)
    const samples = out as Int16Array
    expect(samples[0], '第 1 帧').toBe(1)
    expect(samples[PCM_CHUNK_SAMPLES - 1], '第 1 帧末').toBe(1)
    expect(samples[PCM_CHUNK_SAMPLES], '第 2 帧首（扩容前后衔接处）').toBe(2)
    expect(samples[samples.length - 1], '末帧末').toBe(frames)
  })

  it('SilenceTracker：连续静音累计到时长才触发一次；中途有声音则重新计时', () => {
    const tracker = new SilenceTracker(100) // 100ms = 5 帧
    expect(tracker.push(0)).toBe(false)   // 20ms
    expect(tracker.push(0)).toBe(false)   // 40
    expect(tracker.push(0.5)).toBe(false) // 说话 → 清零
    expect(tracker.silentDurationMs).toBe(0)
    for (let i = 0; i < 4; i++) expect(tracker.push(0)).toBe(false)
    expect(tracker.push(0), '第 5 帧静音累计满 100ms').toBe(true)
    expect(tracker.push(0), '只报一次（防自动结束被重复触发）').toBe(false)
  })

  it('SilenceTracker：阈值边界——恰好等于阈值算"有声音"，低于才算静音', () => {
    const tracker = new SilenceTracker(20, PCM_CHUNK_MS)
    expect(tracker.push(SILENCE_RMS_THRESHOLD)).toBe(false)          // 等于阈值 → 视为有声
    expect(tracker.silentDurationMs).toBe(0)
    expect(tracker.push(SILENCE_RMS_THRESHOLD - 1e-9)).toBe(true)    // 低于阈值 → 一帧即满 20ms
  })

  it('SilenceTracker：durationMs 越大触发得越晚（设置项真的生效）', () => {
    const frames = (durationMs: number): number => {
      const t = new SilenceTracker(durationMs)
      let n = 0
      while (!t.push(0)) n += 1
      return n + 1
    }
    expect(frames(1000)).toBe(50)   // 1000ms / 20ms
    expect(frames(5000)).toBe(250)
  })
})

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
  /** M-26 ③：生产实现改为直接解码进 `getChannelData(0)`（不再产生中间扁平数组），故替身
   *  必须像真 AudioBuffer 一样返回**自身的通道存储**——写进去要能读回来。 */
  channelData: Float32Array
  getChannelData: (channelNumber: number) => Float32Array
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
      channelData: new Float32Array(length),
      getChannelData: (channelNumber: number) => {
        if (channelNumber !== 0) throw new Error(`无此通道：${channelNumber}`)
        return b.channelData
      },
      copied: null,
      copyToChannel: vi.fn((source: Float32Array) => {
        b.copied = source
        b.channelData.set(source)
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

    // 模拟 worklet 发来 3 个 640B chunk（16384 / -16384 / 8192）
    // 末块刻意用**非零哨兵**：若用 0，尾部断言会被"Float32Array 初值本来就是 0"兜住而恒绿。
    const sent = [makeChunk(16384), makeChunk(-16384), makeChunk(8192)]
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
    expect(ctx.buffers[0].copied).toBeNull() // M-26 ③：不再走 copyToChannel，改为直接写通道存储
    const copied = ctx.buffers[0].channelData
    expect(copied).toHaveLength(960)
    expect(copied[0]).toBeCloseTo(16384 / 32767, 7)
    expect(copied[320]).toBeCloseTo(-16384 / 32767, 7)
    expect(copied[640]).toBeCloseTo(8192 / 32767, 7)
    // 尾部边界：直接写入通道后，「长度对但内容错」（例如漏写最后一帧）必须能被抓到。
    // 末块填的是 8192，故这一格非零 —— 写得少一格就是 0，立刻红。
    expect(copied[959]).toBeCloseTo(8192 / 32767, 7)
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
      })

      expect(capturedChunks).toHaveLength(2)
      expect(capturedChunks[0].byteLength).toBe(PCM_CHUNK_BYTES)
      expect(capturedChunks[1].byteLength).toBe(PCM_CHUNK_BYTES)
      // 跨事件聚合：再补 2 样本（不足整块）无输出
      ctx.scriptProcessors[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array([0.5, 0.5]) }
      })
      expect(capturedChunks).toHaveLength(2)

      await capture.stop()
      expect(ctx.buffers[0].length).toBe(640) // 尾部 2 样本（<20ms）未纳入
      expect(ctx.buffers[0].channelData[0]).toBeCloseTo(0.5, 4)
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
