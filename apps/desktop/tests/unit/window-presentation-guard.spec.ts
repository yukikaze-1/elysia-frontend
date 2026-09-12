// tests/unit/window-presentation-guard.spec.ts
// 架构门禁：把 2026-09-12 的「测试运行期窗口行为」审计结论钉成可执行的不变量。
//
// 为什么用源码扫描而不是"再写几个单测"：本次整改的根因不是某处代码写错，而是**窗口呈现动作
// 可以出现在任何地方**——一个 `win.show()`、一句 `dialog.showOpenDialog()`、一次
// `openDevTools({ mode: 'detach' })` 就足以让自动化测试在用户桌面上弹窗、抢焦点、妨碍全屏游戏，
// 而所有既有断言（内容、IPC、协议）都还是绿的。逐个补单测挡不住"新增一处调用点"，
// 故这里直接对 `src/main` 的源码立规则，并把例外表硬编码（漂移时必须有人显式来改这张表）。
//
// 规则（2026-09-12 基线，全部 0 违规）：
//   ① 建窗唯一入口：`new BrowserWindow(` / `new BaseWindow(` 只允许出现在 windows/window-presentation.ts；
//   ② 呈现动作只允许在该文件：show/showInactive/hide/focus/blur/restore/minimize/maximize/unmaximize/
//      moveTop/setAlwaysOnTop/setSkipTaskbar/setFocusable/setVisibleOnAllWorkspaces/setFullScreen/
//      setSimpleFullScreen/openDevTools/toggleDevTools/closeDevTools；
//   ③ 原生对话框只允许在 native-ui/dialog-service.ts（`dialog.` 引用）；
//   ④ 会打扰桌面的原生 UI 面在 Main 里**不存在**：Notification / Tray / globalShortcut / 自动更新
//      （审计实测 0 调用点；将来要加，必须落在一个像 dialog-service 那样的边界里并同步本表）。
// 注释不参与匹配（stripComments 保留字符串字面量），因此解释性注释不会误触发。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const MAIN_DIR = join(__dirname, '../../src/main')

/** 统一的窗口呈现边界（唯一允许直接调用呈现 API 的文件） */
const PRESENTATION_MODULE = 'windows/window-presentation.ts'
/** 原生对话框边界（唯一允许直接调用 electron dialog 的文件） */
const DIALOG_MODULE = 'native-ui/dialog-service.ts'

/**
 * 例外表（当前为空）。非空必须在理由里写清楚：为什么这个文件必须绕过统一边界，
 * 以及为什么它不会在自动化测试期间打扰宿主桌面。
 */
const CREATION_EXCEPTIONS: Record<string, string> = {}
const PRESENTATION_EXCEPTIONS: Record<string, string> = {}
const DIALOG_EXCEPTIONS: Record<string, string> = {}

/** 去注释但保留字符串内容（与 ipc-surface-alignment.spec.ts 同款实现：`//` 出现在字面量里不算注释） */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue }
    if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue }
    out += ch
    i += 1
  }
  return out
}

interface SourceFile { rel: string; code: string }

function scanMain(): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!name.endsWith('.ts')) continue
      files.push({ rel: relative(MAIN_DIR, full).split(sep).join('/'), code: stripComments(readFileSync(full, 'utf8')) })
    }
  }
  walk(MAIN_DIR)
  return files
}

const SOURCES = scanMain()

/** 收集匹配（返回 `文件:行号: 片段`），并断言扫描面非空——空扫描会让门禁恒真 */
function find(pattern: RegExp, opts: { allow?: string; exceptions?: Record<string, string> } = {}): string[] {
  const hits: string[] = []
  for (const { rel, code } of SOURCES) {
    if (rel === opts.allow) continue
    if (rel in (opts.exceptions ?? {})) continue
    const lines = code.split('\n')
    lines.forEach((line, index) => {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      if (re.test(line)) hits.push(`${rel}:${index + 1}: ${line.trim()}`)
    })
  }
  return hits
}

describe('窗口行为架构门禁（扫描 src/main 源码）', () => {
  it('扫描面非空（退化的空扫描不得让门禁恒真）', () => {
    expect(SOURCES.length).toBeGreaterThan(50)
    expect(SOURCES.map((f) => f.rel)).toContain(PRESENTATION_MODULE)
    expect(SOURCES.map((f) => f.rel)).toContain(DIALOG_MODULE)
  })

  it('建窗唯一入口：BrowserWindow/BaseWindow 构造只允许在统一呈现边界', () => {
    expect(find(/\bnew (BrowserWindow|BaseWindow)\s*\(/, { allow: PRESENTATION_MODULE, exceptions: CREATION_EXCEPTIONS })).toEqual([])
  })

  it('呈现动作（show/focus/restore/置顶/任务栏/DevTools…）只允许在统一呈现边界', () => {
    const pattern = /\.(show|showInactive|hide|focus|blur|restore|minimize|maximize|unmaximize|moveTop|setAlwaysOnTop|setSkipTaskbar|setFocusable|setVisibleOnAllWorkspaces|setFullScreen|setSimpleFullScreen|openDevTools|toggleDevTools|closeDevTools)\s*\(/
    expect(find(pattern, { allow: PRESENTATION_MODULE, exceptions: PRESENTATION_EXCEPTIONS })).toEqual([])
  })

  it('原生对话框只允许在 native-ui 边界（其余业务码不得直接 dialog.*）', () => {
    expect(find(/\bdialog\.(showMessageBox|showOpenDialog|showSaveDialog|showErrorBox)\s*\(/, { allow: DIALOG_MODULE, exceptions: DIALOG_EXCEPTIONS })).toEqual([])
  })

  it('Main 不得存在会打扰桌面的原生 UI 面（Notification/Tray/全局快捷键/自动更新）', () => {
    expect(find(/\bnew Notification\s*\(/)).toEqual([])
    expect(find(/\bnew Tray\s*\(/)).toEqual([])
    expect(find(/\bglobalShortcut\./)).toEqual([])
    expect(find(/\b(autoUpdater|electron-updater)\b/)).toEqual([])
    // app.focus()/win.moveTop() 这类"强行提到前台"的调用在全仓必须为 0（呈现边界内也没有）
    expect(find(/\bapp\.focus\s*\(/)).toEqual([])
    expect(find(/\.moveTop\s*\(/)).toEqual([])
  })
})
