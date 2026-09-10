import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import type { StageHConfig } from './config.ts'

export interface StageHElectronSession {
  app: ElectronApplication
  page: Page
  actualAppData: string
  actualUserData: string
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

export function normalizeEndpointForComparison(raw: string): string {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint 含有不允许的凭据或 query')
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}

export async function waitConnected(page: Page, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | undefined
  while (Date.now() < deadline) {
    last = await page.evaluate(async () => window.desktopApi.getConnectionState()) as Record<string, unknown>
    if (last.status === 'connected') return last
    if (last.status === 'error') throw new Error(`后端连接失败：${String(last.lastError ?? 'unknown')}`)
    await page.waitForTimeout(100)
  }
  throw new Error(`后端连接超时：${String(last?.status ?? 'unknown')}`)
}

async function ensureEndpointAndConnection(page: Page, config: StageHConfig): Promise<Record<string, unknown>> {
  const endpoint = await page.evaluate(async () => window.desktopApi.getEndpoint()) as { endpoint?: string }
  const expected = normalizeEndpointForComparison(config.backendUrl)
  if (!endpoint.endpoint) {
    // Setting an endpoint without a token is harmless; connect still obtains
    // the credential exclusively from Electron's Secret Store.
    await page.evaluate(async (url) => window.desktopApi.setEndpoint(url), config.backendUrl)
  } else if (normalizeEndpointForComparison(endpoint.endpoint) !== expected) {
    throw new Error('隔离 appData 中已有凭据绑定到另一后端地址；为避免清除凭据，runner 拒绝自动改地址')
  }

  const current = await page.evaluate(async () => window.desktopApi.getConnectionState()) as Record<string, unknown>
  if (current.status !== 'connected') await page.evaluate(async () => window.desktopApi.connect())
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
    const [runtime, connection, me, characters, conversations] = await Promise.all([
      window.desktopApi.getRuntimeInfo(),
      window.desktopApi.getConnectionState(),
      window.desktopApi.getMe(),
      window.desktopApi.listCharacters({ status: 'active', limit: 100 }),
      window.desktopApi.listConversations({ limit: 100 })
    ])
    return { runtime, connection, me, characters, conversations }
  }) as Promise<Record<string, unknown>>
}
