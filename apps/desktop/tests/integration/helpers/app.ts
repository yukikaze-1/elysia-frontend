import { _electron, chromium, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from 'fs'
import { createServer } from 'node:http'
import { tmpdir } from 'os'
import { join, extname, resolve, sep, dirname } from 'path'
import { createRequire } from 'node:module'
import { type AddressInfo } from 'node:net'

export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string }

export interface LaunchOptions {
  env?: Record<string, string>
  /** 复用既有 userData（Task 15 重启持久化）：传则沿用该路径（仍 mkdir + seedFiles），不传维持 mkdtemp 现状 */
  userData?: string
  /** 追加 Electron/Chromium 命令行开关（Task 15 语音：--use-fake-device-for-media-stream 等，无头环境确定性采集）；
   *  附于 args 末尾，向后兼容——既有调用方省略即可 */
  extraArgs?: string[]
  /**
   * dev 形态（M-29/P2-5）：让页面由 **Vite dev server** 供给（`http://127.0.0.1:<port>`）而非 `cyrene://renderer`。
   *
   * 必须是显式选项、不能"顺手经 opts.env 传"：下面第 76 行**必须**清掉从父进程继承的
   * `ELECTRON_RENDERER_URL`——否则本机只要开着 `pnpm dev`，整套集成测试都会悄悄跑成 dev 形态。
   * 故 dev 形态只能经本选项显式开启，默认关闭，既有调用方语义逐字不变。
   */
  rendererUrl?: string
}

const ROOT = join(__dirname, '../../..')        // apps/desktop（helpers → integration → tests → apps/desktop）
const RENDERER_OUT = join(ROOT, 'out/renderer') // apps/desktop/out/renderer
const PRELOAD_OUT = join(ROOT, 'out/preload/index.js')

/**
 * Linux 上 Electron 的 GPU 进程**必然**在 Mesa 的软件光栅器里段错误（2026-09-12 在 X99 实测）。
 *
 * 证据（同一台机、最小 Electron 窗口、`xvfb-run -a`，3 次重复全一致）：
 * - 默认参数：每次启动 `GPU process exited unexpectedly: exit_code=139` × 3（内核侧
 *   `segfault ... in swrast_dri.so`，同一条指令偏移），且 `getContext('webgl')` 恒为 null；
 * - `--no-sandbox` 无效（仍 × 3）；`--in-process-gpu` 更糟（Electron 自身 139 退出）；
 * - `--disable-gpu` 与 `--use-angle=swiftshader --enable-unsafe-swiftshader` 均为 0 次。
 *
 * 危害不止是噪音：Chromium 重试耗尽后会打印
 * `FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc: GPU process isn't usable. Goodbye.`
 * 并**主动杀掉整个浏览器进程** —— 观测到的形态是某用例在首个 `page.evaluate` 上
 * `Target page, context or browser has been closed`（`34695059951` 的 shard 1/3，`trust-boundary.spec.ts:33`），
 * 而无任何代码改动重跑即绿。
 *
 * 该环境下 GPU 本就是死的（WebGL 恒 null），故显式传 `--disable-gpu`：把"先崩 3 次再降级"
 * 变成"一开始就不启用"，**用例观测面逐字不变**（仍然无 WebGL），同时省掉每次启动约 1.2s
 * 的崩溃-重启重试。需要真实软渲染的用例（Live2D / perf-gate / dev-form-renderer）自行经
 * `extraArgs` 传 `--use-angle=swiftshader --enable-unsafe-swiftshader`——该后端实测 0 崩溃，
 * 与本默认值互斥：**传了 GL 后端的调用方不再注入 `--disable-gpu`**，否则会把它盖掉。
 *
 * 只在 linux 生效：Windows 目标机（i5-13600KF，无核显）走的是另一条非 Mesa 路径，当前全绿，
 * 无可复现证据，不动。
 */
function defaultGlArgs(extraArgs: readonly string[]): string[] {
  if (process.platform !== 'linux') return []
  const hasExplicitGlBackend = extraArgs.some((a) => a.startsWith('--use-angle') || a.startsWith('--use-gl'))
  return hasExplicitGlBackend ? [] : ['--disable-gpu']
}

// 进程退出兜底：用例忘记 closeApp（或 beforeAll 启动后断言先失败）时，应用不应活过测试进程。
// 中断（Ctrl-C / kill）时进程来不及走 'exit'，那是 setup/orphan-apps.setup.ts 下次运行回收的场景。
const liveApps = new Set<ElectronApplication>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const app of liveApps) { try { void app.close() } catch { /* 尽力 */ } }
    liveApps.clear()
  })
}

// electron 包位置按 require 解析链定位：pnpm hoisted 干净 install 下 electron 在根 node_modules，
// apps/desktop/node_modules 整个不存在（本地该目录是历史残留），硬编码子目录路径在全新环境 ENOENT（doc 17 P-14）
const require = createRequire(import.meta.url)
const ELECTRON_EXEC = join(dirname(require.resolve('electron')), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json'
}

function comparablePath(path: string): string {
  const real = realpathSync(path)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** 用 --mode test 构建产物(out/)启动 app：临时 userData + harness 标记 + 清残留 dev env。
 *  seedFiles：启动时预置文件（relPath 相对 userData 根，如 'app-cache/message-cache-v1.json'）——损坏恢复测试在 load() 前注入非法 JSON。
 *  opts.env：附加环境变量（先合并；测试隔离/Mock 三项不变量随后覆盖，调用方不可改写安全门；
 *  Task 17 阶段 3 G3 新增，向后兼容——既有调用方传 seedFiles 或省略均可用）。
 *  目录 0700、文件 0600：否则 ensureUserDataDirs（0700 无 group/other）与 openSafeFile 读（0400 无 group/other）会因权限误判损坏/拒绝启动 */
export async function launchApp(seedFiles?: Array<{ relPath: string; content: string }>, opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const electronPath = ELECTRON_EXEC
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
  mkdirSync(userData, { recursive: true, mode: 0o700 }) // 复用路径时保证存在（mkdtemp 路径已存在，幂等）
  for (const f of seedFiles ?? []) {
    const p = join(userData, 'Cyrene', f.relPath)
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    writeFileSync(p, f.content, { mode: 0o600 })
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.env ?? {}),
    // 权威隔离门：Main 在 test+harness+未打包三重门下 setPath('appData', userData)，并在
    // installAppIdentity 前读回校验。不能再依赖 Windows APPDATA env（Electron 43 实测无效）。
    CYRENE_TEST_APP_DATA: userData,
    CYRENE_TEST_HARNESS: '1',
    CYRENE_BACKEND: 'mock',        // 固定 Mock 装配：新装配策略未打包默认 Real（打包恒 Real），集成套件须显式 mock 否则 boot 模式翻转（Task 9）
  }
  delete env['ELECTRON_RUN_AS_NODE']; delete env['ELECTRON_ENABLE_LOGGING']; delete env['ELECTRON_RENDERER_URL']; delete env['NODE_OPTIONS']
  // 清掉继承值之后才允许显式注入 dev 形态（见 LaunchOptions.rendererUrl 注释）
  if (opts.rendererUrl) env['ELECTRON_RENDERER_URL'] = opts.rendererUrl
  const extraArgs = opts.extraArgs ?? []
  const app = await _electron.launch({ executablePath: electronPath, args: [ROOT, ...defaultGlArgs(extraArgs), ...extraArgs], cwd: ROOT, env, timeout: 30000 })
  try {
    // 第二道 fail-closed：主进程已成功启动后，在任何测试动作前核对 Electron 实际 appData/userData。
    // 若未来 Main 覆盖门被重构坏，助手直接失败，绝不让用例继续操作真实凭据/缓存。
    // sessionData 一并核对：HTTP 缓存/Cookies/Service Worker 等会话态落在它下面，若它漂到 appData 之外
    // （Electron 默认在 userData 下，但不保证），多项目并行开发就会共用同一份会话缓存（docs/19 §6）。
    const actual = await app.evaluate(({ app }) => ({
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData')
    }))
    const isolated = comparablePath(actual.appData) === comparablePath(userData)
      && comparablePath(actual.userData) === comparablePath(join(userData, 'Cyrene'))
      && comparablePath(actual.sessionData).startsWith(comparablePath(join(userData, 'Cyrene')))
    if (!isolated) throw new Error('Electron 集成测试 appData/userData 未指向临时隔离目录')

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    installExitHook()
    liveApps.add(app)
    return { app, page, userData }
  } catch (err) {
    try { await app.close() } catch { /* 启动失败时尽力关闭 */ }
    if (opts.userData === undefined) { try { rmSync(userData, { recursive: true, force: true }) } catch { /* 尽力 */ } }
    throw err
  }
}

/**
 * dev 形态启动（M-29/P2-5）：页面由 Vite dev server 供给。
 *
 * 除注入 `ELECTRON_RENDERER_URL` 外**与 launchApp 完全同路径**——appData 覆盖门、
 * harness 标记、Mock 装配三项隔离不变量逐字不变，因此本函数不会为 dev 形态开任何后门。
 */
export function launchAppDev(
  rendererUrl: string,
  seedFiles?: Array<{ relPath: string; content: string }>,
  opts: LaunchOptions = {}
): Promise<LaunchedApp> {
  return launchApp(seedFiles, { ...opts, rendererUrl })
}

export async function closeApp(launched: LaunchedApp, opts: { keepUserData?: boolean } = {}): Promise<void> {
  liveApps.delete(launched.app)
  try { await launched.app.close() } catch { /* 已退出 */ }
  // 重启持久化（Task 15）：keepUserData 时保留 userData 供下次 launchApp(opts.userData) 复用
  if (!opts.keepUserData) { try { rmSync(launched.userData, { recursive: true, force: true }) } catch { /* 清理尽力 */ } }
}

/** 静态服务 out/renderer（信任边界测试用；普通浏览器无 preload → desktopApi undefined） */
export async function serveRenderer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let pathname: string
    try { pathname = decodeURIComponent((req.url ?? '/index.html').split('?')[0]) }
    catch { res.writeHead(400); res.end(); return } // 畸形 % → 400，不崩 worker
    const file = resolve(RENDERER_OUT, '.' + (pathname === '/' ? '/index.html' : pathname))
    // resolve + 前缀边界防穿越（verify-artifact 同款纪律）
    if (!file.startsWith(RENDERER_OUT + sep) && file !== RENDERER_OUT) { res.writeHead(404); res.end(); return }
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => new Promise((r) => server.close(() => r())) }
}

export { chromium, PRELOAD_OUT, RENDERER_OUT, ROOT } // trust-boundary/ipc/protocol spec 复用；ROOT 供 orphan 回收判据使用
