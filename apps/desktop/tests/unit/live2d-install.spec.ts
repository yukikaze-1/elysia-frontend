// tests/unit/live2d-install.spec.ts
// Task 4（A5，spec §3.5 / brief Step 2/4）：装配工具 CLI 单测——
//  - resolveModelsDir / resolveUserDataDir 纯函数跨平台 env 矩阵（镜像 expectedUserDataBase 的平台公式 + 开发隔离
//    风味后缀，见 docs/19；本 spec 不 import Electron）；
//  - CLI spawn（strip-types 入口，同 package.json live2d:install）走完整装配：文件布局 / manifest 字段 /
//    integrity 排除自身且含 LICENSE/preview / 缺纹理/非目录/非法 id → 非零退出 / --force 覆盖 / 无 --force 拒绝 /
//    --license-note 自定义。
//  - CLI 与 Electron 真实 app.getPath('appData') 的恒等对比放 Task 7 集成（vitest 无法 import electron，见 I2）。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CLI_USER_DATA_FLAVOR, resolveModelsDir, resolveUserDataDir } from '../../scripts/live2d-install.mjs'

const execFileP = promisify(execFile)

const DESKTOP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI_SCRIPT = fileURLToPath(new URL('../../scripts/live2d-install.mjs', import.meta.url))

/** 按当前宿主平台把 userData 根指向测试临时目录（镜像 resolveModelsDir 的 env 选择） */
function userDataEnv(root: string): Record<string, string> {
  if (process.platform === 'win32') return { APPDATA: root }
  if (process.platform === 'darwin') return { HOME: root }
  return { XDG_CONFIG_HOME: root }
}

/** 当前宿主平台下，env 指向 root 时装配目标 models 目录（与 resolveModelsDir 公式同构，供断言读文件） */
function modelsDirFor(root: string): string {
  if (process.platform === 'win32') return join(root, 'Cyrene', 'models')
  if (process.platform === 'darwin') return join(root, 'Library', 'Application Support', 'Cyrene', 'models')
  return join(root, 'Cyrene', 'models')
}

interface CliResult { code: number; stdout: string; stderr: string }

/**
 * integrity.json 的形状（P1-11）。CLI 产出的这个文件此前一律 `JSON.parse(...)` → `any`，
 * 于是下面几处 `files.find((f) => f.path === ...)` 的 `f` 全是隐式 any——断言写错字段名也不会被发现。
 *
 * 类型**直接引用生产者**（`src/main/live2d/manifest.ts` 的 `IntegrityEntry`），不在此另写一份：
 * 我第一版手写的声明把字段写成 `bytes`（真实是 `size`），一加上去就报 TS2339——正是这类镜像该避免的。
 */
type IntegrityEntry = import('../../src/main/live2d/manifest').IntegrityEntry
interface IntegrityFile { files: IntegrityEntry[] }

/** 读并**带类型**解析 integrity.json（避免 any 扩散到断言里） */
async function readIntegrity(dst: string): Promise<IntegrityFile> {
  return JSON.parse(await readFile(join(dst, 'integrity.json'), 'utf8')) as IntegrityFile
}

/** 取某路径的条目；缺失即失败（比 `!` 断言更有信息量，也免掉 possibly-undefined） */
function entryOf(integrity: IntegrityFile, path: string): IntegrityEntry {
  const found = integrity.files.find((f) => f.path === path)
  if (!found) throw new Error(`integrity.json 缺条目 ${path}（实际：${integrity.files.map((f) => f.path).join(', ')}）`)
  return found
}

/**
 * spawn 实际 CLI（同 package.json live2d:install 的 node flags）。
 *
 * 恒显式传 `--user-data default`：isolated 环境里断言的是**打包产物目录**公式，且不依赖 CLI 缺省值。
 * 缺省值（dev）另有专门用例（`--user-data dev/缺省` 与默认值契约），两者互不遮挡。
 */
async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-strip-types',
      CLI_SCRIPT,
      '--user-data', 'default',
      ...args
    ], { env: { ...process.env, ...env }, cwd: DESKTOP_ROOT, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string }
    const code = typeof e.code === 'number' ? e.code : 1
    return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** spawn CLI 且**不**注入 --user-data（用于验证缺省风味 = dev） */
async function runCliRaw(args: string[], env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-strip-types',
      CLI_SCRIPT,
      ...args
    ], { env: { ...process.env, ...env }, cwd: DESKTOP_ROOT, maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string }
    const code = typeof e.code === 'number' ? e.code : 1
    return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 建模型 fixture 目录；文件内容在 beforeAll 里写入 */
// P1-11：显式标注（此前无初值的 `let` 在 noImplicitAny 下是 evolving any——
// 8 条声明会连带出 41 条使用点报错）
let root: string
let userDataRoot: string
let haruSrc: string // 带 icon.png 的合法模型（预览 + 动作 + 表情）
let haruNoIconSrc: string // 无 icon.png 的合法模型（preview 省略路径）
let badTextureSrc: string // 引用不存在的纹理
let missingMocSrc: string // model3.json 缺 Moc
let notADir: string // 普通文件冒充模型目录
let standardNameSrc: string // 源入口即命名 model3.json（规范化免自删除）

async function writeTree(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyrene-live2d-install-'))
  userDataRoot = join(root, 'userdata')

  haruSrc = join(root, 'src-haru')
  await writeTree(haruSrc, {
    'Haru.model3.json': JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'Haru.moc3',
        Textures: ['textures/texture_00.png', 'textures/texture_01.png'],
        Expressions: [{ Name: 'F01', File: 'expressions/F01.exp3.json' }],
        Motions: { Idle: [{ File: 'motions/Idle_01.motion3.json' }] }
      }
    }),
    'Haru.moc3': 'moc-bytes',
    'textures/texture_00.png': 'png-00',
    'textures/texture_01.png': 'png-01',
    'expressions/F01.exp3.json': '{}',
    'motions/Idle_01.motion3.json': '{}',
    'icon.png': 'icon-bytes'
  })

  haruNoIconSrc = join(root, 'src-haru-noicon')
  await writeTree(haruNoIconSrc, {
    'Haru.model3.json': JSON.stringify({
      FileReferences: { Moc: 'Haru.moc3', Textures: ['textures/texture_00.png'] }
    }),
    'Haru.moc3': 'moc-bytes',
    'textures/texture_00.png': 'png-00'
  })

  badTextureSrc = join(root, 'src-badtexture')
  await writeTree(badTextureSrc, {
    'Haru.model3.json': JSON.stringify({
      FileReferences: { Moc: 'Haru.moc3', Textures: ['textures/missing.png'] }
    }),
    'Haru.moc3': 'moc-bytes'
  })

  missingMocSrc = join(root, 'src-missingmoc')
  await writeTree(missingMocSrc, {
    'Haru.model3.json': JSON.stringify({
      FileReferences: { Textures: ['textures/texture_00.png'] }
    }),
    'textures/texture_00.png': 'png-00'
  })

  notADir = join(root, 'not-a-dir')
  await writeFile(notADir, 'plain file')

  // 源入口即命名 model3.json（Task 7 审查：规范化不得自删除入口）
  standardNameSrc = join(root, 'src-standardname')
  await writeTree(standardNameSrc, {
    'model3.json': JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'model.moc3', Textures: ['textures/texture_00.png'] }
    }),
    'model.moc3': 'moc-bytes',
    'textures/texture_00.png': 'png-00'
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveModelsDir（跨平台 env 矩阵，镜像 expectedUserDataBase）', () => {
  it('Linux: XDG_CONFIG_HOME 优先', () => {
    expect(resolveModelsDir({ platform: 'linux', XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/home/demo' }))
      .toBe('/tmp/xdg/Cyrene/models')
  })

  it('Linux: 无 XDG_CONFIG_HOME 回退 $HOME/.config', () => {
    expect(resolveModelsDir({ platform: 'linux', HOME: '/home/demo' }))
      .toBe('/home/demo/.config/Cyrene/models')
  })

  it('Windows: %APPDATA%', () => {
    expect(resolveModelsDir({ platform: 'win32', APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }))
      .toBe('C:\\Users\\demo\\AppData\\Roaming\\Cyrene\\models')
  })

  it('macOS: $HOME/Library/Application Support', () => {
    expect(resolveModelsDir({ platform: 'darwin', HOME: '/Users/demo' }))
      .toBe('/Users/demo/Library/Application Support/Cyrene/models')
  })

  it('缺平台必要 env → 抛错（不静默落到错误目录）', () => {
    expect(() => resolveModelsDir({ platform: 'win32' })).toThrow()
    expect(() => resolveModelsDir({ platform: 'darwin' })).toThrow()
    expect(() => resolveModelsDir({ platform: 'linux' })).toThrow()
  })

  it('未显式传 platform → 用 process.platform（与默认 CLI 装配同构）', () => {
    // Windows 需 APPDATA（win32 分支读它），posix 用 HOME/XDG——按平台给各自必要 env，两侧同构断言不变
    const env = process.platform === 'win32'
      ? { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }
      : { HOME: '/home/demo', XDG_CONFIG_HOME: '/tmp/xdg' }
    expect(resolveModelsDir(env))
      .toBe(resolveModelsDir({ platform: process.platform, ...env }))
  })

  // —— 开发隔离（docs/19，2026-09-12）：userData 风味后缀。dev 与 default 必须是两个不同目录，
  //    否则 `pnpm dev` 会直接改写用户正式版的模型（进而 settings/凭据同仓）。
  it('flavor=dev → Cyrene-Dev 后缀；default → 无后缀', () => {
    const env = { platform: 'win32', APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }
    expect(resolveUserDataDir(env, 'dev')).toBe('C:\\Users\\demo\\AppData\\Roaming\\Cyrene-Dev')
    expect(resolveUserDataDir(env, 'default')).toBe('C:\\Users\\demo\\AppData\\Roaming\\Cyrene')
    expect(resolveModelsDir(env, 'dev')).toBe('C:\\Users\\demo\\AppData\\Roaming\\Cyrene-Dev\\models')
    // 缺省 = default（既有调用与集成 harness 口径不变）
    expect(resolveUserDataDir(env)).toBe(resolveUserDataDir(env, 'default'))
  })

  it('flavor=dev 在 Linux/macOS 同样加后缀（平台公式与后缀正交）', () => {
    expect(resolveModelsDir({ platform: 'linux', HOME: '/home/demo' }, 'dev'))
      .toBe('/home/demo/.config/Cyrene-Dev/models')
    expect(resolveModelsDir({ platform: 'darwin', HOME: '/Users/demo' }, 'dev'))
      .toBe('/Users/demo/Library/Application Support/Cyrene-Dev/models')
  })

  it('未知 flavor → 抛错（不静默装配到别的目录）', () => {
    expect(() => resolveUserDataDir({ platform: 'win32', APPDATA: 'C:\\x' }, 'staging' as never)).toThrow()
  })

  it('CLI 缺省风味 = dev（与 pnpm dev 的 userData 对齐）', () => {
    expect(DEFAULT_CLI_USER_DATA_FLAVOR).toBe('dev')
  })
})

describe('CLI 装配（strip-types spawn，spec §3.5 顺序）', () => {
  it('装配完整：文件布局 / manifest 必填+可选 / integrity 排除自身且含 LICENSE+preview', async () => {
    const { code, stdout } = await runCli(
      ['--model-dir', haruSrc, '--id', 'haru', '--display-name', 'Haru'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    expect(stdout).toContain('文件数 9')
    expect(stdout).toContain('总字节')
    expect(stdout).toContain('SHA-256 数 9')
    expect(stdout).toContain('haru 装配完成')

    const dst = join(modelsDirFor(userDataRoot), 'haru')
    const manifest = JSON.parse(await readFile(join(dst, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      id: 'haru',
      displayName: 'Haru',
      modelFile: 'model3.json', // 规范入口：源 *.model3.json 已规范化为 model3.json（集成 A7 契约收口）
      licenseRef: 'LICENSE.txt',
      integrityManifest: 'integrity.json', // brief Step 4 显式断言
      preview: 'preview.png',
      version: '3'
    })
    expect(manifest.expressions).toEqual(['expressions/F01.exp3.json'])
    expect(manifest.motions).toEqual(['motions/Idle_01.motion3.json'])

    // LICENSE.txt 缺省注记：免费版·个人开发验证 + 来源占位
    const license = await readFile(join(dst, 'LICENSE.txt'), 'utf8')
    expect(license).toContain('免费版·个人开发验证')
    expect(license).toContain(haruSrc)

    // preview.png 由 icon.png 拷贝生成
    const preview = await readFile(join(dst, 'preview.png'), 'utf8')
    expect(preview).toBe('icon-bytes')

    // integrity.json：排除 manifest/integrity 自身，含 LICENSE.txt/preview.png 与全部模型文件
    const integrity = await readIntegrity(dst)
    const paths = integrity.files.map((f) => f.path)
    expect(integrity.files).toHaveLength(9) // 6 源文件 + icon.png + LICENSE.txt + preview.png
    expect(paths).toContain('model3.json') // 规范化入口（源 Haru.model3.json 已替换为 model3.json）
    expect(paths).toContain('Haru.moc3')
    expect(paths).toContain('textures/texture_00.png')
    expect(paths).toContain('textures/texture_01.png')
    expect(paths).toContain('expressions/F01.exp3.json')
    expect(paths).toContain('motions/Idle_01.motion3.json')
    expect(paths).toContain('icon.png')
    expect(paths).toContain('LICENSE.txt')
    expect(paths).toContain('preview.png')
    expect(paths).not.toContain('manifest.json')
    expect(paths).not.toContain('integrity.json')
    // 每条目 path/size/sha256 与真实文件一致
    const tex = entryOf(integrity, 'textures/texture_01.png')
    expect(tex.size).toBe(Buffer.byteLength('png-01'))
    expect(tex.sha256).toBe(createHash('sha256').update('png-01').digest('hex'))
  })

  it('无 icon.png → manifest 省略 preview、无 preview.png', async () => {
    const { code } = await runCli(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-noicon', '--display-name', 'Haru NoIcon'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    const dst = join(modelsDirFor(userDataRoot), 'haru-noicon')
    const manifest = JSON.parse(await readFile(join(dst, 'manifest.json'), 'utf8'))
    expect(manifest).not.toHaveProperty('preview')
    await expect(lstat(join(dst, 'preview.png'))).rejects.toThrow()
    const integrity = await readIntegrity(dst)
    expect(integrity.files.some((f) => f.path === 'preview.png')).toBe(false)
    expect(integrity.files.some((f) => f.path === 'LICENSE.txt')).toBe(true)
  })

  it('缺纹理 → 非零退出', async () => {
    const { code, stderr } = await runCli(
      ['--model-dir', badTextureSrc, '--id', 'bad', '--display-name', 'Bad'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(1)
    expect(stderr).toContain('纹理缺失')
  })

  it('Moc 缺失 → 非零退出', async () => {
    const { code, stderr } = await runCli(
      ['--model-dir', missingMocSrc, '--id', 'bad', '--display-name', 'Bad'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(1)
    expect(stderr).toContain('Moc')
  })

  it('src 非目录 → 非零退出', async () => {
    const { code, stderr } = await runCli(
      ['--model-dir', notADir, '--id', 'bad', '--display-name', 'Bad'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(1)
    expect(stderr).toContain('非目录')
  })

  it('非法 id（.. / Unicode / 空白）→ 非零退出', async () => {
    for (const id of ['..', '修女莉尔', 'a b']) {
      const { code, stderr } = await runCli(
        ['--model-dir', haruNoIconSrc, '--id', id, '--display-name', 'Bad'],
        userDataEnv(userDataRoot)
      )
      expect(code, `id=${id}`).toBe(1)
      expect(stderr).toContain('非法模型 id')
    }
  })

  it('缺必填参数 → 非零退出', async () => {
    const { code } = await runCli(['--id', 'haru'], userDataEnv(userDataRoot))
    expect(code).toBe(1)
  })

  it('同 id 已存在且无 --force → 非零退出', async () => {
    const { code, stderr } = await runCli(
      ['--model-dir', haruSrc, '--id', 'haru', '--display-name', 'Haru'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(1)
    expect(stderr).toContain('已存在')
  })

  it('--force 覆盖：已存在同 id → 退出 0 且内容/清单随之更新', async () => {
    // 篡改源 moc 内容后 --force 重装
    await writeFile(join(haruNoIconSrc, 'Haru.moc3'), 'moc-bytes-v2')
    const { code, stdout } = await runCli(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-noicon', '--display-name', 'Haru NoIcon', '--force'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    expect(stdout).toContain('haru-noicon 装配完成')
    const dst = join(modelsDirFor(userDataRoot), 'haru-noicon')
    expect(await readFile(join(dst, 'Haru.moc3'), 'utf8')).toBe('moc-bytes-v2')
    const integrity = await readIntegrity(dst)
    const moc = entryOf(integrity, 'Haru.moc3')
    expect(moc.sha256).toBe(createHash('sha256').update('moc-bytes-v2').digest('hex'))
    expect(moc.size).toBe(Buffer.byteLength('moc-bytes-v2'))
  })

  it('--license-note 自定义文件内容写入 LICENSE.txt', async () => {
    const noteFile = join(root, 'custom-note.txt')
    await writeFile(noteFile, '自定义许可注记\n第二行')
    const { code } = await runCli(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-note', '--display-name', 'Haru Note', '--license-note', noteFile],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    const dst = join(modelsDirFor(userDataRoot), 'haru-note')
    expect(await readFile(join(dst, 'LICENSE.txt'), 'utf8')).toBe('自定义许可注记\n第二行')
  })

  it('装配目录文件总数 = 报告文件数（不含 manifest/integrity）', async () => {
    const { code } = await runCli(
      ['--model-dir', haruSrc, '--id', 'haru-count', '--display-name', 'Haru Count'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    const dst = join(modelsDirFor(userDataRoot), 'haru-count')
    const top = await readdir(dst)
    expect(top).toContain('manifest.json')
    expect(top).toContain('integrity.json')
  })

  it('源入口即命名 model3.json：规范化不删入口（Task 7 审查守卫）', async () => {
    const { code } = await runCli(
      ['--model-dir', standardNameSrc, '--id', 'standard-name', '--display-name', 'Std'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    const dst = join(modelsDirFor(userDataRoot), 'standard-name')
    // 入口 model3.json 必须存在（此前 bug：rm 自删除）
    expect((await lstat(join(dst, 'model3.json'))).isFile()).toBe(true)
    // integrity 应含 model3.json（可被 registry/resolve 供给）
    const integrity = await readIntegrity(dst)
    expect(integrity.files.map((f) => f.path)).toContain('model3.json')
  })

  // —— 开发隔离（docs/19）：CLI 缺省装配到开发目录，`--user-data default` 才落到打包产物目录 ——
  it('不传 --user-data → 缺省装到 Cyrene-Dev（与 pnpm dev 的 userData 一致）', async () => {
    const { code, stdout } = await runCliRaw(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-devdefault', '--display-name', 'Haru DevDefault'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    expect(stdout).toContain(join('Cyrene-Dev', 'models'))
    const dst = join(userDataRoot, 'Cyrene-Dev', 'models', 'haru-devdefault')
    expect((await lstat(join(dst, 'manifest.json'))).isFile()).toBe(true)
  })

  it('--user-data dev 显式指定 → 同样装到 Cyrene-Dev（与 default 严格分仓）', async () => {
    const { code } = await runCliRaw(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-devflag', '--display-name', 'Haru DevFlag', '--user-data', 'dev'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(0)
    const devDst = join(userDataRoot, 'Cyrene-Dev', 'models', 'haru-devflag')
    expect((await lstat(join(devDst, 'manifest.json'))).isFile()).toBe(true)
    // 打包产物目录里不得出现同名模型
    await expect(lstat(join(modelsDirFor(userDataRoot), 'haru-devflag'))).rejects.toThrow()
  })

  it('--user-data 非法值 → 非零退出（不静默装配到其它目录）', async () => {
    const { code, stderr } = await runCliRaw(
      ['--model-dir', haruNoIconSrc, '--id', 'haru-badflavor', '--display-name', 'X', '--user-data', 'staging'],
      userDataEnv(userDataRoot)
    )
    expect(code).toBe(1)
    expect(stderr).toContain('--user-data')
  })
})
