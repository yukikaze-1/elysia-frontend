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
const ARCHIVE = join(DOCS, 'archive')
const REVIEW_INDEX = join(REVIEW, 'README.md')
const SUPERPOWERS_INDEX = join(SUPERPOWERS, 'README.md')
const ARCHIVE_INDEX = join(ARCHIVE, 'README.md')
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
    if (files.length === 0) return `## ${title}（0）\n\n本目录已无此类文档（均已移入 [归档索引](../archive/README.md)）。`
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
> 已有 final report 接管结论的批次已移入 [归档索引](../archive/README.md)；两处合计即全部历史记录。

共 ${reports.length + specs.length + plans.length} 份现行文档。

${section('Final reports', reports)}

${section('Specs', specs, 'specs/')}

${section('Plans', plans, 'plans/')}
`
}

function archiveIndexContent() {
  const reports = markdownFiles(join(ARCHIVE, 'reports'))
  const specs = markdownFiles(join(ARCHIVE, 'specs'))
  const plans = markdownFiles(join(ARCHIVE, 'plans'))

  const rows = (files, prefix) =>
    files
      .map((name) => {
        const label = name.slice(0, -3)
        return `| ${dateFromName(name)} | [${label}](./${prefix}${name}) |`
      })
      .join('\n')

  return `# 历史归档索引（阶段 0～2 与首轮联调整改）

> 本文件由 \`pnpm docs:index\` 根据目录内容生成；不要手工维护条目。
> 归档条件：**该批次已有 final report 接管结论**，且其设计/计划已被后续阶段与现行代码完全吸收。
> 归档不等于失效：这些文件仍是契约与决策的唯一原始记录，可被引用；只是不再作为当前实现的必读入口。
> 阶段 3 及之后没有 final report，其 spec/plan 仍是主要技术记录，因此留在 [superpowers 索引](../superpowers/README.md)。
> 当前项目状态以 [doc 16](../16-Cyrene-前端实施任务清单与进度跟踪.md) 为准。

共 ${reports.length + specs.length + plans.length} 份归档文档。按内容归属分布如下（表格按日期倒序，阶段信息以标题为准）：

| 归属 | 文档数 | 对应文件名前缀 |
|---|---:|---|
| 阶段 1 安全骨架（地基 + 块 A/B/C） | 8 | \`2026-08-08-phase1-foundation\`、\`2026-08-09-phase1-*\` |
| 阶段 2 核心聊天闭环（块 A/B/C + realconn A/B/C） | 16 | \`2026-08-1{0,1,2}-phase2-*\` |
| 阶段 0/1 整改（复核批次 A～D） | 12 | \`2026-08-12-phase01-recheck-*\` |
| 首次/二次真实联调整改 | 6 | \`2026-08-13-realint*-fix\` |

> 阶段 0 没有独立 spec/plan：其协议与工程基线由 \`phase1-foundation\` 一并建立，实质性阶段 0 整改见 \`phase01-recheck-batchD\`。

## Final reports（${reports.length}）

| 日期 | 文档 |
|---|---|
${rows(reports, 'reports/')}

## Specs（${specs.length}）

| 日期 | 文档 |
|---|---|
${rows(specs, 'specs/')}

## Plans（${plans.length}）

| 日期 | 文档 |
|---|---|
${rows(plans, 'plans/')}
`
}

const expectedReviewIndex = reviewIndexContent()
const expectedSuperpowersIndex = superpowersIndexContent()
const expectedArchiveIndex = archiveIndexContent()

if (writeIndexes) {
  writeFileSync(REVIEW_INDEX, expectedReviewIndex, 'utf8')
  writeFileSync(SUPERPOWERS_INDEX, expectedSuperpowersIndex, 'utf8')
  writeFileSync(ARCHIVE_INDEX, expectedArchiveIndex, 'utf8')
  console.log('Updated docs/review/README.md, docs/superpowers/README.md and docs/archive/README.md')
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
assertGeneratedIndex(ARCHIVE_INDEX, expectedArchiveIndex)

const coreDocs = readdirSync(DOCS)
  .filter((name) => /^\d{2}-.*\.md$/.test(name))
  .sort()

// 00～19：19 是 2026-09-12 新增的开发环境隔离与资源登记（多项目并行开发的端口/userData 口径）。
// 新增核心编号文档时必须同步这里的长度（否则「文档总数不符」会静默放过缺失编号）。
const expectedPrefixes = Array.from({ length: 20 }, (_, index) =>
  String(index).padStart(2, '0')
)

if (coreDocs.length !== expectedPrefixes.length) {
  fail(
    `Expected ${expectedPrefixes.length} core documents (00–19), found ${coreDocs.length}`
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
  SUPERPOWERS_INDEX,
  ARCHIVE_INDEX
]

// 2026-09-15（评审 `S7-D1`）：`docs/` 根下**非编号**文档此前完全不参与任何检查——既无元数据校验、
// 也无链接检查、也无行宽。于是 `docs/2026-08-29-UI精修整改清单.md:6` 的「当前状态源」两条链接
// 长期 404（写成 `../16-…`，而该文件就在 `docs/` 根），并且它是 README 与 doc 00 §5.1 正式挂出的入口。
// 这些文件是**产品意图与专项清单**的落点（PRD、多角色架构设计、UI 走查记录…），不是历史归档，
// 所以按「活文档」对待：纳入链接检查。
//
// 仍然**刻意排除**的两类（都有理由，且不因此失去全部保护）：
//   · `docs/archive/**`：归档文档的正文链接指向归档前的相对位置，属历史快照的一部分——改写它们
//     等于改写历史记录的组织方式；其入口（archive/README.md 生成的索引）仍在检查面内。
//   · `docs/review/**`：同理（含多份「治理前快照」，其链接按当时的目录结构书写）。索引 README 受检。
// 这两类的断链现状已如实记录在 `docs/review/2026-09-15-五路并行全量评审发现汇总.md` §7。
for (const name of readdirSync(DOCS)) {
  if (name.endsWith('.md') && !name.startsWith('README')) linkSurfaces.push(join(DOCS, name))
}

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

const superpowersCount =
  markdownFiles(SUPERPOWERS).length +
  markdownFiles(join(SUPERPOWERS, 'specs')).length +
  markdownFiles(join(SUPERPOWERS, 'plans')).length
const archiveCount =
  markdownFiles(join(ARCHIVE, 'reports')).length +
  markdownFiles(join(ARCHIVE, 'specs')).length +
  markdownFiles(join(ARCHIVE, 'plans')).length

console.log(
  `Documentation check passed: ${coreDocs.length} core docs, ${markdownFiles(REVIEW).length} review records, ${superpowersCount} superpowers records, ${archiveCount} archived records`
)
