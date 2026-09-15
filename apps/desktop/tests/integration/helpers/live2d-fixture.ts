// tests/integration/helpers/live2d-fixture.ts
// Live2D 集成套件共享夹具（2026-09-15 从 electron-live2d.spec.ts 抽出，**只此一份**）。
//
// 为什么抽成 helper 而不是复制三份：装配策略里含多条"踩过坑"的前置——`--user-data default` 对齐（缺了就是
// 「已发现 0 个模型」的整片假红）、chmodTree 0700（缺了 ensureUserDataDirs 抛 UserDataDirError → 阻塞错误框挂死）、
// cpSync 顶层 mode 漂移修复、SwiftShader 启动参数。三份复制必然漂移，而漂移的表现是「整片假红」这类最难查的形态。
// 故装配与观测原语集中在此；每个 spec 文件只声明自己用到的装配标志（haru/lil/wanko）。
//
// 装配策略（brief Step 1）：installLive2dMaster() 以 node --experimental-strip-types scripts/live2d-install.mjs
//   把 Haru（+ 修女莉尔 lil 若 tmp/live2d 存在）装进「master userData」（XDG_CONFIG_HOME 覆写，镜像
//   helpers/app.ts 的 appDataKey）。每用例 clone 一份 master 作独立 userData——损坏/切换/持久化互不污染。
//   重启用例单独复用同一 clone（closeApp keepUserData + launchApp opts.userData）。
//
// 纪律（对齐套件）：真实点击（locator.selectOption/click，无 force）、expect.poll 等待、
//   缺失元素以 count()===0 判、xvfb-run。WebGL 走 SwiftShader；首帧像素采样为「status=ready + 非透明像素」稳健形态。
//   若本环境 SwiftShader 采样得 0（preserveDrawingBuffer 时序），如实记录并回退 raf 帧计数为渲染证据（见报告）。
import { expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, readdirSync, lstatSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { launchApp, type LaunchedApp } from './app'

const execFileP = promisify(execFile)

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))        // apps/desktop
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))  // 仓库根
const CLI_SCRIPT = join(ROOT, 'scripts/live2d-install.mjs')
const CLI_ARGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', CLI_SCRIPT]
const HARU_SRC = join(REPO, 'third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
/**
 * lil 用户模型源目录（**不入 git**，`.gitignore:48` 的 `tmp/` 之下，仅本机存在）。
 *
 * **2026-09-15 修（S5-B2 同批的代码侧疑点 1）：此处原写 `tmp/live2d/修女莉尔免费版/修女莉尔免费版`，
 * 而磁盘上的实际布局是 `tmp/修女莉尔免费版/修女莉尔免费版`（多了一层 `live2d`）**——
 * 于是 `existsSync` 恒 false、`lilInstalled` 恒 false，三处 `if (lilInstalled)` 分支
 * （`electron-live2d-core.spec.ts:59/113/121`、`-motion.spec.ts:66`）成为**真空体**：
 * 既不算 passed 也不算 skipped，**「无动作模型优雅降级」在 CI 上零覆盖且无任何提示**。
 * 该错误路径在 doc 05 §15.1 与旧 spec 里是同源的，文档侧已改，夹具侧本轮补上。
 *
 * **本机显式检查**：`installLive2dMaster()` 会把结果落到 `[l2d-fixture] lil=…` 日志，便于确认分支真的跑了。
 */
const LIL_SRC = join(REPO, 'tmp', '修女莉尔免费版', '修女莉尔免费版')
// 确定性切换目标：lil 的 8192px 大纹理超出 SwiftShader MAX_TEXTURE_SIZE（集成实测装载即失败），
// 故另装官方 Wanko（1024px，最小史样）作可靠 switch/持久化点击对象——如实记录于报告（偏离 brief 的切换目标选择）。
const WANKO_SRC = join(REPO, 'third_party/CubismSdkForWeb-5-r.5/CubismSdkForWeb-5-r.5/Samples/Resources/Wanko')
export const WANKO_ID = 'wanko'

export const POLL = { timeout: 8000, interval: 200 }

/** 镜像 helpers/app.ts 的 appDataKey 选择：env 指向 root 时装配目标 userData 根 */
export function platformEnv(root: string): Record<string, string> {
  if (process.platform === 'win32') return { APPDATA: root }
  if (process.platform === 'darwin') return { HOME: root }
  return { XDG_CONFIG_HOME: root }
}

// —— 装配 ——
let masterDir = ''

async function installModels(root: string): Promise<{ haru: boolean; lil: boolean; wanko: boolean }> {
  const env = { ...process.env, ...platformEnv(root) }
  // `--user-data default`：本 spec 的 app 跑 `--mode test`，其 userData 是无后缀的 `Cyrene`（dev 后缀只对
  // 未打包 development 生效，见 docs/19）；CLI 缺省装到 Cyrene-Dev，故此处必须显式对齐，否则 freshUserData()
  // 克隆出的目录里没有 app 会读的那一份模型（表现为「已发现 0 个模型」的一整片假红）。
  const runCli = (args: string[]) => execFileP(process.execPath, [...CLI_ARGS, '--user-data', 'default', ...args], { env })
  await runCli(['--model-dir', HARU_SRC, '--id', 'haru', '--display-name', 'Haru'])
  await runCli(['--model-dir', WANKO_SRC, '--id', WANKO_ID, '--display-name', 'Wanko'])
  let lil = false
  if (existsSync(LIL_SRC)) {
    await runCli(['--model-dir', LIL_SRC, '--id', 'lil', '--display-name', '修女莉尔'])
    lil = true
  }
  // **必须留下读数**：lil 不在 git 里，缺它时分支静默跳过——2026-09-15 之前正是因为这个"没有输出"
  // 让一条错误的源路径藏了很久（分支成了真空体）。此处显式打印，本机跑一次即可确认装没装。
  console.log(`[l2d-fixture] lil=${lil ? 'installed' : 'absent'}（源目录 ${LIL_SRC}${lil ? '' : ' 不存在 ⇒ 相关分支跳过'}）`)
  return { haru: true, lil, wanko: true }
}

/** 建 master userData 并装配模型（对应原文件的 beforeAll）。返回装了哪些模型，供用例按需声明。 */
export function installLive2dMaster(): Promise<{ haru: boolean; lil: boolean; wanko: boolean }> {
  masterDir = mkdtempSync(join(tmpdir(), 'cy-l2d-master-'))
  return installModels(masterDir)
}

/** 拆掉 master userData（对应原文件的 afterAll） */
export function teardownLive2dMaster(): void {
  if (masterDir) { try { rmSync(masterDir, { recursive: true, force: true }) } catch { /* 尽力 */ } }
}

/** 递归 chmod 到 0700：cpSync 复制的顶层目录以默认 mode（0755&umask→0775）落盘，非源 0700——
 *  ensureUserDataDirs 要求 userData 基目录恰 0700（(mode&0o077)===0），否则抛 UserDataDirError → blocking 错误框挂死。
 *  装配目标 models 早已 0700，此处把基目录/子树统一收敛到 0700（安全前置，与真实装配 install 的内容一致）。 */
function chmodTree(p: string, mode: number): void {
  try { chmodSync(p, mode); lstatSync(p) } catch { /* 尽力 */ }
  for (const name of readdirSync(p)) {
    const child = join(p, name)
    try { if (lstatSync(child).isDirectory()) chmodTree(child, mode) } catch { /* 尽力 */ }
  }
}

/** 每用例独立 userData：clone master（含已装配模型），避免损坏/切换/持久化互污染 */
export function freshUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'cy-l2d-ud-'))
  cpSync(masterDir, d, { recursive: true })
  chmodTree(d, 0o700) // cpSync 顶层目录 mode 漂移修复（见 chmodTree 注释）
  return d
}

/** 取 lil（若装配）的入口 moc 文件名（供损坏注入改 size） */
export function lilModelFile(ud: string): string {
  const m = JSON.parse(readFileSync(join(ud, 'Cyrene', 'models', 'lil', 'manifest.json'), 'utf8')) as { modelFile: string }
  return m.modelFile
}

/** 装配了模型 → 启动即 Live2D WebGL 初始化；强制 SwiftShader 软渲染（headless 下 radv/Vulkan 非 conformant
 *  会拖挂/超时）。extraArgs 对齐 electron-voice 先例（Chromium 开关附于 args 末尾）。env 为附加环境变量
 *  （批次 B：CYRENE_MOCK_EMIT_DELAY_MS 放宽 replay 间隔 / CYRENE_MOCK_GENERATION_EMOTION 情绪注入）。 */
export function launchL2d(ud: string, env: Record<string, string> = {}): Promise<LaunchedApp> {
  return launchApp(undefined, { userData: ud, env, extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
}

// —— 渲染进程观测 ——

export async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.cy-live-status')?.textContent ?? '')
}
export async function selectValue(page: Page): Promise<string> {
  // 用 `querySelector<HTMLSelectElement>` 而不是类型断言：属性选择器不触发 TS 的标签名映射，
  // 返回的是 `Element | null`（`as HTMLSelectElement` 会被 `no-unnecessary-type-assertion` 判为多余并**自动删掉**，
  // 删掉后 `.value` 就编译不过——自动修复必须复核，这条是实测踩到的）。
  return page.evaluate(() => document.querySelector<HTMLSelectElement>('select[aria-label="选择 Live2D 模型"]')?.value ?? '')
}
/** 等 Live2D 状态落到终态（就绪/回退/失败）并返回其文案 */
export async function waitLive2dSettled(page: Page): Promise<string> {
  await expect.poll(() => statusText(page), POLL).toMatch(/就绪|回退|失败/)
  return statusText(page)
}

/**
 * 等重建真正落终态。
 *
 * 2026-09-10 审查修复：GPU 丢失后**不能**直接用 `toMatch(/就绪|回退|失败/)` 等重建——`rebuildAfterLost()`
 * 在 await reset 之前就把 `status='fallback'` 同步镜像（live2d.store.ts:234），其文案「静态头像回退（GPU 不可用）」
 * 本身即匹配该正则，于是 poll 会在**第一次求值就通过**，12s 预算形同虚设，重建逻辑即使完全不工作也绿。
 * 这里改为「等到真正终态或超时」：`正在加载模型…`==reset 进行中（**不**匹配终态）→ 返回 null 继续重试。
 * 若 12s 内一直停在中间态，poll 会以 null 失败并打印该文案。
 */
export async function waitLive2dTerminal(page: Page, timeout = 12000): Promise<string | null> {
  let last = ''
  await expect.poll(async () => {
    last = await statusText(page)
    return /就绪|回退|失败/.test(last) ? last : null
  }, { ...POLL, timeout }).not.toBeNull()
  return last
}

/** 连接 mock → 激活首个会话 → 输入框可用（「聊天可用」判据，对齐 electron-voice 先例） */
export async function connectAndActivateFirst(page: Page): Promise<void> {
  // UII-QQ：连接钮收进连接入口 popover——先点徽标（REAL/MOCK）展开，再点连接（能力不删，入口变更）
  await page.getByRole('button', { name: /REAL|MOCK/ }).click()
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-status-text')?.textContent ?? ''), POLL).toContain('已连接')
  await expect.poll(() => page.locator('.cy-conversation').count(), POLL).toBeGreaterThan(0)
  await page.locator('.cy-conversation-main').first().click()
  await expect.poll(() => page.evaluate(() => document.querySelector('.cy-chat-heading h2')?.textContent ?? ''), POLL).toContain('流式回复演示')
  await expect.poll(() => page.evaluate(() => (document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.disabled ?? true)), POLL).toBe(false)
}

/** 采样画布非透明像素数（WebGL canvas 经 2D drawImage 读回；rAF 双帧后读，尽量避开 preserveDrawingBuffer 时序）。-1 = 无法采样 */
// V-04 说明：-1 是"采样失败"哨兵（无 .cy-live-canvas / 零尺寸 / getContext('2d') 为 null），与 "真空白 0" 是两种不同信号。
// 但所有消费方都用 `expect.poll(() => countNonTransparentPx(page), POLL).toBeGreaterThan(0)` ——-1 被 `toBeGreaterThan(0)`
// 折叠，采样失败与真空白不可区分（poll 不失败）。这是有意容忍：无 canvas 时等待中的就绪态不应误判为空画布失败。
// 若未来需要区分"采样失败"与"画布真空白"，应改用断言值 !== -1 或单独哨兵断言，而非现在的 toBeGreaterThan(0)。
export async function countNonTransparentPx(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('.cy-live-canvas')
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return -1
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const w = canvas.width, h = canvas.height
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const ctx = off.getContext('2d')
    if (!ctx) return -1
    ctx.drawImage(canvas, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
    return n
  })
}

/** 状态徽标文案（.cy-live-badge，形如「状态：思考中」） */
export async function badgeText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('.cy-live-badge')?.textContent ?? '')
}

/** 连接 + 激活会话后经 UI 发送一条文本消息（mock 随即回放 generation 夹具 → 状态驱动/动作播放数据源） */
export async function sendChat(page: Page, text: string): Promise<void> {
  await page.locator('textarea[aria-label="消息输入框"]').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

/** 打开设置中心（.cy-settings 覆盖层出现） */
export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
}

/** 关闭设置中心（✕ 关闭按钮，确定性；对齐 electron-voice 先例） */
export async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(0)
}

/**
 * 打开设置中心 → 「外观与 Live2D」子页（CyLive2DPane）。
 *
 * 2026-09-10 修复：本 helper 原用 `角色与外观`，而 `3afc4de`（feat(character): add identity and
 * character management UI）已把设置导航项改名为 `外观与 Live2D`（CySettingsView.vue NAV_ITEMS）。
 * 改名是有意的，且被单测锁定：cy-settings-character-nav.spec.ts 断言文本**包含** `外观与 Live2D`
 * 且**不包含** `角色与外观`。本 spec 停留在旧名 → Playwright 找不到元素 → 30s 超时，
 * 连带 B4/B5/C2.1/恢复默认/禁用启用 共 5 个用例长期红灯。注意 getByRole 严格模式也不会误配：
 * 邻近的「角色」按钮 name 恰为「角色」，与旧名不同。
 */
export async function openCharacterPane(page: Page): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect.poll(() => page.locator('.cy-settings').count(), POLL).toBe(1)
  await page.getByRole('button', { name: /外观与 Live2D/ }).click()
  await expect.poll(() => page.locator('.cy-l2d-pane').count(), POLL).toBe(1)
}

/** 读 settings.json 的 live2d 子树（文件缺失/暂未落盘 → null，供 expect.poll 等待持久化） */
export function readSettingsL2d(ud: string): { modelId: string | null; scale?: number; offsetX?: number; performanceMode?: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(ud, 'Cyrene', 'config', 'settings.json'), 'utf8')) as {
      live2d?: { modelId?: string | null; scale?: number; offsetX?: number; performanceMode?: string }
    }
    return {
      modelId: s.live2d?.modelId ?? null,
      scale: s.live2d?.scale,
      offsetX: s.live2d?.offsetX,
      performanceMode: s.live2d?.performanceMode
    }
  } catch { return null }
}

/** 预置 settings.json（性能模式旧值 'high' 读回归一用例；缺字段时间必须补全，否则 settings-service 判定
 *  corrupt 全量重置——voice/dictation/live2d 全字段镜像 DEFAULT_SETTINGS） */
export function presetSettings(ud: string, live2dPatch: Record<string, unknown> = {}): void {
  const dir = join(ud, 'Cyrene', 'config')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const settings = {
    version: 1,
    voice: { enabled: true, realtimeEnabled: false, autoReadReply: true, showCaptions: true, consentBackendStt: false },
    dictation: { insertMode: 'append' },
    live2d: {
      enabled: true, modelId: null, scale: 1, offsetX: 0, offsetY: 0,
      mouseTracking: true, autoMotions: true, lipSync: true,
      performanceMode: 'auto', reduceMotion: false,
      ...live2dPatch
    }
  }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
}
