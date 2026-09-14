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
//
// M-26（2026-09-14）：录音段内存曾是「每帧一个 Float32Array（10 分钟 = 30000 个对象）
// ＋ stop() 先拼一个同尺寸扁平数组再拷进 AudioBuffer」⇒ 常驻约 36.6MB，且停止瞬间
// flat 与全部碎片**同时存活**（实测 73.2MB，另加浏览器侧那个 AudioBuffer）。现改为：
// ① 累积**原始 Int16**（1 个可增长数组，10 分钟实测约 20MB，2 倍增长浪费 9%）；
// ② 静音判定改由 `computePcmRms` **直接读 Int16**，热路径不再分配 float 数组
// （与 `computeRms(floatToPcm16(x)/32767)` 的等价性有专门用例钉住）；
// ③ stop() 直接把解码结果写进 `AudioBuffer.getChannelData(0)`，**不再产生中间扁平数组**。
// 结果：常驻 36.6MB → 约 20MB（−45%），停止瞬间同步存活 73.2MB → 约 20MB。
// **onStop(AudioBuffer) 契约未变**（store/组件侧零改动）。量化过程见决策记录：
// docs/review/2026-09-14-M-26录音PCM缓冲-决策记录.md

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

/**
 * 一帧 **Int16** PCM 的 RMS（0–1）。**与 `computeRms(floatToPcm16(x) / 32767)` 数值等价**
 * （M-26 改造的可行性前提，由 `tests/unit/voice-capture.spec.ts` 的特征化用例钉住）：
 * `floatToPcm16` 就是 `round(clamp(v) * 32767)`，故除以 32767 精确还原同一套代数，
 * 唯一差别是 Int16 的量化误差（约 3.05e-5），相对 `SILENCE_RMS_THRESHOLD = 1e-2` 小三个数量级。
 *
 * 存在的理由：它让静音判定**不再需要在热路径上把每帧解码成 Float32Array**——那正是 M-26 里
 * 30000 个短命对象与 36.6MB 的来源。`computeRms` 保留为 Float32 侧的规范实现（其判据用例未动）。
 */
export function computePcmRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32767
    sum += v * v
  }
  return Math.sqrt(sum / pcm.length)
}

/**
 * 录音整段的**原始 Int16** 累积器（M-26）。取代原先"每 20ms 一个 Float32Array 塞进数组"：
 * 全程只持有**一个**可增长 `Int16Array`，容量按 2 倍增长（实测 10 分钟下浪费 9%），
 * `extract()` 时切出恰好尺寸的一份并**立即释放**内部大缓冲。
 *
 * 单位是**样本**不是字节：16kHz 单声道下 10 分钟 = 9,600,000 样本 ≈ 18.3MB（Int16）。
 * 首帧预分配 320KB（≈10 秒），故典型 10–30 秒语音消息**全程不扩容**。
 * （曾考虑 1.3 倍增长以省下那 9%：实测只多省 1.1MB，不值得多 3 倍次数的拷贝。）
 */
export class PcmAccumulator {
  private buf = new Int16Array(PCM_CHUNK_SAMPLES * 1024)
  private length = 0

  /** 追加一块 Int16 样本；容量不足则扩容后拷贝旧数据 */
  push(samples: Int16Array): void {
    const need = this.length + samples.length
    if (need > this.buf.length) {
      let cap = this.buf.length
      while (cap < need) cap *= 2
      const next = new Int16Array(cap)
      next.set(this.buf.subarray(0, this.length))
      this.buf = next
    }
    this.buf.set(samples, this.length)
    this.length = need
  }

  /** 已累积样本数 */
  get sampleCount(): number {
    return this.length
  }

  /**
   * 切出恰好尺寸的一份并释放内部缓冲（调用后 `sampleCount === 0`）。
   * 未累积任何样本时返回 `null`——保持"无捕获样本不回调 onStop"的既有语义。
   */
  extract(): Int16Array | null {
    if (this.length === 0) return null
    const out = this.buf.slice(0, this.length)
    this.buf = new Int16Array(0)
    this.length = 0
    return out
  }

  /** 丢弃全部累积（start 复位 / stop 收尾）。**恢复到初始容量**而非清成 0 长：同一实例可能被
   *  复用（重录 = discard 后再次 start），留一个 0 长缓冲会让下一次录音从零重新扩容。 */
  reset(): void {
    this.buf = new Int16Array(PCM_CHUNK_SAMPLES * 1024)
    this.length = 0
  }
}

export interface PcmCaptureOptions {
  /** 每个 640B（20ms）PCM16 chunk 回调；bytes 为独立 Uint8Array 拷贝。
   *  2026-09-13（type-aware 全集）：三个回调原按「方法」声明（`onChunk(bytes): void`），
   *  于是 `this.onChunk = options.onChunk` 这种摘取会被 `unbound-method` 判为"this 失去保证"。
   *  它们本来就是**回调值**而不是对象方法 ⇒ 改按属性声明（`onChunk: (bytes) => void`）。
   *  纯类型面改动，运行期语义不变；反过来若调用方传的是 `obj.method`，现在会在调用点被如实报出来。 */
  onChunk: (bytes: Uint8Array) => void
  /** stop() 时回调累积音频（AudioBuffer 1 声道 16k）；无捕获样本时不回调 */
  onStop?: (audioBuffer: AudioBuffer) => void
  /** 指定麦克风 deviceId（MediaTrackConstraints.deviceId；缺省用系统默认） */
  deviceId?: string
  /** 语音活动检测（doc 11 §3.3）：连续静音达到 durationMs 后回调一次（自动结束录音）。
   *  缺省 undefined ⇒ 关闭，行为与开启该设置前完全一致。 */
  silence?: { durationMs: number; onSilence: () => void }
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
  private readonly pcm = new PcmAccumulator()

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
      this.pcm.reset()

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

    // M-26 ③：**直接**解码进 AudioBuffer 的通道数据，不再先拼一个等长 Float32Array 再
    // copyToChannel（那一份中间缓冲在 10 分钟录音下是 36.6MB）。`getChannelData` 返回的
    // 就是 AudioBuffer 自己的存储，写入零额外开销。
    // 另：原实现的缓冲构建在 try/catch 之外——一旦 createBuffer/copyToChannel 抛错，下面的
    // 轨道停止与 context 关闭**全被跳过**（麦克风白占、AudioContext 泄漏）。现改为 finally
    // 兜底：无论缓冲是否建成，资源都释放；且 onStop 仍在 finally 之前调用，故"无缓冲不回调"
    // 的语义未变。
    let buffer: AudioBuffer | undefined
    try {
      if (audioContext && this.pcm.sampleCount > 0) {
        const pcm = this.pcm.extract()
        if (pcm) {
          buffer = audioContext.createBuffer(1, pcm.length, PCM_SAMPLE_RATE)
          const channel = buffer.getChannelData(0)
          for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32767
        }
      }
      if (onStop && buffer) onStop(buffer)
    } finally {
      this.pcm.reset()
      this.disposeGraph()
      if (stream) {
        for (const track of stream.getTracks()) track.stop()
      }
      if (audioContext) await audioContext.close().catch(() => undefined)
      this.clearState()
    }
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
      // `MessageEvent.data` 是 any：AudioWorklet 侧 postMessage 的负载是 **Uint8Array**
      //（见文件头注释「port.postMessage(Uint8Array 640B)」），浏览器也可能给 ArrayBuffer。
      // 两种形态都**构造成新视图**——`PcmCaptureOptions.onChunk` 的契约是"bytes 为独立拷贝"，
      // 不能把收到的数组原样转出去。其余形态丢弃：不猜、也不让 any 顺着类型面扩散。
      // （2026-09-13 type-aware 全集；本条第一版只认 ArrayBuffer，被既有 `voice-capture.spec.ts` 当场抓红。）
      const data: unknown = event.data
      if (data instanceof Uint8Array) { this.consumeChunk(new Uint8Array(data)); return }
      if (data instanceof ArrayBuffer) { this.consumeChunk(new Uint8Array(data)); return }
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

  /** 统一 chunk 消费：累积原始 Int16（供 onStop AudioBuffer）+ 转发 onChunk + 静音判定 */
  private consumeChunk(bytes: Uint8Array): void {
    // M-26 ②：这里原先每帧分配一个 Float32Array（320 样本）只为算 RMS，并把它**留下**到停止
    // ——10 分钟就是 30000 个对象、36.6MB。现在只切一个零拷贝视图，RMS 直接读 Int16
    //（`computePcmRms`，与 float 路径数值等价，见其注释），累积交给 PcmAccumulator 单缓冲。
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
    // 语音活动检测（doc 11 §3.3）：用**已有**的 PCM 帧算 RMS，不额外挂 AnalyserNode、不动 worklet 热路径
    if (this.silenceTracker?.push(computePcmRms(pcm))) {
      const notify = this.onSilence
      this.onSilence = null   // 只报一次（stop 之后即便还有在途 chunk 也不再触发）
      notify?.()
    }
    this.pcm.push(pcm)
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
    this.pcm.reset()
  }
}
