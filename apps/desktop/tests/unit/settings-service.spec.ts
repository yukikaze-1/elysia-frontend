// tests/unit/settings-service.spec.ts
// Task 8:Main SettingsService 持久化——load 缺失→默认 / save patch merge / 损坏隔离备份 / 版本不匹配回默认 /
// 非法 patch 拒绝 / 原子写产物可读 + handler 接线（env=node，直接调用 createIpcHandler，不经 ipcMain）。
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SettingsService, SETTINGS_FILE_NAME } from '../../src/main/settings/settings-service'
import { DEFAULT_APPEARANCE, DEFAULT_LIVE2D, DEFAULT_SETTINGS, SettingsStateSchema } from '../../src/shared/schemas'
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
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('save：patch merge 保留未触及字段，产物可读且重启可装载', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
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
    const svc2 = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    expect(await svc2.load()).toEqual(saved2)
  })

  it('损坏文件 → 备份 settings.json.corrupt + 回默认（fail-open）', async () => {
    const { dir, safeRoot } = makeDir()
    writeFileSync(settingsPath(dir), 'not-json{{{', { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    const corruptFiles = readdirSync(dir).filter((n) => n.startsWith('settings.json.corrupt-settings-'))
    expect(corruptFiles.length).toBe(1)
    expect(readFileSync(join(dir, corruptFiles[0]), 'utf8')).toBe('not-json{{{') // 现场隔离保留
    expect(logger.warn).toHaveBeenCalledWith('settings:corrupt-isolated', { file: SETTINGS_FILE_NAME, reason: 'unknown' })
  })

  it('版本不匹配（version 非 1）→ 回默认并隔离备份（Minor 19）', async () => {
    const { dir, safeRoot } = makeDir()
    writeFileSync(settingsPath(dir), JSON.stringify({ version: 2, voice: DEFAULT_SETTINGS.voice, dictation: DEFAULT_SETTINGS.dictation }), { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    expect(await svc.load()).toEqual(DEFAULT_SETTINGS)
    expect(readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-settings-'))).toBe(true)
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
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    const state = await svc.load()
    expect(state.version).toBe(1)                                  // 不动 version
    expect(state.voice.enabled).toBe(false)                        // 既有子树保留（不走 corrupt 全量重置）
    expect(state.dictation.sttProfileId).toBe('stt/p1')
    expect(state.live2d).toEqual(DEFAULT_LIVE2D) // .default(DEFAULT_LIVE2D) 补齐（批次 B 全量 10 字段默认）
    expect(readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-settings-'))).toBe(false) // 非 corrupt 路径
  })

  it('部分 patch {enabled:false} 保留 modelId（第三 merge 行）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    const s1 = await svc.save({ live2d: { modelId: 'haru' } })
    expect(s1.live2d).toEqual({ ...DEFAULT_LIVE2D, modelId: 'haru' })
    const s2 = await svc.save({ live2d: { enabled: false } })
    expect(s2.live2d.enabled).toBe(false)   // 本次 patch 生效
    expect(s2.live2d.modelId).toBe('haru')  // 未提交字段保持现值（不重设 null）
    // 无 live2d 段的 patch（如仅 voice）也保留 live2d 子树
    const s3 = await svc.save({ voice: { enabled: true } })
    expect(s3.live2d).toEqual({ ...DEFAULT_LIVE2D, enabled: false, modelId: 'haru' })
  })

  it('IP-1：单字段 patch 不 clobber 已持久化的非默认字段（patch 路径无默认注入）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    // 先设定非默认值：scale 2.5、lipSync false、offsetX 0.4（全部非默认）
    const seeded = await svc.save({ live2d: { scale: 2.5, lipSync: false, offsetX: 0.4 } })
    expect(seeded.live2d.scale).toBe(2.5)
    expect(seeded.live2d.lipSync).toBe(false)
    expect(seeded.live2d.offsetX).toBe(0.4)
    // 单字段 patch：只动 mouseTracking，其余未提交字段必须保持现值（不被 repatch 默认值覆盖）
    const patched = await svc.save({ live2d: { mouseTracking: false } })
    expect(patched.live2d.mouseTracking).toBe(false) // 本字段生效
    expect(patched.live2d.scale).toBe(2.5)           // 未提交非默认字段不被重置为 1
    expect(patched.live2d.lipSync).toBe(false)       // 未被重置回 true
    expect(patched.live2d.offsetX).toBe(0.4)         // 未被重置回 0
    expect(patched.live2d.performanceMode).toBe('auto')
  })

  it('live2d patch 非法（modelId 非 string|null / enabled 非 boolean）→ 拒绝', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    await expect(svc.save({ live2d: { enabled: 'yes' as unknown as boolean } })).rejects.toThrow()
    await expect(svc.save({ live2d: { modelId: 42 as unknown as string | null } })).rejects.toThrow()
  })

  it('zod 拒绝非法 patch（save 落盘前 SettingsStateSchema.parse 兜底）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    await expect(svc.save({ voice: { enabled: 'yes' as unknown as boolean } })).rejects.toThrow()
    await expect(svc.save({ dictation: { insertMode: 'prepend' as unknown as 'append' } })).rejects.toThrow()
    await expect(svc.save({ version: 9 } as unknown as SettingsPatch)).rejects.toThrow() // 版本非 1 拒绝（save 兜底 parse）
  })

  // —— 外观（2026-09-13，doc 03 §12.4 / doc 11 §7.2）：全局字体缩放子树 ——
  it('外观：无 appearance 段的旧 file 正常加载（补默认 100%，不动 version、不走 corrupt）', async () => {
    const { dir, safeRoot } = makeDir()
    // 本项落地前的老 settings.json：有 tools 段但**没有** appearance 段
    const oldFile = {
      version: 1,
      voice: DEFAULT_SETTINGS.voice,
      dictation: DEFAULT_SETTINGS.dictation,
      live2d: { ...DEFAULT_LIVE2D, modelId: 'haru' },
      tools: { grants: [] }
    }
    writeFileSync(settingsPath(dir), JSON.stringify(oldFile), { mode: 0o600 })
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    const state = await svc.load()
    expect(state.version).toBe(1)                       // 不动 version（旧文件不是新版本）
    expect(state.appearance).toEqual(DEFAULT_APPEARANCE) // .default(DEFAULT_APPEARANCE) 补齐 = 100%
    expect(state.live2d.modelId).toBe('haru')           // 既有子树保留
    expect(readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-settings-'))).toBe(false)
  })

  it('外观：patch merge 不丢兄弟字段（第四 merge 行）+ 越界/非整数被拒', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    // 先落一个非默认字号
    const s1 = await svc.save({ appearance: { fontScale: 130 } })
    expect(s1.appearance.fontScale).toBe(130)
    // 只动别的子树 → 字号必须保持现值（漏了 merge 行会被整棵子树替换回默认）
    const s2 = await svc.save({ voice: { autoReadReply: false } })
    expect(s2.appearance.fontScale).toBe(130)
    // 只动字号 → 兄弟字段（voice/live2d）保持现值
    const s3 = await svc.save({ appearance: { fontScale: 90 } })
    expect(s3.appearance.fontScale).toBe(90)
    expect(s3.voice.autoReadReply).toBe(false)
    // 越界与非法类型：schema 在落盘前拒绝（范围与 utils/appearance.ts 的 clamp 同源）
    await expect(svc.save({ appearance: { fontScale: 200 } })).rejects.toThrow()
    await expect(svc.save({ appearance: { fontScale: 50 } })).rejects.toThrow()
    await expect(svc.save({ appearance: { fontScale: 100.5 } })).rejects.toThrow()
    await expect(svc.save({ appearance: { fontScale: 'big' as unknown as number } })).rejects.toThrow()
  })

  it('save 前未 load → 自装载后 merge（不覆盖已有落盘值）', async () => {
    const { dir, safeRoot } = makeDir()
    const seed = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await seed.save({ voice: { autoReadReply: false } })
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    const saved = await svc.save({ voice: { enabled: false } }) // 未显式 load
    expect(saved.voice.autoReadReply).toBe(false) // 已有落盘值保留
    expect(saved.voice.enabled).toBe(false)
  })

  // —— M-19 renderer 半边的 Main 侧配套（2026-09-13）——
  //
  // 目标只有一条：**设置保存失败必须带着一个可展示的码到达 Renderer**。此前裸 fs 错误经
  // `createIpcHandler` 兜底成 `UNKNOWN/内部错误`，Renderer 侧再补 UI 也说不出一句有用的话。
  it('写失败 → SETTINGS_SAVE_FAILED（只带 errno，绝不带路径）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    // 真实构造：把 config 目录整体删掉 → atomicWriteFile 的父目录 realpath/包含性复核失败
    rmSync(dir, { recursive: true, force: true })
    let caught: unknown
    try { await svc.save({ voice: { enabled: false } }) } catch (e) { caught = e }
    expect(caught).toMatchObject({ code: 'SETTINGS_SAVE_FAILED' })
    const message = (caught as Error).message
    expect(message).not.toContain(dir)
    expect(message, 'message 里不得出现任何路径分隔符').not.toMatch(/[/\\]/)
  })

  // 接缝覆盖：走**真实** isolation（不是注入替身）。safeRoot 指向别处 → assertContained 拒绝 → isolate 上抛。
  // 修前该异常会一路穿过 `main/index.ts` 的 eager `await settingsSvc.load()`，把整条启动装配打断
  // （注释却写着"不阻塞启动"）；修后转降级态：启动照常 + 拒绝写入 + 保现场。
  it('隔离失败 → load 不再上抛（启动不被打断）+ 降级态 + 拒绝写入且原始文件逐字节未变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-settings-degraded-'))
    const other = mkdtempSync(join(tmpdir(), 'cy-settings-degraded-root-'))
    const raw = JSON.stringify({ version: 2, voice: DEFAULT_SETTINGS.voice })
    writeFileSync(settingsPath(dir), raw, { mode: 0o600 })
    const counts: string[] = []
    const svc = new SettingsService({
      dir, safeRoot: realpathSync(other), logger, countDiagnostic: (code: string) => { counts.push(code) }
    })
    await expect(svc.load(), '隔离失败不得让 load 上抛').resolves.toEqual(DEFAULT_SETTINGS)
    expect(svc.getLastError(), '必须进入降级态').toBeDefined()
    expect(counts).toContain('settings:degraded')
    await expect(svc.save({ voice: { enabled: false } }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    expect(readFileSync(settingsPath(dir), 'utf8'), '保现场：原文件逐字节未变').toBe(raw)
    rmSync(dir, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  })

  it('未降级时 getLastError 为 undefined 且写入正常（不误报）', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    await svc.load()
    expect(svc.getLastError()).toBeUndefined()
    await expect(svc.save({ voice: { enabled: false } })).resolves.toBeDefined()
  })
})

describe('settings handler（createIpcHandler 接线）', () => {
  it('settings:load 成功 → ok:true 带 SettingsState', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    const h = createIpcHandler(settingsLoadSchema, SettingsStateSchema, () => svc.load(), { sanitize, channel: 'settings:load', logger })
    const res = await h(undefined)
    expect(res).toEqual({ ok: true, data: DEFAULT_SETTINGS })
  })

  it('settings:save 合法 patch → ok:true 带 merge 后新 state', async () => {
    const { dir, safeRoot } = makeDir()
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
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
    const svc = new SettingsService({ dir, safeRoot, logger, countDiagnostic: vi.fn() })
    const h = createIpcHandler(settingsSaveSchema, SettingsStateSchema, (patch) => svc.save(patch), { sanitize, channel: 'settings:save', logger })
    const res = await h({ voice: { enabled: 'x' } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('SCHEMA_VALIDATION_FAILED')
  })
})
