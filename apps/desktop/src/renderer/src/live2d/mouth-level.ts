// apps/desktop/src/renderer/src/live2d/mouth-level.ts
// 阶段 5 批次 C（C1，D5C-02）：口部电平包络纯函数——短窗 RMS → 噪声门限 + 攻放不对称一阶平滑 → [0,1]。
// 纯函数（同 param-anim 先例）：给定 (rms, 上一帧电平, opts) 返回本帧电平；平滑态由调用方（TtsMouthSource）
// 持有 prevLevel 逐帧喂回。硬门限语义（doc 05 §10「噪声门限」）：rms < noiseFloor 直接归 0（静音/无输入
// 不产生口型动作）；attack 快（~50ms）/ release 慢（~250ms）——说话起始嘴张得快、停顿嘴合得慢。
export interface MouthLevelOptions {
  /** 噪声门限（rms 低于此值 → 硬门直接 0）。缺省 0.02 */
  noiseFloor?: number
  /** 上升（attack）一阶平滑时间常数（ms）。缺省 50 */
  attackMs?: number
  /** 下降（release）一阶平滑时间常数（ms）。缺省 250 */
  releaseMs?: number
  /** 本帧时长（ms）。缺省 16（~60fps） */
  dtMs?: number
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** 口部电平包络：rms（短窗均方根）→ [0,1] 口型电平。
 *  硬门限：rms < noiseFloor → 0（不进入平滑，静音直接归零）。
 *  否则 target = clamp01(rms)，按方向选择 attack/release 时间常数做一阶平滑：
 *  alpha = dtMs / 时间常数，钳 ≤1 限单帧最大变化率；返回 clamp01。 */
export function computeMouthLevel(rms: number, prevLevel: number, opts: MouthLevelOptions = {}): number {
  const noiseFloor = opts.noiseFloor ?? 0.02
  if (rms < noiseFloor) return 0
  const attackMs = opts.attackMs ?? 50
  const releaseMs = opts.releaseMs ?? 250
  const dtMs = opts.dtMs ?? 16
  const target = clamp01(rms)
  const tc = target > prevLevel ? attackMs : releaseMs
  const alpha = Math.min(1, dtMs / tc)
  return clamp01(prevLevel + (target - prevLevel) * alpha)
}
