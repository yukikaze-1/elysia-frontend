// tests/unit/settings-tools.spec.ts（node；纯 schema/类型层 + SettingsService save merge）
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStateSchema, SettingsPatchSchema, ToolsSettingsSchema, ToolsSettingsPatchSchema, PermissionGrantSchema, DEFAULT_SETTINGS, DEFAULT_TOOLS } from '../../src/shared/schemas/ipc-response'
import type { SettingsState, SettingsPatch } from '../../src/shared/contracts/voice'
import type { PermissionGrant, ToolsSettings } from '../../src/shared/contracts/tool'
import { SettingsService } from '../../src/main/settings/settings-service'

const GRANT: PermissionGrant = {
  id: 'grant-abc', toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' },
  backendIdentity: 'http://localhost:8000', expiresAt: 1_750_000_000_000, createdAt: '2026-08-20T00:00:00.000Z',
  source: 'directory',
}

describe('ToolsSettingsSchema', () => {
  it('default：无 tools 字段 → 空 grants（旧文件兼容，version 1 不触发损坏）', () => {
    // 全量合法旧文件形状（voice 五必填 + dictation.insertMode——F-1 修复：缺字段 parse 恒失败）
    const parsed = SettingsStateSchema.parse({ ...DEFAULT_SETTINGS })
    expect(parsed.tools).toEqual({ grants: [] })
    const legacy = SettingsStateSchema.parse({ ...DEFAULT_SETTINGS, tools: undefined } as never)   // 显式无 tools（default 兜底）
    expect(legacy.tools).toEqual({ grants: [] })
  })
  it('grant 形状 strict：未知字段拒、toolName 二值、revokeSource 二值可选', () => {
    expect(PermissionGrantSchema.safeParse(GRANT).success).toBe(true)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, toolName: 'desktop.screen.capture' }).success).toBe(false)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, revokeSource: 'user', revokedAt: '2026-08-20T01:00:00.000Z' }).success).toBe(true)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, extra: 1 }).success).toBe(false)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, backendIdentity: undefined }).success).toBe(false)   // backendIdentity 必填
  })
})
describe('SettingsPatchSchema', () => {
  it('tools patch 无默认：单字段 patch 不注入默认 grants（IP-1）', () => {
    const patch: SettingsPatch = { voice: { enabled: false } }
    const parsed = SettingsPatchSchema.parse(patch)
    expect(parsed.voice).toEqual({ enabled: false })
    expect(parsed.tools).toBeUndefined()
  })
  it('tools patch 接受完整 grants 替换', () => {
    const parsed = SettingsPatchSchema.parse({ tools: { grants: [GRANT] } })
    expect(parsed.tools?.grants).toHaveLength(1)
  })
  it('ToolsSettingsPatchSchema 无 default（zod4 下 .default().partial() 不存在，必须独立 schema）', () => {
    expect(ToolsSettingsSchema.parse({}).grants).toEqual([])        // 顶层有 default
    expect(ToolsSettingsPatchSchema.safeParse({}).success).toBe(true)  // patch 无 default 也接受空对象
  })
})
describe('DEFAULT_SETTINGS', () => {
  it('含 tools 空子树 + version 1', () => {
    expect(DEFAULT_SETTINGS.tools).toEqual({ grants: [] })
    expect(DEFAULT_SETTINGS.version).toBe(1)
  })
  it('DEFAULT_SETTINGS.tools 引用 DEFAULT_TOOLS 同一对象（对齐 DEFAULT_LIVE2D 模式）', () => {
    expect(DEFAULT_SETTINGS.tools).toBe(DEFAULT_TOOLS)
  })
  it('类型层：SettingsState 含 tools、SettingsPatch 含 tools?（编译期）', () => {
    const s: SettingsState = DEFAULT_SETTINGS
    expect(s.tools.grants).toEqual([])
  })
})
describe('SettingsService.save tools merge（spec §3.8——不丢 voice/live2d）', () => {
  it('voice patch 不丢 tools；tools patch 不丢 voice/live2d/dictation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-settings-tools-'))
    try {
      const svc = new SettingsService({ dir, safeRoot: dir, logger: { warn: vi.fn() } as never })
      const tools: ToolsSettings = { grants: [GRANT] }
      const s1 = await svc.save({ tools })
      expect(s1.tools).toEqual(tools)
      expect(s1.voice).toEqual(DEFAULT_SETTINGS.voice)   // tools patch 不污染 voice
      const s2 = await svc.save({ voice: { enabled: false } })
      expect(s2.tools).toEqual(tools)                    // voice patch 不丢 tools
      expect(s2.voice.enabled).toBe(false)
      const s3 = await svc.save({})
      expect(s3.tools).toEqual(tools)                    // 空 patch 保持现值
      // 落盘内容：新实例重载保留 tools（原子写 + load 对称）
      const svc2 = new SettingsService({ dir, safeRoot: dir, logger: { warn: vi.fn() } as never })
      expect((await svc2.load()).tools).toEqual(tools)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
