/* global AudioWorkletProcessor, registerProcessor */
// apps/desktop/src/renderer/src/voice/pcm-worklet.js
// AudioWorkletProcessor：麦克风 Float32 → PCM s16le（Int16）→ 20ms（320 样本 / 640B @16kHz 单声道）聚合 → port.postMessage。
//
// 运行于 AudioWorkletGlobalScope（与主线程隔离，无法 import 主线程 TS 模块），
// 因此内联镜像 voice-capture.ts 中 floatToPcm16 + PcmChunkAggregator 的转换逻辑（修改须两侧同步）。
// 上下文固定 sampleRate=16000（voice-capture.ts 以 { sampleRate: 16000 } 创建 AudioContext），
// 故聚合窗口写死 320 样本，无需读取 AudioWorkletGlobalScope.sampleRate 全局。
//
// 消息契约：port.postMessage(Uint8Array 640B)——PCM s16le 小端，320 样本 = 20ms，
// 与后端 BINARY PCM 帧的 640B/20ms VAD 对齐（backend-adapter 侧直接透传）。
// 主线程 AudioWorkletNode.port.onmessage 收到后 onChunk(new Uint8Array(e.data))（再拷贝一份归消费者）。

const CHUNK_SAMPLES = 320 // 20ms @ 16kHz 单声道（640B / chunk）

class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    /** 当前未满 chunk 的 Int16 样本 */
    this._pending = new Int16Array(CHUNK_SAMPLES)
    this._length = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0] // 单声道（channelCount:1）；退化取首通道
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i] > 1 ? 1 : channel[i] < -1 ? -1 : channel[i]
        this._pending[this._length++] = Math.round(v * 32767)
        if (this._length === CHUNK_SAMPLES) {
          // 视图不拷贝——postMessage 结构化克隆给主线程副本后，立即换新缓冲不再写旧缓冲
          this.port.postMessage(new Uint8Array(this._pending.buffer))
          this._pending = new Int16Array(CHUNK_SAMPLES)
          this._length = 0
        }
      }
    }
    return true // 保持处理器存活
  }
}

registerProcessor('pcm-processor', Pcm16Processor)
