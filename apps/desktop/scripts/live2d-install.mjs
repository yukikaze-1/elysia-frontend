#!/usr/bin/env node
// apps/desktop/scripts/live2d-install.mjs
// 阶段 5 批次 A（A5，spec §3.5）：装配工具 CLI——把原始 Live2D 模型目录转成 userData/models/<id>/ 合规安装包。
// - strip-types 直 import src/main/live2d/manifest.ts（hashFile / computeIntegrity，零运行时依赖，Task 2 约束）；
// - userData 解析镜像 Main expectedUserDataBase()（main/app/lifecycle.ts：join(app.getPath('appData'), 应用目录名)），
//   本脚本无 Electron runtime，自行实现 Linux/Windows/macOS 跨平台公式（resolveModelsDir 纯函数，可单测 env 矩阵）；
//   开发隔离（docs/19，2026-09-12）：未打包 development 的 userData 是 `<base>/Cyrene-Dev`，CLI 默认装配到
//   **开发目录**（与 `pnpm dev` 一致，否则装完看不到模型）；`--user-data default` 显式装到打包产物的目录。
// - 流程顺序（spec §3.5）：校验（model3.json/moc3/≥1 纹理）→ id 校验 → fs.cp 非 symlink 拷贝 → 注入 LICENSE.txt
//   （先于 manifest/integrity）→ preview（icon.png→preview.png）→ manifest → computeIntegrity(dst) → 报告。
import { lstat, readdir, cp, mkdir, rm, readFile, writeFile, copyFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { join, win32, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashFile, computeIntegrity } from '../src/main/live2d/manifest.ts'

/** id 白名单（与 model-registry manifestSchema 的 `^[A-Za-z0-9._-]+$` 一致），另拒 `.`/`..` */
const ID_RE = /^[A-Za-z0-9._-]+$/

/** userData 目录名（镜像 main/app/lifecycle.ts）：development 未打包 = `Cyrene-Dev`，其余 = `Cyrene` */
export const USER_DATA_FLAVORS = ['dev', 'default']

/** CLI 缺省风味 = 开发目录（与 `pnpm dev` 的 userData 对齐，装完即可在开发态看到模型） */
export const DEFAULT_CLI_USER_DATA_FLAVOR = 'dev'

const USER_DATA_DIR_NAMES = { dev: 'Cyrene-Dev', default: 'Cyrene' }

/**
 * 纯函数：镜像 expectedUserDataBase() 的 userData 根解析（不含 /models）。
 * env 兼容 process.env（无 platform 键时用 process.platform）；win32 用 path.win32.join（反斜杠），
 * linux/darwin 用 path.posix.join——单测在任意宿主断言平台字面量稳定。
 * - Linux:  XDG_CONFIG_HOME ?? $HOME/.config  → <base>/<应用目录名>
 * - Windows: %APPDATA%                        → <base>/<应用目录名>
 * - macOS:   $HOME/Library/Application Support → <base>/<应用目录名>
 */
export function resolveUserDataDir(env, flavor = 'default') {
  const dirName = USER_DATA_DIR_NAMES[flavor]
  if (!dirName) throw new Error(`resolveUserDataDir: 未知 userData flavor ${JSON.stringify(flavor)}（应为 ${USER_DATA_FLAVORS.join(' / ')}）`)
  const platform = env.platform ?? process.platform
  const P = platform === 'win32' ? win32 : posix
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('resolveUserDataDir: APPDATA 未设置（Windows userData 解析失败）')
    return P.join(env.APPDATA, dirName)
  }
  if (platform === 'darwin') {
    if (!env.HOME) throw new Error('resolveUserDataDir: HOME 未设置（macOS userData 解析失败）')
    return P.join(env.HOME, 'Library', 'Application Support', dirName)
  }
  if (env.XDG_CONFIG_HOME) return P.join(env.XDG_CONFIG_HOME, dirName)
  if (env.HOME) return P.join(env.HOME, '.config', dirName)
  throw new Error('resolveUserDataDir: HOME 与 XDG_CONFIG_HOME 均未设置（Linux userData 解析失败）')
}

/** userData 根 + /models（装配目标目录）。分隔符必须同源用平台实现——`path.join` 恒用宿主分隔符，
 *  在 Windows 宿主上断言 linux/darwin 公式时会混出反斜杠（本 spec 的平台矩阵正是为捕获这类漂移）。 */
export function resolveModelsDir(env, flavor = 'default') {
  const platform = env.platform ?? process.platform
  const P = platform === 'win32' ? win32 : posix
  return P.join(resolveUserDataDir(env, flavor), 'models')
}

function assertValidId(id) {
  if (!ID_RE.test(id) || id === '.' || id === '..') {
    throw new Error(`非法模型 id: ${JSON.stringify(id)}（须匹配 ^[A-Za-z0-9._-]+$ 且非 . / ..）`)
  }
}

/** 校验原始目录：恰含一个 *.model3.json（或标准名 model3.json）、model3.json 可解析、FileReferences.Moc 存在、≥1 纹理存在（lstat 非普通文件拒） */
async function validateModelDir(src) {
  const st = await lstat(src).catch(() => null)
  if (!st || !st.isDirectory()) throw new Error(`模型目录不存在或非目录: ${src}`)
  const top = await readdir(src)
  // 入口判定：标准名 `model3.json` 不以 `.model3.json` 结尾（`endsWith` 会漏判），须单独纳入。
  const model3s = top.filter((n) => n.toLowerCase() === 'model3.json' || n.toLowerCase().endsWith('.model3.json'))
  if (model3s.length !== 1) throw new Error(`模型目录须恰含一个 *.model3.json（实际 ${model3s.length} 个）: ${src}`)
  const m3Name = model3s[0]
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(src, m3Name), 'utf8'))
  } catch {
    throw new Error(`model3.json 解析失败: ${m3Name}`)
  }
  const fr = parsed && typeof parsed.FileReferences === 'object' ? parsed.FileReferences : {}
  const moc = fr.Moc
  if (!moc) throw new Error('model3.json 缺少 FileReferences.Moc')
  const mocSt = await lstat(join(src, moc)).catch(() => null)
  if (!mocSt || !mocSt.isFile()) throw new Error(`Moc 文件缺失/非普通文件: ${moc}`)
  const textures = Array.isArray(fr.Textures) ? fr.Textures : []
  if (textures.length === 0) throw new Error('model3.json FileReferences.Textures 为空（须 ≥1 纹理）')
  for (const t of textures) {
    const tSt = await lstat(join(src, t)).catch(() => null)
    if (!tSt || !tSt.isFile()) throw new Error(`纹理缺失/非普通文件: ${t}`)
  }
  return { m3Name, parsed, fr }
}

/** 缺省 license note：免费版·个人开发验证 + 来源占位（spec §3.5 step 4；D5A-06 许可记录） */
function defaultLicenseNote(src) {
  return [
    'Cyrene Live2D 模型——许可与来源注记（装配工具缺省）',
    '------------------------------------------',
    `来源: ${src}`,
    '用途: 免费版·个人开发验证',
    '',
    '注：本注记仅为装配工具注入的记录，不授予分发/商用权利；',
    '发布前须按 doc 05 §15 复核模型授权。'
  ].join('\n') + '\n'
}

/**
 * 装配主流程（spec §3.5 顺序）。返回报告 { id, dst, files, bytes, hashes, modelFile, modelFileSha256, preview }。
 * 单测可直接调用，也可经 CLI spawn 走完整入口。
 */
export async function installModel({ modelDir, id, displayName, licenseNote, force, modelsDir }) {
  assertValidId(id)
  const { m3Name, parsed, fr } = await validateModelDir(modelDir)
  const dst = join(modelsDir, id)
  const exists = await lstat(dst).catch(() => null)
  if (exists && !force) throw new Error(`模型 ${id} 已存在: ${dst}（无 --force 拒绝覆盖）`)
  if (exists) await rm(dst, { recursive: true, force: true })

  await mkdir(modelsDir, { recursive: true, mode: 0o700 })
  // 非 symlink 拷贝：filter 仅放行目录与普通文件（symlink/FIFO/设备全拒，doc 05 §4 safe-open 纪律）
  await cp(modelDir, dst, {
    recursive: true,
    filter: (src) => {
      const st = lstatSync(src)
      return st.isDirectory() || st.isFile()
    }
  })

  // preview：目录内 icon.png 拷为 preview.png（无 icon 则省略，UI 用占位；spec §3.5 step 5 / D5A-07）
  let preview = null
  const iconSt = await lstat(join(modelDir, 'icon.png')).catch(() => null)
  if (iconSt && iconSt.isFile()) {
    await copyFile(join(modelDir, 'icon.png'), join(dst, 'preview.png'))
    preview = 'preview.png'
  }

  // 规范入口（跨 Task 契约，集成 A7 捕获）：controller/adapter 恒以 model3Path 'model3.json' 装载
  // （controller 注释「Task 4 装配强制该文件存在且 manifest.modelFile 指向之」）。源目录模型入口是
  // 任意命名的 *.model3.json（如 Haru.model3.json）——装配须把它规范化为 model3.json，并删去源命名副本，
  // 否则适配器 fetch cyrene://…/{id}/model3.json 落到 integrity 白名单外 → resolveModelFile 403。
  await writeFile(join(dst, 'model3.json'), JSON.stringify(parsed, null, 2) + '\n', { encoding: 'utf8' })
  // 仅在源入口非标准名（如 Haru.model3.json）时删源命名副本；若源本就命名 model3.json，
  // 上一行已同路径覆盖，不得 rm 自删（Task 7 审查捕获）。
  if (m3Name !== 'model3.json') await rm(join(dst, m3Name))

  // 注入 LICENSE.txt（先于 manifest/integrity，licenseRef/LICENSE.txt 须已落地）
  const note = licenseNote ? await readFile(licenseNote, 'utf8') : defaultLicenseNote(modelDir)
  await writeFile(join(dst, 'LICENSE.txt'), note, { encoding: 'utf8' })

  // manifest（必填 + 可选：version/expressions/motions 从 model3.json 读，缺失省略）
  const manifest = {
    id,
    displayName,
    modelFile: 'model3.json', // 规范入口（源 *.model3.json 已复制为 model3.json，删去源命名副本）
    licenseRef: 'LICENSE.txt',
    integrityManifest: 'integrity.json'
  }
  if (preview) manifest.preview = preview
  if (parsed.Version !== undefined && parsed.Version !== null) manifest.version = String(parsed.Version)
  const expressions = Array.isArray(fr.Expressions)
    ? fr.Expressions.map((e) => e && typeof e.File === 'string' ? e.File : '').filter(Boolean)
    : []
  if (expressions.length > 0) manifest.expressions = expressions
  const motions = []
  if (fr.Motions && typeof fr.Motions === 'object') {
    for (const group of Object.values(fr.Motions)) {
      if (Array.isArray(group)) {
        for (const m of group) {
          if (m && typeof m.File === 'string') motions.push(m.File)
        }
      }
    }
  }
  if (motions.length > 0) manifest.motions = motions
  await writeFile(join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8' })

  // integrity.json：computeIntegrity 排除 manifest/integrity 自身，含 LICENSE.txt/preview.png（spec §3.5 step 6）
  const entries = await computeIntegrity(dst)
  await writeFile(join(dst, 'integrity.json'), JSON.stringify({ files: entries }, null, 2) + '\n', { encoding: 'utf8' })

  const files = entries.length
  const bytes = entries.reduce((acc, e) => acc + e.size, 0)
  const m3Sha = (await hashFile(join(dst, 'model3.json'))).sha256
  return { id, dst, files, bytes, hashes: files, modelFile: 'model3.json', modelFileSha256: m3Sha, preview }
}

function printUsage() {
  console.log('用法: pnpm -F @cyrene/desktop live2d:install --model-dir <dir> --id <slug> --display-name <name> [--license-note <file>] [--force] [--user-data dev|default]')
  console.log('  --user-data dev     装配到开发目录 <appData>/Cyrene-Dev/models（缺省；与 `pnpm dev` 一致）')
  console.log('  --user-data default 装配到打包产物目录 <appData>/Cyrene/models')
}

async function main() {
  const args = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--force') { opts.force = true; continue }
    if (a === '--help' || a === '-h') { printUsage(); return 0 }
    if (a === '--model-dir' || a === '--id' || a === '--display-name' || a === '--license-note' || a === '--user-data') {
      const next = args[i + 1]
      if (!next || next.startsWith('--')) throw new Error(`参数 ${a} 缺值`)
      opts[a.slice(2).replace(/-/g, '_')] = next
      i += 1
      continue
    }
    throw new Error(`未知参数: ${a}`)
  }
  const { model_dir: modelDir, id, display_name: displayName, license_note: licenseNote, user_data: userDataFlavor } = opts
  if (!modelDir || !id || !displayName) {
    printUsage()
    throw new Error('缺必填参数: --model-dir / --id / --display-name')
  }
  if (userDataFlavor !== undefined && !USER_DATA_FLAVORS.includes(userDataFlavor)) {
    printUsage()
    throw new Error(`--user-data 只接受 ${USER_DATA_FLAVORS.join(' / ')}（收到 ${userDataFlavor}）`)
  }
  const modelsDir = resolveModelsDir(process.env, userDataFlavor ?? DEFAULT_CLI_USER_DATA_FLAVOR)
  const report = await installModel({
    modelDir, id, displayName,
    licenseNote, force: opts.force === true, modelsDir
  })
  console.log(`[live2d:install] ${report.id} 装配完成 → ${report.dst}`)
  console.log(`[live2d:install] 文件数 ${report.files} / 总字节 ${report.bytes} / SHA-256 数 ${report.hashes}`)
  console.log(`[live2d:install] 入口 ${report.modelFile} sha256 ${report.modelFileSha256}`)
  return 0
}

// 直接执行（node scripts/live2d-install.mjs）才运行 main()；被测试/vitest import 时不触发。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    if (code) process.exitCode = code
  }).catch((err) => {
    console.error(`[live2d:install] 失败: ${err.message}`)
    process.exit(1)
  })
}
