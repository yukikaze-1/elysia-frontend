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
/** AudioWorklet 处理器注册名（pcm-worklet.js 内 registerProcessor 同名） */
export const PCM_PROCESSOR_NAME = 'pcm-processor'

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

  /** 统一 chunk 消费：Int16→Float32 累积（供 onStop AudioBuffer）+ 转发 onChunk */
  private consumeChunk(bytes: Uint8Array): void {
    const sampleCount = bytes.byteLength / 2
    const f32 = new Float32Array(sampleCount)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < sampleCount; i++) {
      f32[i] = view.getInt16(i * 2, true) / 32767
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
    this.floatChunks.length = 0
    this.totalSamples = 0
  }
}
