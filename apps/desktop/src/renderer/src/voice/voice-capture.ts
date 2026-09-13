// src/renderer/src/voice/voice-capture.ts
// 阶段 4 批次 B：Renderer 麦克风采集（PcmCapture + AudioWorklet）+ PCM 转换纯函数。
//
// 链路：getUserMedia（16k mono，EC/NS/AGC）→ AudioContext({sampleRate:16000}) →
// AudioWorklet.addModule('./pcm-worklet.js') → MediaStreamAudioSourceNode → worklet
// （Float32→Int16，20ms=640B 聚合）→ port.postMessage(Uint8Array 640B) → onChunk(bytes)。
// AudioWorklet 加载失败 → ScriptProcessorNode 降级（同 floatToPcm16 聚合逻辑）。
//
// 安全（design §4.8 / D-P2）：采集仅 Renderer；本模块不触达文件系统/凭据/后端路径；
// 音频样本仅经 onChunk（→ voiceSendAudio → Main → 后端）流出，内存态不落盘。
// CSP 零改动（D-P7）：worklet 经 new URL(...) 由 Vite 以同源 asset 输出，script-src 'self' 放行。
//
// 供 Task 12 voiceStore 消费：start 先 await 成功（控制帧 D-P19 先于采集）、onStop 产本地
// AudioBuffer（试听/replay）、pause/resume 供 ack 背压。

/** 采集采样率：16kHz 单声道（后端 BINARY PCM 唯一支持格式 pcm_s16le/16000/1） */
export const PCM_SAMPLE_RATE = 16000
/** 单 chunk 样本数：20ms @16kHz = 320 样本（后端 VAD 帧 640B/20ms 对齐） */
export const PCM_CHUNK_SAMPLES = 320
/** 单 chunk 字节数：320 样本 × 2B = 640B（PCM s16le 小端） */
export const PCM_CHUNK_BYTES = PCM_CHUNK_SAMPLES * 2
/** 单 chunk 时长（ms）——静音累计以它为单位（20ms 帧，与后端 VAD 帧对齐） */
export const PCM_CHUNK_MS = 20
/** AudioWorklet 处理器注册名（pcm-worklet.js 内 registerProcessor 同名） */
export const PCM_PROCESSOR_NAME = 'pcm-processor'

/**
 * 语音活动检测的判定阈值（RMS，0–1）：低于它即视为"这一帧没有语音"。
 *
 * 取 0.01 ≈ −40 dBFS：EC/NS/AGC 开启后的安静房间底噪通常远低于此，而正常说话远高于此。
 * **刻意不做成设置项**：把裸 RMS 阈值暴露给用户没有可解释的语义（"0.01" 对用户无意义），
 * 设置里只给 doc 11 §3.3 要求的「语音活动检测开关 + 静音结束时长」两项。
 */
export const SILENCE_RMS_THRESHOLD = 0.01

/** 一帧 PCM 的 RMS（0–1）。纯函数，便于单测（静音判定是"何时自动结束录音"的唯一依据）。 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * 静音累计器（doc 11 §3.3「语音活动检测／静音结束时长」，2026-09-13）。
 *
 * 语义：逐帧喂 RMS；连续静音累计到 `durationMs` 时**返回一次 true**（调用方据此自动结束录音），
 * 之后不再重复触发；期间只要有一帧达到阈值就清零重新计时。
 *
 * 为什么是纯类而不是塞进 PcmCapture：判据（"多久算说完"）必须能被确定性单测覆盖——
 * 真实麦克风在 CI 上不可控，把它做成 DOM/音频依赖的逻辑就只能靠人耳验证。
 */
export class SilenceTracker {
  private silentMs = 0
  private fired = false

  constructor(
    private readonly durationMs: number,
    private readonly chunkMs: number = PCM_CHUNK_MS,
    private readonly thresholdRms: number = SILENCE_RMS_THRESHOLD
  ) {}

  /** 喂一帧 RMS；返回本次是否**首次**达到静音时长 */
  push(rms: number): boolean {
    if (rms >= this.thresholdRms) {
      this.silentMs = 0
      return false
    }
    this.silentMs += this.chunkMs
    if (this.fired || this.silentMs < this.durationMs) return false
    this.fired = true
    return true
  }

  /** 已累计的连续静音时长（诊断/断言用） */
  get silentDurationMs(): number {
    return this.silentMs
  }
}

/**
 * Float32 → PCM16 s16le（每样本截断到 [-1,1] 后 round(v*32767)，Int16 LE）。
 * 纯函数可单测；pcm-worklet.js 内联镜像同款转换（worklet 全局作用域无法 import 本模块）。
 */
export function floatToPcm16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]))
    out[i] = Math.round(v * 32767)
  }
  return out
}

/**
 * PCM16 样本 → 640B（20ms）整块聚合。不足整块保留在内部缓冲（停采时尾部 <20ms 丢弃，
 * 与 AudioWorklet 路径一致——worklet 内的部分块主线程不可达）。脚本处理器降级路径用。
 */
export class PcmChunkAggregator {
  private readonly pending = new Int16Array(PCM_CHUNK_SAMPLES)
  private length = 0

  /** 输入 PCM16 样本，返回本次凑齐的 640B chunk（Uint8Array 独立拷贝，PCM s16le LE）。 */
  push(samples: Int16Array): Uint8Array[] {
    const out: Uint8Array[] = []
    for (let i = 0; i < samples.length; i++) {
      this.pending[this.length++] = samples[i]
      if (this.length === PCM_CHUNK_SAMPLES) {
        out.push(new Uint8Array(this.pending.buffer.slice(0)))
        this.length = 0
      }
    }
    return out
  }
}

export interface PcmCaptureOptions {
  /** 每个 640B（20ms）PCM16 chunk 回调；bytes 为独立 Uint8Array 拷贝 */
  onChunk(bytes: Uint8Array): void
  /** stop() 时回调累积音频（AudioBuffer 1 声道 16k）；无捕获样本时不回调 */
  onStop?(audioBuffer: AudioBuffer): void
  /** 指定麦克风 deviceId（MediaTrackConstraints.deviceId；缺省用系统默认） */
  deviceId?: string
  /** 语音活动检测（doc 11 §3.3）：连续静音达到 durationMs 后回调一次（自动结束录音）。
   *  缺省 undefined ⇒ 关闭，行为与开启该设置前完全一致。 */
  silence?: { durationMs: number; onSilence(): void }
}

/** Task 12 可注入 fake 的形状（voiceStore 单测用） */
export interface PcmCaptureLike {
  start(options: PcmCaptureOptions): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
}

/** PcmCapture 自身错误（媒体设备/AudioContext/worklet 不可用等）；getUserMedia/音频错误原样上抛 */
export class PcmCaptureError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PcmCaptureError'
    this.code = code
  }
}

export class PcmCapture implements PcmCaptureLike {
  private mediaStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processingNode: AudioWorkletNode | ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private onChunk: ((bytes: Uint8Array) => void) | null = null
  private onStop: ((audioBuffer: AudioBuffer) => void) | null = null
  private silenceTracker: SilenceTracker | null = null
  private onSilence: (() => void) | null = null
  private readonly floatChunks: Float32Array[] = []
  private totalSamples = 0

  /**
   * 启动采集。AudioWorklet 加载失败自动降级 ScriptProcessorNode（chunk 仍经 onChunk 送达）；
   * getUserMedia / AudioContext 构造失败 → start() reject（voiceStore 层转 micError）。
   */
  async start(options: PcmCaptureOptions): Promise<void> {
    if (this.audioContext) {
      throw new PcmCaptureError('ALREADY_STARTED', 'PcmCapture 已启动')
    }
    if (typeof options.onChunk !== 'function') {
      throw new PcmCaptureError('MISSING_ON_CHUNK', '缺少 onChunk 回调')
    }

    const mediaDevices = globalThis.navigator?.mediaDevices
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new PcmCaptureError('MEDIA_DEVICES_UNAVAILABLE', 'navigator.mediaDevices 不可用（getUserMedia 不受支持）')
    }

    const stream = await mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId,
        channelCount: 1,
        sampleRate: PCM_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    const AudioContextCtor = globalThis.AudioContext
    if (typeof AudioContextCtor !== 'function') {
      for (const track of stream.getTracks()) track.stop()
      throw new PcmCaptureError('AUDIO_CONTEXT_UNAVAILABLE', 'AudioContext 不可用')
    }

    let audioContext: AudioContext | null = null
    try {
      audioContext = new AudioContextCtor({ sampleRate: PCM_SAMPLE_RATE })
      this.mediaStream = stream
      this.audioContext = audioContext
      this.onChunk = options.onChunk
      this.onStop = options.onStop ?? null
      this.silenceTracker = options.silence ? new SilenceTracker(options.silence.durationMs) : null
      this.onSilence = options.silence?.onSilence ?? null
      this.floatChunks.length = 0
      this.totalSamples = 0

      try {
        await this.createWorkletGraph(audioContext, stream)
      } catch (workletErr) {
        // AudioWorklet 加载失败 → ScriptProcessorNode 降级（design §4.8 / Important-7）
        console.warn('[PcmCapture] AudioWorklet 加载失败，降级 ScriptProcessorNode', workletErr)
        this.disposeGraph()
        this.createScriptProcessorGraph(audioContext, stream)
      }
    } catch (err) {
      for (const track of stream.getTracks()) track.stop()
      if (audioContext) await audioContext.close().catch(() => undefined)
      this.clearState()
      throw err
    }
  }

  /** 暂停采集（ack 背压用，D-P3）；suspend 挂起 context 时钟 */
  async pause(): Promise<void> {
    if (this.audioContext) await this.audioContext.suspend()
  }

  async resume(): Promise<void> {
    if (this.audioContext) await this.audioContext.resume()
  }

  /**
   * 停止采集：断节点 → 停轨道 → close context → onStop?.(AudioBuffer)。
   * AudioBuffer 必须先于 audioContext.close() 创建（closed 上下文 createBuffer 抛 InvalidStateError）。
   */
  async stop(): Promise<void> {
    const audioContext = this.audioContext
    const stream = this.mediaStream
    const onStop = this.onStop

    let buffer: AudioBuffer | undefined
    if (audioContext && this.totalSamples > 0) {
      buffer = audioContext.createBuffer(1, this.totalSamples, PCM_SAMPLE_RATE)
      const all = new Float32Array(this.totalSamples)
      let offset = 0
      for (const part of this.floatChunks) {
        all.set(part, offset)
        offset += part.length
      }
      buffer.copyToChannel(all, 0)
    }

    this.disposeGraph()
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
    if (audioContext) await audioContext.close().catch(() => undefined)
    this.clearState()

    if (onStop && buffer) onStop(buffer)
  }

  /** AudioWorklet 主路径：addModule → AudioWorkletNode → 源连接 → port.onmessage → onChunk */
  private async createWorkletGraph(audioContext: AudioContext, stream: MediaStream): Promise<void> {
    const worklet = audioContext.audioWorklet
    if (!worklet || typeof worklet.addModule !== 'function') {
      throw new PcmCaptureError('AUDIO_WORKLET_UNAVAILABLE', 'AudioWorklet 不可用')
    }
    const workletUrl = new URL('./pcm-worklet.js', import.meta.url).href
    await worklet.addModule(workletUrl)

    const AudioWorkletNodeCtor = globalThis.AudioWorkletNode
    if (typeof AudioWorkletNodeCtor !== 'function') {
      throw new PcmCaptureError('AUDIO_WORKLET_NODE_UNAVAILABLE', 'AudioWorkletNode 不可用')
    }

    const source = audioContext.createMediaStreamSource(stream)
    source.channelCount = 1
    source.channelCountMode = 'explicit'

    const node = new AudioWorkletNodeCtor(audioContext, PCM_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit'
    })

    node.port.onmessage = (event: MessageEvent): void => {
      this.consumeChunk(new Uint8Array(event.data))
    }

    source.connect(node)
    // 输出接 0 增益节点保 graph 存活（process() 持续被调用）且静音（防麦克风回放）
    const silent = audioContext.createGain()
    silent.gain.value = 0
    node.connect(silent)
    silent.connect(audioContext.destination)

    this.sourceNode = source
    this.processingNode = node
    this.silentGain = silent
  }

  /** ScriptProcessorNode 降级路径：onaudioprocess → floatToPcm16 → 640B 聚合 → onChunk */
  private createScriptProcessorGraph(audioContext: AudioContext, stream: MediaStream): void {
    const source = audioContext.createMediaStreamSource(stream)
    source.channelCount = 1
    source.channelCountMode = 'explicit'

    const processor = audioContext.createScriptProcessor(0, 1, 1)
    const aggregator = new PcmChunkAggregator()
    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0))
      for (const chunk of aggregator.push(pcm)) {
        this.consumeChunk(chunk)
      }
    }

    source.connect(processor)
    const silent = audioContext.createGain()
    silent.gain.value = 0
    processor.connect(silent)
    silent.connect(audioContext.destination)

    this.sourceNode = source
    this.processingNode = processor
    this.silentGain = silent
  }

  /** 统一 chunk 消费：Int16→Float32 累积（供 onStop AudioBuffer）+ 转发 onChunk + 静音判定 */
  private consumeChunk(bytes: Uint8Array): void {
    const sampleCount = bytes.byteLength / 2
    const f32 = new Float32Array(sampleCount)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < sampleCount; i++) {
      f32[i] = view.getInt16(i * 2, true) / 32767
    }
    // 语音活动检测（doc 11 §3.3）：用**已有**的 PCM 帧算 RMS，不额外挂 AnalyserNode、不动 worklet 热路径
    if (this.silenceTracker?.push(computeRms(f32))) {
      const notify = this.onSilence
      this.onSilence = null   // 只报一次（stop 之后即便还有在途 chunk 也不再触发）
      notify?.()
    }
    this.floatChunks.push(f32)
    this.totalSamples += sampleCount
    this.onChunk?.(bytes)
  }

  private disposeGraph(): void {
    try {
      this.processingNode?.disconnect()
    } catch {
      /* 节点可能已 close 断开 */
    }
    try {
      this.silentGain?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      this.sourceNode?.disconnect()
    } catch {
      /* ignore */
    }
    this.processingNode = null
    this.silentGain = null
    this.sourceNode = null
  }

  private clearState(): void {
    this.mediaStream = null
    this.audioContext = null
    this.onChunk = null
    this.onStop = null
    this.silenceTracker = null
    this.onSilence = null
    this.floatChunks.length = 0
    this.totalSamples = 0
  }
}
