// src/renderer/src/voice/pcm-worklet.d.ts
// pcm-worklet.js（AudioWorkletProcessor）的静态类型声明。
//
// pcm-worklet.js 不是 ES 模块、不经 import 引用：Vite 以 asset 输出（new URL('./pcm-worklet.js',
// import.meta.url).href），运行时经 audioContext.audioWorklet.addModule(url) 加载到
// AudioWorkletGlobalScope。因此本文件不声明任何模块导出，仅补齐项目 TypeScript（5.6）DOM lib
// 缺失的 AudioWorkletGlobalScope 全局（AudioWorkletProcessor / registerProcessor），
// 作为 worklet 代码的类型契约与文档。若未来 DOM lib 补齐同名全局，直接删除本文件即可。
//
// 消息契约见 pcm-worklet.js 顶部注释：worklet 经 port.postMessage(Uint8Array 640B) 发送
// PCM s16le 小端 chunk（320 样本 = 20ms @16kHz 单声道）。

declare class AudioWorkletProcessor {
  /** 与主线程 AudioWorkletNode.port 对端的 MessagePort */
  readonly port: MessagePort
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void
