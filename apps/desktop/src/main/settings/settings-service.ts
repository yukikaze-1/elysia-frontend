// src/main/settings/settings-service.ts
// 阶段 4 批次 B（spec §5.1 本地设置，docs/06 §14 Main 持久化边界）：settings.json（dirs.config）前端自有设置持久化。
// 纪律：复用 atomicWriteFile（safeRoot 必填，I2）/ openSafeFile（既有持久化通道，不手写 tmp+rename）；
// 损坏/版本不匹配 → 备份 settings.json.corrupt + 回默认（fail-open，不阻塞启动，与 SessionStore 同款隔离重建）；
// save 为 patch merge（未提交字段保持现值），落盘前 SettingsStateSchema.parse 兜底（Minor 19：version 非 1 拒绝）。
import { join } from 'path'
import { atomicWriteFile } from '../credentials/atomic-write'
import { openSafeFile } from '../persistence/safe-open'
import { createCorruptIsolation, type CorruptIsolation } from '../persistence/corrupt-isolation'
import { toWriteFailure } from '../persistence/write-failure'
import { DEFAULT_SETTINGS, SettingsStateSchema } from '@shared/schemas'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { SettingsPatch, SettingsState } from '@shared/contracts'
import type { Logger } from '../diagnostics/logger'

export interface SettingsServiceDeps {
  dir: string
  safeRoot: string
  logger: Logger
  countDiagnostic(code: string): void
}

export const SETTINGS_FILE_NAME = 'settings.json'

export class SettingsService {
  private readonly file: string
  private readonly isolation: CorruptIsolation
  private state: SettingsState = DEFAULT_SETTINGS
  private loaded = false
  /**
   * 损坏文件**隔离失败**后的降级态（2026-09-13，H-11b 同族发现）。
   *
   * 此前 `load()` 的 catch 里直接 `await isolate(...)`：隔离本身失败时异常会继续上抛，而
   * `main/index.ts:374` 是 **eager `await settingsSvc.load()`**（注释写着"不阻塞启动"）——
   * 即"配置文件是符号链接 / 被 AV 或备份代理锁住 → 隔离改名失败"这条链会把**整条启动装配**打断。
   * 现改为进入降级态：保留默认内存态、**拒绝后续写入**（保现场）、留痕并计数，启动照常。
   */
  private degraded: string | undefined

  constructor(private readonly deps: SettingsServiceDeps) {
    this.file = join(deps.dir, SETTINGS_FILE_NAME)
    this.isolation = createCorruptIsolation({ logger: deps.logger, countDiagnostic: deps.countDiagnostic })
  }

  /**
   * 装载：文件缺失 → DEFAULT_SETTINGS；存在 → openSafeFile + JSON parse + SettingsStateSchema.safeParse；
   * 失败（损坏/版本不匹配/非普通文件/权限不符）→ 隔离备份 .corrupt-settings-<ts> + 回默认（fail-open）。
   * **隔离失败不再上抛**（见 degraded 字段注释）：转降级态后照常以默认值返回。
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
      // 只记类别与 errno，不记 fs 原文（可能含绝对路径）——与 write-failure 同一条路径边界纪律
      const errno = (e as NodeJS.ErrnoException).code
      this.deps.logger.warn('settings:corrupt-isolated', { file: SETTINGS_FILE_NAME, reason: typeof errno === 'string' ? errno : 'unknown' })
      try {
        await this.isolation.isolate(this.file, 'settings', this.deps.safeRoot) // 隔离保留现场，不污染后续写入
      } catch (isolateErr: unknown) {
        const detail = isolateErr instanceof Error ? isolateErr.message : String(isolateErr)
        this.degraded = `isolate-failed:${detail}`
        this.deps.countDiagnostic('settings:degraded')
        this.deps.logger.error('settings:degraded', { file: SETTINGS_FILE_NAME, message: detail })
      }
      this.state = DEFAULT_SETTINGS
    }
    await this.isolation.pruneCorrupt(this.file, 'settings') // HIGH-1 有界保留：只留最新一份 .corrupt-settings-*
    this.loaded = true
    return this.state
  }

  /** 降级原因（设置域）；undefined 表示正常。供诊断与测试读取。**含 fs 原文，不得跨 IPC**。 */
  getLastError(): string | undefined { return this.degraded }

  /**
   * Renderer 侧的读入口（2026-09-13，M-19 残余）：**降级态下读也拒绝**。
   *
   * 降级（损坏文件隔离失败）意味着磁盘上那份设置**读不出来**，而内存里只有默认值。此时把默认值当
   * "当前设置"返回给 UI 是**谎报**——用户会以为设置被重置了，接着改一改、写一写，把未能隔离的原文件
   * 覆掉。故这条读路径直接抛 `PERSISTENCE_DEGRADED`：Renderer 的 `settings.hydrate` 早已 fail-open
   * （保留默认值、不阻塞启动），现在多了一步"把失败记下来并在设置页显示"。
   *
   * **启动期不受影响**：`main/index.ts` 走的是 `load()` 本身（不经本方法），仍不抛。
   * 放在服务上而不是 handler 里，有一个具体理由：handler 模块经 `ipc/registry` 间接 import `electron`，
   * 而 **单元测试 import 它会触发 Electron 二进制的懒下载**（本仓 M-40 记过这个坑）——本方法让
   * "降级拒绝读"这条规则可以在纯 node 单测里直击（Windows CI 实际抓到过 `os error 183`）。
   */
  async loadForRenderer(): Promise<SettingsState> {
    if (this.degraded !== undefined) {
      throw new CyreneError(
        CyreneErrorCode.PERSISTENCE_DEGRADED,
        `持久化已降级（${SETTINGS_FILE_NAME}：${this.degraded}），已拒绝读取以保留现场`
      )
    }
    return this.load()
  }

  /** 写入前守卫：降级态下拒绝一切写入，绝不覆写未能隔离的原文件（与 SessionStore 同纪律） */
  private assertWritable(): void {
    if (this.degraded === undefined) return
    throw new CyreneError(
      CyreneErrorCode.PERSISTENCE_DEGRADED,
      `持久化已降级（${SETTINGS_FILE_NAME}：${this.degraded}），已拒绝写入以保留现场`
    )
  }

  /**
   * 局部更新（settings:save）：merge（{...state, ...patch, voice: {...state.voice, ...patch.voice}, dictation: {...}}）
   * → SettingsStateSchema.parse（非法 patch/版本不匹配拒绝）→ atomicWriteFile 原子落盘 → 内存态更新后返回新 state。
   * patch.voice/dictation 缺省时展开 no-op，保持对应子树现值；未 load 前 save 先自装载（防丢已有落盘值）。
   */
  async save(patch: SettingsPatch): Promise<SettingsState> {
    if (!this.loaded) await this.load()
    this.assertWritable()   // 降级态：拒绝写入（load 里已 load 过，守在这里以防 load 期间才降级）
    const next: SettingsState = {
      ...this.state,
      ...patch,
      voice: { ...this.state.voice, ...patch.voice },
      dictation: { ...this.state.dictation, ...patch.dictation },
      live2d: { ...this.state.live2d, ...patch.live2d }, // 阶段 5 批次 A（D5A-10）：部分 patch（如 {enabled:false}）不丢 modelId
      tools: { ...this.state.tools, ...patch.tools },   // 阶段 6 批次 C：tools 子树 merge（对齐 live2d 既有模式；patch.tools 缺省展开 no-op 保持现值）
      appearance: { ...this.state.appearance, ...patch.appearance }   // 外观（2026-09-13）：同款子树 merge（漏了它会把整棵外观子树替换掉）
    }
    const newState = SettingsStateSchema.parse(next)
    // M-19（2026-09-13）：写失败必须带上可展示的码。此前裸 fs 错误经 executor 兜底成
    // `UNKNOWN/内部错误`，Renderer 侧再有状态也说不出一句有用的话（设置域用专用码，见 errors/index.ts）。
    await atomicWriteFile(this.file, JSON.stringify(newState), { safeRoot: this.deps.safeRoot })
      .catch((e: unknown) => { throw toWriteFailure(e, CyreneErrorCode.SETTINGS_SAVE_FAILED) })
    this.state = newState
    return newState
  }
}
