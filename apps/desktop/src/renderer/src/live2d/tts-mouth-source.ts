// apps/desktop/src/renderer/src/live2d/tts-mouth-source.ts
// 阶段 5 批次 C（C1，D5C-01/D5C-02）：TTS 音量口型数据源——MediaElementSource → AnalyserNode → 短窗 RMS
// → 包络纯函数（computeMouthLevel）。attach 把现有 <audio>（TTS 播放宿主 CyTtsPlayer 的隐藏元素，同源
// cyrene:// 页面与资源）挂进 AudioContext graph（createMediaElementSource + Analyser，连 destination 保持
// 播放可闻、口型旁路采样不断播放）；sample 采样当前 RMS 电平 [0,1]；detach 断开 + 挂起 + 平滑态复位；
// dispose close（自建 context）。每元素仅一次（重复 attach 幂等）。可注入 analyserFactory：单测/集成可提供
// { analyser, context } 假源（node/无音频设备环境无真实 AudioContext）。
// 真实 Analyser RMS 准确性归联调肉眼验证（spec §7 风险：cyrene:// MediaElementSource 若实测静音，回退
// decodeAudioData 全 WebAudio 播放路径在 spec 记录、不阻断交付）。
import { computeMouthLevel } from './mouth-level'

/** 口部数据源：attach 挂音频元素 / detach 断开 / sample 采样当前电平 [0,1] / dispose 释放。 */
export interface MouthLevelSource {
  attach(el: HTMLAudioElement): void
  detach(): void
  sample(): number
  dispose(): void
}

/** analyserFactory 注入点：返回 { analyser, context } 对（缺省内部新建真实 AudioContext + AnalyserNode） */
export interface AnalyserPair {
  analyser: AnalyserNode
  context: AudioContext
}

const FFT_SIZE = 256 // 短窗（~5.3ms @48k），doc 05 §10

/** 创建 TTS 口部数据源。`analyserFactory` 注入假源（单测/无音频设备环境）；缺省懒建真实 AudioContext。 */
export function createTtsMouthSource(analyserFactory?: () => AnalyserPair): MouthLevelSource {
  let el: HTMLAudioElement | null = null
  let context: AudioContext | null = null
  let ownedContext: AudioContext | null = null // 自建 context（dispose close；工厂提供的归工厂）
  let analyser: AnalyserNode | null = null
  let sourceNode: MediaElementAudioSourceNode | null = null
  let prevLevel = 0
  let buf = new Float32Array(FFT_SIZE)

  function teardown(): void {
    if (sourceNode) { try { sourceNode.disconnect() } catch { /* 尽力 */ } sourceNode = null }
    if (analyser) { try { analyser.disconnect() } catch { /* 尽力 */ } analyser = null }
    if (context) { try { void context.suspend() } catch { /* 尽力 */ } context = null }
    el = null
    prevLevel = 0
  }

  return {
    attach(next: HTMLAudioElement): void {
      if (el === next && context) return // 同元素重复 attach 幂等
      teardown()
      el = next
      if (analyserFactory) {
        const pair = analyserFactory()
        context = pair.context
        analyser = pair.analyser
      } else {
        const Ctx = globalThis.AudioContext
        if (typeof Ctx !== 'function') return // 无 AudioContext（headless）→ 静默降级（sample 恒 0）
        context = new Ctx()
        ownedContext = context
        analyser = context.createAnalyser()
        analyser.fftSize = FFT_SIZE
      }
      try {
        sourceNode = context.createMediaElementSource(next)
        sourceNode.connect(analyser)
        analyser.connect(context.destination)
        void context.resume()
      } catch {
        // MediaElementSource 已被其它 graph 占用等异常 → 断开清理；attach 不抛（sample 恒 0 降级）
        teardown()
        return
      }
      buf = new Float32Array(analyser.fftSize)
    },
    detach(): void { teardown() },
    sample(): number {
      if (!analyser || !el) return 0
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const rms = Math.sqrt(sum / buf.length)
      prevLevel = computeMouthLevel(rms, prevLevel)
      return prevLevel
    },
    dispose(): void {
      teardown()
      if (ownedContext) { try { void ownedContext.close() } catch { /* 尽力 */ } }
      ownedContext = null
    }
  }
}

// —— mock 合成包络源（CYRENE_MOCK_MOUTH_LEVEL env 桥）——
// CI/集成无真实音频设备，且 mock TTS 是静音 WAV（RMS≈0 无法断言）；集成注入确定性合成序列替代真实
// Analyser（spec §3.1）。step：逐帧台阶序列（0.2→1.0→0 循环），值随采样变化可断言；sine：正弦摆动。

const STEP_SEQ = [0.2, 0.4, 0.6, 0.8, 1.0, 0.8, 0.6, 0.4, 0.2, 0]

/** 合成 step 源（'step'）：attach 后 sample 返回确定性台阶序列，值逐帧变化（集成断言口部随包络变化） */
export function createStepMouthSource(): MouthLevelSource {
  let attached = false
  let i = 0
  return {
    attach(): void { attached = true; i = 0 },
    detach(): void { attached = false; i = 0 },
    sample(): number {
      if (!attached) return 0
      const v = STEP_SEQ[i % STEP_SEQ.length]
      i++
      return v
    },
    dispose(): void { attached = false; i = 0 }
  }
}

/** 合成 sine 源（'sine'）：attach 后 sample 返回确定性正弦序列（0→1→0 摆动） */
export function createSineMouthSource(): MouthLevelSource {
  let attached = false
  let i = 0
  return {
    attach(): void { attached = true; i = 0 },
    detach(): void { attached = false; i = 0 },
    sample(): number {
      if (!attached) return 0
      const v = 0.5 + 0.5 * Math.sin(i * 0.5)
      i++
      return v
    },
    dispose(): void { attached = false; i = 0 }
  }
}
