// tests/unit/settings-service.spec.ts
// Task 8:Main SettingsService 持久化——load 缺失→默认 / save patch merge / 损坏隔离备份 / 版本不匹配回默认 /
// 非法 patch 拒绝 / 原子写产物可读 + handler 接线（env=node，直接调用 createIpcHandler，不经 ipcMain）。
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsService, SETTINGS_FILE_NAME } from '../../src/main/settings/settings-service'
import { DEFAULT_SETTINGS, SettingsStateSchema } from '../../src/shared/schemas'
import type { SettingsPatch } from '../../src/shared/contracts'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { settingsLoadSchema, settingsSaveSchema } from '../../src/main/ipc/channels'
import type { Logger } from '../../src/main/diagnostics/logger'
import type { MessageSanitizer } from '../../src/main/diagnostics/sanitize'

const sanitize: MessageSanitizer = (m) => m
const logger = {
  error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined)
} as unknown as Logger

function makeDir(): { dir: string; safeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'cy-settings-'))
  return { dir: root, safeRoot: root }
}
function settingsPath(dir: string): string { return join(dir, SETTINGS_FILE_NAME) }

describe('SettingsService', () => {
  it('load：文件缺失 → DEFAULT_SETTINGS（不落盘）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('save：patch merge 保留未触及字段，产物可读且重启可装载', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    await svc.load()
    const saved = await svc.save({ voice: { enabled: false } })
    expect(saved.voice.enabled).toBe(false)
    expect(saved.voice.autoReadReply).toBe(true)          // 未触及字段保留
    expect(saved.voice.micDeviceId).toBeUndefined()
    expect(saved.dictation.insertMode).toBe('append')     // dictation 子树原样
    expect(saved.version).toBe(1)
    // 原子写产物：JSON 可读、与返回值一致、无 .tmp 残留
    const onDisk = JSON.parse(readFileSync(settingsPath(dir), 'utf8'))
    expect(onDisk).toEqual(saved)
    expect(existsSync(`${settingsPath(dir)}.tmp`)).toBe(false)
    // 二次 save 只 merge 该子树，前次已改字段保持
    const saved2 = await svc.save({ dictation: { insertMode: 'replace_selection' } })
    expect(saved2.voice.enabled).toBe(false)
    expect(saved2.dictation.insertMode).toBe('replace_selection')
    // 新实例重载 → 持久化值生效
    const svc2 = new SettingsService({ dir, safeRoot, logger })
    expect(await svc2.load()).toEqual(saved2)
  })

  it('损坏文件 → 备份 settings.json.corrupt + 回默认（fail-open）', async () => {
    const { dir, safeRoot } = makeDir()
    writeFileSync(settingsPath(dir), 'not-json{{{', { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(`${settingsPath(dir)}.corrupt`)).toBe(true)
    expect(readFileSync(`${settingsPath(dir)}.corrupt`, 'utf8')).toBe('not-json{{{') // 现场隔离保留
    expect(logger.warn).toHaveBeenCalledWith('settings:corrupt-isolated', { file: SETTINGS_FILE_NAME })
  })

  it('版本不匹配（version 非 1）→ 回默认并隔离备份（Minor 19）', async () => {
    const { dir, safeRoot } = makeDir()
    writeFileSync(settingsPath(dir), JSON.stringify({ version: 2, voice: DEFAULT_SETTINGS.voice, dictation: DEFAULT_SETTINGS.dictation }), { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(`${settingsPath(dir)}.corrupt`)).toBe(true)
  })

  // —— 阶段 5 批次 A（A6，D5A-10）：live2d 段向后兼容 + 部分 patch merge ——
  it('无 live2d 段旧 file 正常加载（默认 enabled:true/modelId:null，不动 version 与既有子树）', async () => {
    const { dir, safeRoot } = makeDir()
    // 阶段 4 批次 B 时代的老 settings.json：只有 version/voice/dictation，无 live2d 段
    const oldFile = {
      version: 1,
      voice: { enabled: false, realtimeEnabled: true, autoReadReply: false, showCaptions: true, consentBackendStt: true },
      dictation: { sttProfileId: 'stt/p1', insertMode: 'replace_selection' }
    }
    writeFileSync(settingsPath(dir), JSON.stringify(oldFile), { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger })
    const state = await svc.load()
    expect(state.version).toBe(1)                                  // 不动 version
    expect(state.voice.enabled).toBe(false)                        // 既有子树保留（不走 corrupt 全量重置）
    expect(state.dictation.sttProfileId).toBe('stt/p1')
    expect(state.live2d).toEqual({ enabled: true, modelId: null }) // .default(DEFAULT_LIVE2D) 补齐
    expect(existsSync(`${settingsPath(dir)}.corrupt`)).toBe(false) // 非 corrupt 路径
  })

  it('部分 patch {enabled:false} 保留 modelId（第三 merge 行）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    await svc.load()
    const s1 = await svc.save({ live2d: { modelId: 'haru' } })
    expect(s1.live2d).toEqual({ enabled: true, modelId: 'haru' })
    const s2 = await svc.save({ live2d: { enabled: false } })
    expect(s2.live2d.enabled).toBe(false)   // 本次 patch 生效
    expect(s2.live2d.modelId).toBe('haru')  // 未提交字段保持现值（不重设 null）
    // 无 live2d 段的 patch（如仅 voice）也保留 live2d 子树
    const s3 = await svc.save({ voice: { enabled: true } })
    expect(s3.live2d).toEqual({ enabled: false, modelId: 'haru' })
  })

  it('live2d patch 非法（modelId 非 string|null / enabled 非 boolean）→ 拒绝', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    await svc.load()
    await expect(svc.save({ live2d: { enabled: 'yes' as unknown as boolean } })).rejects.toThrow()
    await expect(svc.save({ live2d: { modelId: 42 as unknown as string | null } })).rejects.toThrow()
  })

  it('zod 拒绝非法 patch（save 落盘前 SettingsStateSchema.parse 兜底）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    await svc.load()
    await expect(svc.save({ voice: { enabled: 'yes' as unknown as boolean } })).rejects.toThrow()
    await expect(svc.save({ dictation: { insertMode: 'prepend' as unknown as 'append' } })).rejects.toThrow()
    await expect(svc.save({ version: 9 } as unknown as SettingsPatch)).rejects.toThrow() // 版本非 1 拒绝（save 兜底 parse）
  })

  it('save 前未 load → 自装载后 merge（不覆盖已有落盘值）', async () => {
    const { dir, safeRoot } = makeDir()
    const seed = new SettingsService({ dir, safeRoot, logger })
    await seed.save({ voice: { autoReadReply: false } })
    const svc = new SettingsService({ dir, safeRoot, logger })
    const saved = await svc.save({ voice: { enabled: false } }) // 未显式 load
    expect(saved.voice.autoReadReply).toBe(false) // 已有落盘值保留
    expect(saved.voice.enabled).toBe(false)
  })
})

describe('settings handler（createIpcHandler 接线）', () => {
  it('settings:load 成功 → ok:true 带 SettingsState', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    const h = createIpcHandler(settingsLoadSchema, SettingsStateSchema, () => svc.load(), { sanitize, channel: 'settings:load', logger })
    const res = await h(undefined)
    expect(res).toEqual({ ok: true, data: DEFAULT_SETTINGS })
  })

  it('settings:save 合法 patch → ok:true 带 merge 后新 state', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    const h = createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => svc.save(patch), { sanitize, channel: 'settings:save', logger })
    const res = await h({ voice: { enabled: false } })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.voice.enabled).toBe(false)
      expect(res.data.dictation.insertMode).toBe('append')
    }
  })

  it('settings:save 非法 patch → ok:false SCHEMA_VALIDATION_FAILED', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger })
    const h = createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => svc.save(patch), { sanitize, channel: 'settings:save', logger })
    const res = await h({ voice: { enabled: 'x' } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
})
