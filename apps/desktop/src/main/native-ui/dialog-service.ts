// src/main/native-ui/dialog-service.ts
// 原生对话框（Windows 上就是真实的系统窗口）的统一入口与测试适配层。
//
// 为什么需要它：系统 Dialog 不受 `BrowserWindow` 的 show/hide 影响——即使主窗口已隐藏，
// 一个 `dialog.showOpenDialog()` 仍会突然出现在桌面上并夺走前台焦点（自动化运行里既没人点它，
// 又打断用户）。全仓审计（2026-09-12）现有 4 类调用点：`showErrorBox`（启动失败）、
// `showOpenDialog`（目录授权 / 文件选择工具）、`showSaveDialog`（诊断包导出，harness 下已改走
// 固定临时路径）。本模块把它们的**环境差异**收敛到一处：
//
//   生产 / dev           → 真实 Electron dialog（行为逐字不变）
//   测试 harness + visible → 真实 Electron dialog + 记录调用（人工观察时仍可点）
//   测试 harness + silent  → **不弹任何原生窗口**，记录调用并返回确定性的「用户取消」
//
// 「记录 + 确定性取消」而不是「假装没发生」：测试仍可经 Main 探针
// （`__cyreneMainProbe.getDialogInvocations()`，仅 harness 装配）断言
// 「是否触发了对话框 / 参数是否正确 / 取消结果是否被正确处理」；需要走「用户确实选了某个路径」
// 的分支时，仍用既有的注入缝（tool-service 的 `pickFile`/`pickDirectory`、diagnostics 的
// `openPath`），而不是让本模块猜测试意图。
import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron'
import { runtimeEnvironment, type RuntimeEnvironment } from '../config/runtime-environment'

export type DialogKind = 'open' | 'save' | 'error-box'

/** 一次对话框调用的证据（仅白名单字段——对话框选项可能含用户路径，不进日志/不进诊断包） */
export interface DialogInvocation {
  kind: DialogKind
  ts: number
  title?: string
  properties?: string[]
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
  /** error-box 正文（启动失败原因；只存内存证据，供 harness 断言） */
  message?: string
  /** 本次是否真的弹了原生窗口（silent 下恒 false） */
  shown: boolean
}

const MAX_RECORDS = 50
const records: DialogInvocation[] = []

/** 最近若干次对话框调用（时间正序，最多 MAX_RECORDS 条；仅 harness 下会有内容） */
export function dialogInvocations(): readonly DialogInvocation[] {
  return [...records]
}

/** 仅测试用：清空调用记录 */
export function resetDialogInvocations(): void {
  records.length = 0
}

function record(invocation: DialogInvocation): void {
  records.push(invocation)
  if (records.length > MAX_RECORDS) records.shift()
}

export interface DialogPort {
  showOpenDialog(win: BrowserWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showSaveDialog(win: BrowserWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  /** 启动/运行期致命错误的原生提示框（fail-closed：silent 下改为 stderr，绝不弹窗阻塞桌面） */
  showErrorBox(title: string, content: string): void
}

export function createDialogService(env: RuntimeEnvironment = runtimeEnvironment()): DialogPort {
  const silent = env.isSilentWindowMode
  const recording = env.isTestHarness

  return {
    async showOpenDialog(win, options) {
      if (recording) {
        record({
          kind: 'open',
          ts: Date.now(),
          shown: !silent,
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...(options.properties !== undefined ? { properties: [...options.properties] } : {}),
          ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
          ...(options.filters !== undefined ? { filters: options.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) } : {}),
        })
      }
      if (silent) return { canceled: true, filePaths: [] }
      return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
    },

    async showSaveDialog(win, options) {
      if (recording) {
        record({
          kind: 'save',
          ts: Date.now(),
          shown: !silent,
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
          ...(options.filters !== undefined ? { filters: options.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) } : {}),
        })
      }
      if (silent) return { canceled: true, filePath: '' }
      return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
    },

    showErrorBox(title, content) {
      if (recording) record({ kind: 'error-box', ts: Date.now(), shown: !silent, title, message: content })
      if (silent) {
        // 不弹原生模态框（它会阻塞到有人点击，测试进程将看起来"卡住"，且干扰桌面）。
        // 改为 stderr：Playwright/CI 日志里仍然可见，失败原因不会消失。
        console.error(`[dialog:error-box] ${title}: ${content}`)
        return
      }
      dialog.showErrorBox(title, content)
    },
  }
}

let singleton: DialogPort | undefined

/** 进程级默认实例（装配点可显式注入同一实例；单例避免每处各自解析环境） */
export function defaultDialogService(): DialogPort {
  singleton ??= createDialogService()
  return singleton
}

/** 仅测试用：清缓存实例 */
export function resetDialogServiceForTest(): void {
  singleton = undefined
}
