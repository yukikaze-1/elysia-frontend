// tests/unit/live2d-settings.spec.ts
// 阶段 5 批次 B（B5，D5B-06/D5B-08）：Live2DSettings 契约扩 10 字段 + PerformanceMode 四值迁移 + 持久化链兼容。
// 断言：DEFAULT_LIVE2D 全字段、normalizePerformanceMode 迁移、Live2DSettingsSchema.safeParse 对
// performanceMode 'high'/'low' 走 preprocess 归一（I-3，加载路径不 corrupt——测子 schema，R2-1）。
import { describe, expect, it } from 'vitest'
import type { PerformanceMode } from '@shared/contracts/live2d'
import { DEFAULT_LIVE2D, normalizePerformanceMode, Live2DSettingsSchema } from '@shared/schemas'

describe('settings 契约（批次B B5）', () => {
  it('DEFAULT_LIVE2D 含全量 10 字段', () => {
    expect(DEFAULT_LIVE2D).toEqual({
      enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
      mouseTracking: true, autoMotions: true, lipSync: true,
      performanceMode: 'auto', reduceMotion: false
    })
  })

  it('performanceMode 归一：high→quality / low→low_power / 四值原样', () => {
    expect(normalizePerformanceMode('high')).toBe('quality')
    expect(normalizePerformanceMode('low')).toBe('low_power')
    expect(normalizePerformanceMode('auto')).toBe('auto')
    expect(normalizePerformanceMode('quality')).toBe('quality')
    expect(normalizePerformanceMode('balanced')).toBe('balanced')
    expect(normalizePerformanceMode('low_power')).toBe('low_power')
    expect(normalizePerformanceMode('unknown')).toBe('auto') // 未知→兜底 auto
  })

  it('加载路径：live2d 含 performanceMode high/low → Live2DSettingsSchema.safeParse 不 corrupt 且归一（I-3）', () => {
    // 直接测子 schema（SettingsStateSchema 还需 version/voice/dictation，见 R2-1）
    const r1 = Live2DSettingsSchema.safeParse({ enabled: true, modelId: null, performanceMode: 'high' })
    expect(r1.success).toBe(true)
    if (r1.success) expect(r1.data.performanceMode).toBe('quality')
    const r2 = Live2DSettingsSchema.safeParse({ enabled: true, modelId: null, performanceMode: 'low' })
    expect(r2.success).toBe(true)
    if (r2.success) expect(r2.data.performanceMode).toBe('low_power')
  })

  it('缺字段（老文件只有 enabled/modelId）→ 子字段 default 兜缺省进 10 字段', () => {
    const r = Live2DSettingsSchema.safeParse({ enabled: true, modelId: 'haru' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).toEqual({
        enabled: true, modelId: 'haru', scale: 1, offsetX: 0, offsetY: 0,
        mouseTracking: true, autoMotions: true, lipSync: true,
        performanceMode: 'auto', reduceMotion: false
      })
    }
  })

  it('scale/offset 安全钳制（D5B-08）', () => {
    const r = Live2DSettingsSchema.safeParse({ enabled: true, modelId: null, scale: 99, offsetX: 99, offsetY: -99 })
    expect(r.success).toBe(false) // 越界 → 拒绝（而非静默钳制到边界）
  })
})

/** 引用 PerformanceMode 类型标识（编译期：四值 union 存在；本文件同时确保导出可用） */
export type _Live2DSettingsPerformanceMode = PerformanceMode
