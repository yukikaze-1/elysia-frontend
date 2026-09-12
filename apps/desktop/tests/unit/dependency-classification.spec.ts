// tests/unit/dependency-classification.spec.ts
// P2-3（2026-09-12）：依赖归类的**双向**守卫。
//
// 背景（评审 M-38，实测确认）：`package.json` 把 `vue`/`pinia`/`marked`/`dompurify` 放在 `dependencies`，
// 而它们**只被 renderer 使用且已打进 chunk**——electron-builder 会把 `dependencies` 整棵装进
// `resources/app/node_modules`。实测打包后该目录 **20.87 MB**（本机 `pnpm package` 复现，与评审数字一致）。
//
// 机制（本文件断言的基础，均已实测）：
//   · electron-vite 的 `externalizeDepsPlugin()` 外置 **`dependencies`** 中的模块 → 这些必须随包分发；
//   · 不在 `dependencies` 里的（即 devDependency）会被 **bundle 进产物**（我把 `semver` 临时 import 进
//     main 验证过：`out/main/index.js` 里没有 `require("semver")`，而是被内联）。
//   故两条不变量各自对应一个真实后果：
//     A. `dependencies` 里的每个包**必须**真的被 main/preload 在运行时用到 —— 否则就是纯死重（M-38 本身）；
//     B. main/preload 用到的每个包**必须**在 `dependencies` 里 —— 否则它的"随包分发"属性只靠
//        "碰巧被 bundle 了"支撑，一旦 bundler 行为/配置变化就会在打包产物里缺模块。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SRC_ROOT = join(DESKTOP_ROOT, 'src')

interface PackageJson { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(DESKTOP_ROOT, 'package.json'), 'utf8')) as PackageJson
}

/** 递归收集 main/preload 的 .ts 源码（跳过 .d.ts：纯类型声明不产生运行时依赖） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { collectSources(path, out); continue }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/**
 * 提取"main/preload 运行时会 require 的裸模块名"。
 * 正则只匹配真正的 import/require 语句——**不要**用宽松的 `'...'` 抓取：
 * 我第一版用 `(?:from|require\()\s*'([^']+)'` 把解构赋值里的字符串（如 `] = input.localDate`）也抓了进来，
 * 于是拿到两个假阳性"包名"。扫描器必须先自证可靠（见文件末尾的退化哨兵）。
 *
 * 另注：这里**必须**用 JS 的 `m` 标志，不能写 `(?m)` —— 后者是 .NET/PCRE 的内联标志语法，
 * 在 JS 里是非法分组（我第一次就是这么写的，vitest 直接报 Invalid group 而整个文件 0 用例）。
 */
function collectBareSpecifiers(files: string[]): Set<string> {
  const found = new Set<string>()
  const add = (specifier: string): void => {
    // 只要**裸**模块名：相对路径（./ ../）由打包器解析、不是 npm 包，不该进这个集合
    if (specifier.startsWith('.')) return
    found.add(specifier)
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/^\s*import\s+(?:[\s\S]*?)\s+from\s*'([^']+)'/gm)) add(match[1])
    for (const match of text.matchAll(/^\s*import\s*'([^']+)'/gm)) add(match[1])
    for (const match of text.matchAll(/(?<![.\w])require\(\s*'([^']+)'\s*\)/g)) add(match[1])
  }
  return found
}

/** 是否 Node 内建（含 `node:` 前缀与 `fs/promises` 这类子路径） */
function isBuiltin(specifier: string): boolean {
  const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  if (builtinModules.includes(name)) return true
  const base = name.split('/')[0]
  return builtinModules.includes(base)
}

const sourceFiles = [...collectSources(join(SRC_ROOT, 'main')), ...collectSources(join(SRC_ROOT, 'preload'))]
const specifiers = collectBareSpecifiers(sourceFiles)
const pkg = readPackageJson()
const runtimeDeps = Object.keys(pkg.dependencies ?? {})
/** electron 由运行时提供（devDependency 是有意为之），不算"未被声明的运行时依赖" */
const RUNTIME_PROVIDED = new Set(['electron'])
/** 工作区内部别名（由 tsconfig/vite alias 解析，不是 npm 包） */
const INTERNAL_ALIAS = /^@shared\//

describe('依赖归类守卫（P2-3）——扫描器自证', () => {
  it('退化哨兵：扫描器确实扫到了源码与裸导入（否则下面两条断言会恒真）', () => {
    expect(sourceFiles.length, '未扫到 main/preload 源码').toBeGreaterThan(20)
    expect(specifiers.size, '未扫到任何裸导入——扫描器或正则已失效').toBeGreaterThan(5)
    expect(runtimeDeps.length, 'dependencies 为空——守卫失去意义').toBeGreaterThan(0)
  })

  it('扫描器只收裸模块名：不把相对路径或字符串字面量当包名', () => {
    for (const specifier of specifiers) {
      expect(specifier, `可疑的"包名"（含空格/引号/中括号）说明正则过宽：${specifier}`).not.toMatch(/[\s'"[\]]/)
      expect(specifier.startsWith('.'), `相对路径不该出现在裸导入集合里：${specifier}`).toBe(false)
    }
  })
})

describe('不变量 A：dependencies 里的每个包都必须被 main/preload 真正用到（防死重回潮）', () => {
  it('无"随包分发却无人使用"的依赖（M-38 的 16 MB 死重就是这一类）', () => {
    const shippedButUnused = runtimeDeps.filter((dep) => !specifiers.has(dep))
    expect(
      shippedButUnused,
      `以下依赖会被 electron-builder 打进 resources/app/node_modules，但 main/preload 从未使用` +
      `（只被 renderer 用的包应放 devDependencies：它们已被 bundle 进 renderer chunk）：\n${shippedButUnused.join('\n')}`
    ).toEqual([])
  })
})

describe('不变量 B：main/preload 用到的每个包都必须在 dependencies 里（防打包缺模块）', () => {
  it('运行时依赖无一遗漏', () => {
    const missing = [...specifiers]
      .filter((specifier) => !INTERNAL_ALIAS.test(specifier))
      .filter((specifier) => !isBuiltin(specifier))
      .filter((specifier) => !RUNTIME_PROVIDED.has(specifier))
      .filter((specifier) => !runtimeDeps.includes(specifier))
      .sort()
    expect(
      missing,
      `以下模块被 main/preload 在运行时使用，却不在 dependencies 里：\n${missing.join('\n')}`
    ).toEqual([])
  })
})
