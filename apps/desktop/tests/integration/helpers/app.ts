import { _electron, chromium, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'node:http'
import { tmpdir } from 'os'
import { join, extname, resolve, sep, dirname } from 'path'
import { createRequire } from 'node:module'
import { type AddressInfo } from 'node:net'

export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string }

const ROOT = join(__dirname, '../../..')        // apps/desktop（helpers → integration → tests → apps/desktop）
const RENDERER_OUT = join(ROOT, 'out/renderer') // apps/desktop/out/renderer
const PRELOAD_OUT = join(ROOT, 'out/preload/index.js')

// electron 包位置按 require 解析链定位：pnpm hoisted 干净 install 下 electron 在根 node_modules，
// apps/desktop/node_modules 整个不存在（本地该目录是历史残留），硬编码子目录路径在全新环境 ENOENT（doc 17 P-14）
const require = createRequire(import.meta.url)
const ELECTRON_EXEC = join(dirname(require.resolve('electron')), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json'
}

/** 用 --mode test 构建产物(out/)启动 app：临时 userData + harness 标记 + 清残留 dev env。
 *  seedFiles：启动时预置文件（relPath 相对 userData 根，如 'app-cache/message-cache-v1.json'）——损坏恢复测试在 load() 前注入非法 JSON。
 *  目录 0700、文件 0600：否则 ensureUserDataDirs（0700 无 group/other）与 openSafeFile 读（0400 无 group/other）会因权限误判损坏/拒绝启动 */
export async function launchApp(seedFiles?: Array<{ relPath: string; content: string }>): Promise<LaunchedApp> {
  const electronPath = ELECTRON_EXEC
  const userData = mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
  for (const f of seedFiles ?? []) {
    const p = join(userData, 'Cyrene', f.relPath)
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
    writeFileSync(p, f.content, { mode: 0o600 })
  }
  const appDataKey = process.platform === 'win32' ? 'APPDATA' : process.platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME'
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    [appDataKey]: userData,        // appData→userData 隔离(join(appData,'Cyrene'))
    CYRENE_TEST_HARNESS: '1',
    CYRENE_BACKEND: 'mock'         // 固定 Mock 装配：新装配策略未打包默认 Real（打包恒 Real），集成套件须显式 mock 否则 boot 模式翻转（Task 9）
  }
  delete env['ELECTRON_RUN_AS_NODE']; delete env['ELECTRON_ENABLE_LOGGING']; delete env['ELECTRON_RENDERER_URL']; delete env['NODE_OPTIONS']
  const app = await _electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try { await launched.app.close() } catch { /* 已退出 */ }
  try { rmSync(launched.userData, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
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

export { chromium, PRELOAD_OUT, RENDERER_OUT } // trust-boundary/ipc/protocol spec 复用
