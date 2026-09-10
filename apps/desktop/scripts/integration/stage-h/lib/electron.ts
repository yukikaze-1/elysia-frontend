import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import type { StageHConfig } from './config.ts'

export interface StageHElectronSession {
  app: ElectronApplication
  page: Page
  actualAppData: string
  actualUserData: string
}

// tests/integration/helpers/desktop-api.d.ts intentionally exposes a narrow
// Window.desktopApi shape for older suites.  Keep the runner's page boundary
// explicit instead of depending on one global declaration being complete.
interface StageHDesktopApi {
  getEndpoint(): Promise<{ endpoint?: string }>
  setEndpoint(url: string): Promise<{ endpoint: string }>
  connect(): Promise<unknown>
  getConnectionState(): Promise<Record<string, unknown>>
  getRuntimeInfo(): Promise<unknown>
  getMe(): Promise<unknown>
  listCharacters(input?: unknown): Promise<unknown>
  listConversations(input?: unknown): Promise<unknown>
}

const require = createRequire(import.meta.url)
const ELECTRON_EXECUTABLE = join(
  // Resolve from the workspace dependency graph; apps/desktop/node_modules is
  // intentionally not required to exist on a clean pnpm install.
  dirnameOf(require.resolve('electron')),
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

function dirnameOf(path: string): string {
  const marker = path.lastIndexOf('/')
  const windowsMarker = path.lastIndexOf('\\')
  return path.slice(0, Math.max(marker, windowsMarker))
}

function comparablePath(path: string): string {
  try {
    const real = realpathSync(path)
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    const normalized = resolve(path)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
}

function isStrictChild(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Validate the input before Electron starts.  Main's
 * applyTestAppDataOverride() remains the authoritative runtime gate; this
 * duplicate boundary only gives the CLI a deterministic, early failure and
 * makes it impossible to accidentally launch with a production profile.
 */
export function assertSafeStageHAppData(appData: string, systemTempRoot: string = tmpdir()): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(appData)
  } catch {
    throw new Error('app-data 必须是已预先创建的目录')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('app-data 必须是已预先创建的真实非符号链接目录')
  }

  let realAppData: string
  let realTempRoot: string
  try {
    realAppData = realpathSync(appData)
    realTempRoot = realpathSync(systemTempRoot)
  } catch {
    throw new Error('app-data 或系统临时目录不可解析')
  }
  if (!isStrictChild(realAppData, realTempRoot)) {
    throw new Error('app-data 必须位于系统临时目录下的独立子目录内')
  }
}

/** The test harness is only safe with an electron-vite `--mode test` build. */
export function isTestModeBuild(mainSource: string): boolean {
  return /\bapplyTestAppDataOverride\(\s*["']test["']\s*\)/u.test(mainSource)
}

function assertTestModeBuild(mainEntry: string): void {
  let source: string
  try {
    source = readFileSync(mainEntry, 'utf8')
  } catch {
    throw new Error(`无法读取 Electron 构建产物：${mainEntry}`)
  }
  if (!isTestModeBuild(source)) {
    throw new Error('Stage H runner 需要 electron-vite --mode test 构建产物；请使用正式 integration:stage-h 入口重新构建')
  }
}

export function normalizeEndpointForComparison(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint 含有不允许的凭据或 query')
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

export async function waitConnected(page: Page, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => {
      const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
      return api.getConnectionState()
    }) as Record<string, unknown>
    if (last.status === 'connected') return last
    if (last.status === 'error') throw new Error(`后端连接失败：${String(last.lastError ?? 'unknown')}`)
    await page.waitForTimeout(100)
  }
  throw new Error(`后端连接超时：${String(last?.status ?? 'unknown')}`)
}

async function ensureEndpointAndConnection(page: Page, config: StageHConfig): Promise<Record<string, unknown>> {
  const endpoint = await page.evaluate(async () => {
    const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
    return api.getEndpoint()
  }) as { endpoint?: string }
  const expected = normalizeEndpointForComparison(config.backendUrl)
  if (!endpoint.endpoint) {
    // Setting an endpoint without a token is harmless; connect still obtains
    // the credential exclusively from Electron's Secret Store.
    await page.evaluate(async (url) => {
      const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
      return api.setEndpoint(url)
    }, config.backendUrl)
  } else if (normalizeEndpointForComparison(endpoint.endpoint) !== expected) {
    throw new Error('隔离 appData 中已有凭据绑定到另一后端地址；为避免清除凭据，runner 拒绝自动改地址')
  }

  const current = await page.evaluate(async () => {
    const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
    return api.getConnectionState()
  }) as Record<string, unknown>
  if (current.status !== 'connected') await page.evaluate(async () => {
    const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
    return api.connect()
  })
  return waitConnected(page, config.operationTimeoutMs)
}

function launchEnv(config: StageHConfig): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CYRENE_TEST_APP_DATA: config.appData, CYRENE_TEST_HARNESS: '1', CYRENE_BACKEND: 'real' }
  // Never let inherited debug/dev or Electron-as-Node flags change the test boundary.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_ENABLE_LOGGING
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_OPTIONS
  // Credentials belong to the app's Secret Store. Do not forward unrelated
  // secret-shaped environment variables into the Electron child process.
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIAL)/iu.test(key)) delete env[key]
  }
  return env
}

export async function launchStageHElectron(config: StageHConfig): Promise<StageHElectronSession> {
  const mainEntry = join(config.desktopRoot, 'out', 'main', 'index.js')
  if (!existsSync(mainEntry)) throw new Error(`缺少 Electron 构建产物：${mainEntry}`)
  assertSafeStageHAppData(config.appData)
  assertTestModeBuild(mainEntry)

  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: [config.desktopRoot],
      cwd: config.desktopRoot,
      env: launchEnv(config),
      timeout: config.launchTimeoutMs
    })
    const actual = await app.evaluate(({ app: electronApp }) => ({
      appData: electronApp.getPath('appData'),
      userData: electronApp.getPath('userData')
    }))
    const expectedAppData = comparablePath(config.appData)
    const expectedUserData = comparablePath(join(config.appData, 'Cyrene'))
    if (comparablePath(actual.appData) !== expectedAppData || comparablePath(actual.userData) !== expectedUserData) {
      throw new Error('Electron 未使用指定的隔离 appData/userData，runner 已停止')
    }
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await ensureEndpointAndConnection(page, config)
    return { app, page, actualAppData: actual.appData, actualUserData: actual.userData }
  } catch (cause) {
    await app?.close().catch(() => {})
    throw cause
  }
}

export async function closeStageHElectron(session: StageHElectronSession | undefined): Promise<void> {
  if (!session) return
  await session.app.close()
}

export async function readCommonSnapshot(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const api = (window as unknown as { desktopApi: StageHDesktopApi }).desktopApi
    const [runtime, connection, me, characters, conversations] = await Promise.all([
      api.getRuntimeInfo(),
      api.getConnectionState(),
      api.getMe(),
      api.listCharacters({ status: 'active', limit: 100 }),
      api.listConversations({ limit: 100 })
    ])
    return { runtime, connection, me, characters, conversations }
  }) as Promise<Record<string, unknown>>
}
