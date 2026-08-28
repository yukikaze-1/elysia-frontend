import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const REVIEW = join(DOCS, 'review')
const SUPERPOWERS = join(DOCS, 'superpowers')
const REVIEW_INDEX = join(REVIEW, 'README.md')
const SUPERPOWERS_INDEX = join(SUPERPOWERS, 'README.md')
const writeIndexes = process.argv.includes('--write-indexes')

const toPosix = (value) => value.replaceAll('\\', '/')
const read = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
const markdownFiles = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .reverse()

function reviewType(name) {
  if (name.includes('决策记录')) return '决策'
  if (name.includes('真实联调验收')) return '真实联调验收'
  if (name.includes('验收')) return '验收'
  if (name.includes('归档')) return '历史归档'
  if (name.includes('台账')) return '取证台账'
  if (/问题|阻断|整改|复核|清单|待办/.test(name)) return '整改/清单'
  if (name.includes('报告')) return '报告'
  return '其他'
}

function dateFromName(name) {
  return name.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '—'
}

function reviewIndexContent() {
  const files = markdownFiles(REVIEW)
  const rows = files.map((name) => {
    const label = name.slice(0, -3)
    return `| ${dateFromName(name)} | ${reviewType(name)} | [${label}](./${name}) |`
  })

  return `# Review、决策与验收索引

> 本文件由 \`pnpm docs:index\` 根据目录内容生成；不要手工维护条目。
> 历史记录只描述对应日期和 commit 的事实，当前项目状态以 [doc 16](../16-Cyrene-前端实施任务清单与进度跟踪.md) 为准。

共 ${files.length} 份历史记录。

| 日期 | 类型 | 文档 |
|---|---|---|
${rows.join('\n')}
`
}

function superpowersIndexContent() {
  const reports = markdownFiles(SUPERPOWERS)
  const specs = markdownFiles(join(SUPERPOWERS, 'specs'))
  const plans = markdownFiles(join(SUPERPOWERS, 'plans'))

  const section = (title, files, prefix = '') => {
    const rows = files.map((name) => {
      const label = name.slice(0, -3)
      return `| ${dateFromName(name)} | [${label}](./${prefix}${name}) |`
    })
    return `## ${title}（${files.length}）

| 日期 | 文档 |
|---|---|
${rows.join('\n')}`
  }

  return `# Spec、Plan 与 Final Report 索引

> 本文件由 \`pnpm docs:index\` 根据目录内容生成；不要手工维护条目。
> 这些文件是历史设计与实施证据，不是当前状态源。当前项目状态以 [doc 16](../16-Cyrene-前端实施任务清单与进度跟踪.md) 为准。

共 ${reports.length + specs.length + plans.length} 份文档。

${section('Final reports', reports)}

${section('Specs', specs, 'specs/')}

${section('Plans', plans, 'plans/')}
`
}

const expectedReviewIndex = reviewIndexContent()
const expectedSuperpowersIndex = superpowersIndexContent()

if (writeIndexes) {
  writeFileSync(REVIEW_INDEX, expectedReviewIndex, 'utf8')
  writeFileSync(SUPERPOWERS_INDEX, expectedSuperpowersIndex, 'utf8')
  console.log('Updated docs/review/README.md and docs/superpowers/README.md')
}

const errors = []
const fail = (message) => errors.push(message)

function assertGeneratedIndex(path, expected) {
  if (!existsSync(path)) {
    fail(`Missing generated index: ${toPosix(relative(ROOT, path))}`)
    return
  }
  if (read(path) !== expected) {
    fail(`Generated index is stale: ${toPosix(relative(ROOT, path))}; run pnpm docs:index`)
  }
}

assertGeneratedIndex(REVIEW_INDEX, expectedReviewIndex)
assertGeneratedIndex(SUPERPOWERS_INDEX, expectedSuperpowersIndex)

const coreDocs = readdirSync(DOCS)
  .filter((name) => /^\d{2}-.*\.md$/.test(name))
  .sort()

const expectedPrefixes = Array.from({ length: 19 }, (_, index) =>
  String(index).padStart(2, '0')
)

if (coreDocs.length !== expectedPrefixes.length) {
  fail(
    `Expected ${expectedPrefixes.length} core documents (00–18), found ${coreDocs.length}`
  )
}

for (const prefix of expectedPrefixes) {
  if (!coreDocs.some((name) => name.startsWith(`${prefix}-`))) {
    fail(`Missing core document prefix: ${prefix}`)
  }
}

const requiredMetadata = [
  '**文档状态：**',
  '**最后核验：**',
  '**适用阶段：**',
  '**权威范围：**'
]

for (const name of coreDocs) {
  const path = join(DOCS, name)
  const content = read(path)
  for (const field of requiredMetadata) {
    if (!content.includes(field)) {
      fail(`Missing metadata ${field} in docs/${name}`)
    }
  }

  const statusLine = content
    .split('\n')
    .find((line) => line.startsWith('**文档状态：**'))
  if (statusLine && !/维护中|参考|已归档/.test(statusLine)) {
    fail(`Unknown document status in docs/${name}: ${statusLine}`)
  }
  if (statusLine && statusLine.length > 200) {
    fail(`Document status is too long in docs/${name}; move history out of metadata`)
  }
}

const rootReadme = read(join(ROOT, 'README.md'))
const claude = read(join(ROOT, 'CLAUDE.md'))
const doc16Name = coreDocs.find((name) => name.startsWith('16-'))
const doc16 = doc16Name ? read(join(DOCS, doc16Name)) : ''

if ((rootReadme.match(/最新状态/g) ?? []).length > 0) {
  fail('README must not contain stacked “最新状态” blocks; link to doc 16 instead')
}
if (!rootReadme.includes('16-Cyrene-前端实施任务清单与进度跟踪.md')) {
  fail('README does not link to doc 16')
}
if (!claude.includes('16-Cyrene-前端实施任务清单与进度跟踪.md')) {
  fail('CLAUDE.md does not link to doc 16')
}

for (const phrase of [
  'available in this environment',
  'MCP server is connected',
  '本环境(Claude',
  '本环境（Claude',
  '无 GitHub 凭据'
]) {
  if (rootReadme.includes(phrase) || claude.includes(phrase)) {
    fail(`Machine/session assertion remains in README or CLAUDE.md: ${phrase}`)
  }
}

doc16.split('\n').forEach((line, index) => {
  if (line.length > 500) {
    fail(`doc 16 line ${index + 1} exceeds 500 characters`)
  }
})

const doc00Name = coreDocs.find((name) => name.startsWith('00-'))
const doc00 = doc00Name ? read(join(DOCS, doc00Name)) : ''
for (const requiredLink of [
  'review/README.md',
  'superpowers/README.md',
  '18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md'
]) {
  if (!doc00.includes(requiredLink)) {
    fail(`doc 00 is missing index entry: ${requiredLink}`)
  }
}

for (const prefix of ['10-', '12-', '16-']) {
  const name = coreDocs.find((item) => item.startsWith(prefix))
  if (!name) continue
  const content = read(join(DOCS, name))
  if (!content.includes('review/2026-08-29-阶段8暂缓决策记录.md')) {
    fail(`docs/${name} does not link to the phase-8 deferral decision`)
  }
}

function stripCode(content) {
  return content
    .replace(/\`\`\`[\s\S]*?\`\`\`/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/\`[^\`\n]*\`/g, '')
}

function checkLinks(path) {
  const content = stripCode(read(path))
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g

  for (const match of content.matchAll(pattern)) {
    let target = match[1]
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1)
    }
    if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue

    target = target.split('#', 1)[0]
    if (!target) continue

    try {
      target = decodeURI(target)
    } catch {
      fail(`Invalid URI in ${toPosix(relative(ROOT, path))}: ${target}`)
      continue
    }

    const resolved = resolve(dirname(path), target)
    if (!existsSync(resolved)) {
      fail(
        `Broken link in ${toPosix(relative(ROOT, path))}: ${target} -> ${toPosix(relative(ROOT, resolved))}`
      )
    }
  }
}

const linkSurfaces = [
  join(ROOT, 'README.md'),
  join(ROOT, 'CLAUDE.md'),
  REVIEW_INDEX,
  SUPERPOWERS_INDEX
]

for (const name of coreDocs) {
  const path = join(DOCS, name)
  const statusLine = read(path)
    .split('\n')
    .find((line) => line.startsWith('**文档状态：**'))
  if (statusLine?.includes('维护中')) linkSurfaces.push(path)
}

for (const path of new Set(linkSurfaces)) {
  checkLinks(path)
}

if (errors.length > 0) {
  console.error(`Documentation check failed with ${errors.length} issue(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Documentation check passed: ${coreDocs.length} core docs, ${markdownFiles(REVIEW).length} review records, ${markdownFiles(SUPERPOWERS).length + markdownFiles(join(SUPERPOWERS, 'specs')).length + markdownFiles(join(SUPERPOWERS, 'plans')).length} superpowers records`
)
