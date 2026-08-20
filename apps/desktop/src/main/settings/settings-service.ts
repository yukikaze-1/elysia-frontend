// src/main/settings/settings-service.ts
// 阶段 4 批次 B（spec §5.1 本地设置，docs/06 §14 Main 持久化边界）：settings.json（dirs.config）前端自有设置持久化。
// 纪律：复用 atomicWriteFile（safeRoot 必填，I2）/ openSafeFile（既有持久化通道，不手写 tmp+rename）；
// 损坏/版本不匹配 → 备份 settings.json.corrupt + 回默认（fail-open，不阻塞启动，与 SessionStore 同款隔离重建）；
// save 为 patch merge（未提交字段保持现值），落盘前 SettingsStateSchema.parse 兜底（Minor 19：version 非 1 拒绝）。
import { join } from 'path'
import { rename } from 'fs/promises'
import { atomicWriteFile } from '../credentials/atomic-write'
import { openSafeFile } from '../persistence/safe-open'
import { DEFAULT_SETTINGS, SettingsStateSchema } from '@shared/schemas'
import type { SettingsPatch, SettingsState } from '@shared/contracts'
import type { Logger } from '../diagnostics/logger'

export interface SettingsServiceDeps {
  dir: string
  safeRoot: string
  logger: Logger
}

export const SETTINGS_FILE_NAME = 'settings.json'

export class SettingsService {
  private readonly file: string
  private state: SettingsState = DEFAULT_SETTINGS
  private loaded = false

  constructor(private readonly deps: SettingsServiceDeps) {
    this.file = join(deps.dir, SETTINGS_FILE_NAME)
  }

  /**
   * 装载：文件缺失 → DEFAULT_SETTINGS；存在 → openSafeFile + JSON parse + SettingsStateSchema.safeParse；
   * 失败（损坏/版本不匹配/非普通文件/权限不符）→ 备份 ${file}.corrupt + 回默认（fail-open）。
   */
  async load(): Promise<SettingsState> {
    try {
      const { fd } = await openSafeFile(this.file, { mode: 'existing', purpose: 'read', safeRoot: this.deps.safeRoot })
      try {
        const parsed = SettingsStateSchema.safeParse(JSON.parse(await fd.readFile('utf8')))
        if (!parsed.success) throw new Error('settings:invalid') // 进 corrupt 路径（含 Minor 19 版本非 1）
        this.state = parsed.data
      } finally {
        await fd.close()
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = DEFAULT_SETTINGS // 首次启动无文件
        this.loaded = true
        return this.state
      }
      this.deps.logger.warn('settings:corrupt-isolated', { file: SETTINGS_FILE_NAME })
      await rename(this.file, `${this.file}.corrupt`).catch(() => {}) // 隔离保留现场，不污染后续写入
      this.state = DEFAULT_SETTINGS
    }
    this.loaded = true
    return this.state
  }

  /**
   * 局部更新（settings:save）：merge（{...state, ...patch, voice: {...state.voice, ...patch.voice}, dictation: {...}}）
   * → SettingsStateSchema.parse（非法 patch/版本不匹配拒绝）→ atomicWriteFile 原子落盘 → 内存态更新后返回新 state。
   * patch.voice/dictation 缺省时展开 no-op，保持对应子树现值；未 load 前 save 先自装载（防丢已有落盘值）。
   */
  async save(patch: SettingsPatch): Promise<SettingsState> {
    if (!this.loaded) await this.load()
    const next: SettingsState = {
      ...this.state,
      ...patch,
      voice: { ...this.state.voice, ...patch.voice },
      dictation: { ...this.state.dictation, ...patch.dictation },
      live2d: { ...this.state.live2d, ...patch.live2d }, // 阶段 5 批次 A（D5A-10）：部分 patch（如 {enabled:false}）不丢 modelId
      tools: { ...this.state.tools, ...patch.tools }   // 阶段 6 批次 C：tools 子树 merge（对齐 live2d 既有模式；patch.tools 缺省展开 no-op 保持现值）
    }
    const newState = SettingsStateSchema.parse(next)
    await atomicWriteFile(this.file, JSON.stringify(newState), { safeRoot: this.deps.safeRoot })
    this.state = newState
    return newState
  }
}
