#!/usr/bin/env node
// apps/desktop/scripts/verify-sensitive.mjs
// 敏感信息泄漏扫描门禁（spec §5.1，D7A-14）：默认扫描 `git ls-files` 全量跟踪文件；
// 本地提交前可传 `--include-untracked`，把未忽略的新文件一并纳入 → 黑名单 → 行级 allowlist。
//  - 排除：third_party/（vendor，见 core 注释）+ vendored live2d 两树 + 扫描器自身三文件（HIGH-1/R2 备注：
//    自排除名单是恒定盲区——任何变更（增删文件/加通配）须过 review）；out//dist/ 未跟踪天然不扫；.playwright-mcp/ 未跟踪同不扫。
//    另有**按规则**排除（core RULE_FILE_EXCLUSIONS）：文件仍扫其余规则，只不套用某条通用启发式。
//  - allowlist 为行级锚定（path 精确 + anchor 正则 + 人核理由）；fail-loud——锚定不命中任何行即报错。
//  - 任一违规或 fail-loud 错误 → exit 1；全绿 → exit 0 + 摘要。
//
// 2026-09-10 门禁漂移整改（背景：该门自 2026-08-29 起长期全红、事实失效，掩盖了同期 CI 里的真实回归）：
//  ① `base64-long-string` 由「够长」收窄为「像秘密」（core isSecretLikeBase64，附实测检出保真度）；
//  ② allowlist 由 249 条重算为 56 条——删掉的 192 条都是「文件里有 40+ 长串」这一失效理由的产物；
//  ③ 新增按规则文件排除承接锁文件的 npm integrity 哈希。
//  维护纪律不变：新增命中仍须走 fail-loud + 人工理由，禁止用通配锚定批量放行。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECRET_BLACKLIST,
  RULE_FILE_EXCLUSIONS,
  isExcludedPath,
  isSelfExcludedFile,
  isRuleExcludedForPath,
  scanSecretsInText,
  allowlistEntryFor,
  allowlistEntryMatches
} from './verify-sensitive-core.mjs'

// ── 行级 allowlist：{ path: 仓库相对路径（精确）; anchor: RegExp（锚定段）; reason: 人工核对理由 } ──
// 纪律：每条必须注明「已人工核对无真实秘密」的依据（来源与形态）；锚定段取命中行内最能定位该行
// 的片段（防行号漂移 + 防别的正则变体静默换锚）。
//
// 2026-09-10 重算（门禁漂移整改）：`base64-long-string` 收窄为「像秘密」（见 core isSecretLikeBase64）
// 后，原 249 条中 192 条类别级条目已不再命中——它们当初存在的唯一理由是「这个文件里有 40+ 长串」，
// 而被命中的其实是相对 import 路径、camelCase 标识符串与 hex 摘要。重算后保留 55 条（全部为具名假值/
// 散文自引用，理由原文未改），新增 1 条；条目总数 249 → 56。
// 历史核对记录：2026-08-22 首跑逐行核对（task-7-report.md 附完整清单）；本次重算不修改任何保留条目的
// reason，仅删除已失效条目——删除属"命中面缩小"，不是放宽既有豁免。
const ALLOWLIST = [
  // ── 应用代码与测试夹具 ──
  {
    path: 'apps/desktop/src/main/diagnostics/redact.ts', anchor: /Bearer token 先被长串规则命中/,
    reason: 'RULES 顺序注释散文「（否则 Bearer token 先被…命中）」——已人工核对无真实秘密（仅描述性文字）'
  },
  {
    path: 'apps/desktop/src/main/transport/real-backend.ts', anchor: /activate \+ Bearer \+ 错误映射/,
    reason: 'Task 5 接口注释散文（REST 会话方法清单「+ Bearer +」）——已人工核对无真实秘密'
  },
  {
    path: 'apps/desktop/src/main/transport/real-backend.ts', anchor: /Authorization Bearer \+ content-type/,
    reason: 'restFetch 注释散文（「Authorization Bearer + content-type」）——已人工核对无真实秘密'
  },
  {
    path: 'apps/desktop/tests/unit/audit.spec.ts', anchor: /with Bearer abc\.def-ghi_123XYZ/,
    reason: 'audit 夹具 summary 示例值 abc.def-ghi_123XYZ——已人工核对为假 token（非凭据，仅验证脱敏）'
  },
  {
    path: 'apps/desktop/tests/unit/logger.spec.ts', anchor: /token: 'Bearer abc\.def-ghi_123XYZ'/,
    reason: 'logger 夹具示例值（path+token 整形行，与前一行同组假值）——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/diagnostics-service.spec.ts', anchor: /Bearer sk-1234567890abc/,
    reason: '日志夹具写入行（line1\\nBearer sk-1234567890abc\\n…，整行两规则命中由本条目放行）——假串样例'
  },
  {
    path: 'apps/desktop/tests/unit/diagnostics-service.spec.ts', anchor: /"summary":"Bearer abc12345"/,
    reason: 'audit 夹具 summary 假值 abc12345——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/diagnostics-service.spec.ts', anchor: /toContain\('sk-1234567890abc'\)/,
    reason: 'not.toContain 断言反义样例（验导出文件不含该假串）——假串，非凭据'
  },
  {
    path: 'apps/desktop/tests/unit/diagnostics-service.spec.ts', anchor: /toContain\('sk-abcdef0123456789'\)/,
    reason: 'not.toContain 断言反义样例——假串，非凭据'
  },
  {
    path: 'apps/desktop/tests/unit/diagnostics-service.spec.ts', anchor: /toContain\('Bearer abc12345'\)/,
    reason: 'not.toContain 断言反义样例——假 token，非凭据'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /'Bearer sk-1234567890abc', 'plain'/,
    reason: 'buildExportPayload 夹具 logFiles.lines 假串（整行两规则命中由本条目放行）——假串样例'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /"summary":"Bearer abc12345"/,
    reason: 'auditLines 夹具 summary 假值 abc12345——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /toContain\('sk-1234567890abc'\)/,
    reason: 'not.toContain 断言反义样例——假串，非凭据'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /toContain\('Bearer abc12345'\)/,
    reason: 'not.toContain 断言反义样例——假 token，非凭据'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /redactSensitiveValues\('Bearer sk-1234567890abc'\)/,
    reason: 'redact 挂接断言（整行两规则命中由本条目放行）——假串 + 期望输出 [REDACTED]'
  },
  {
    path: 'apps/desktop/tests/unit/export-payload.spec.ts', anchor: /os: 'Bearer sk-abcdef'/,
    reason: 'manifest 夹具假值 sk-abcdef——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/real-backend-tools.spec.ts', anchor: /authorization: 'Bearer tok'/,
    reason: 'getToolCallStatus 断言假值 tok——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/real-backend.spec.ts', anchor: /\.toBe\('Bearer sk-test'\)/,
    reason: '握手断言假值 sk-test——已人工核对为假 token（测试专用）'
  },
  {
    path: 'apps/desktop/tests/unit/real-backend.spec.ts', anchor: /cursor \+ Bearer \+ 映射/,
    reason: 'it 标题散文「透传 limit/cursor + Bearer + 映射」——已人工核对无真实秘密'
  },
  {
    path: 'apps/desktop/tests/unit/real-backend.spec.ts', anchor: /\.toBe\('Bearer sk-token'\)/,
    reason: 'listConversations 断言假值 sk-token——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/real-backend.spec.ts', anchor: /\.toBe\('Bearer secret-token'\)/,
    reason: 'create 消息请求断言假值 secret-token，全部来自 fixture——已人工核对为假 token'
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /Bearer token → Bearer \[REDACTED\]/,
    reason: 'it 标题散文（含 → 输出形态）——已人工核对无真实秘密'
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /auth: Bearer abc\.def-ghi_123XYZ/,
    reason: 'redact 单测输入假值 abc.def-ghi_123XYZ（期望输出 [REDACTED]）——假 token'
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /redactSensitiveValues\('key=sk-abc123DEF456ghi789'\)/,
    reason: 'redact 单测输入假值（sk- + 15 位）——假串，非 SK-API 凭据'
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /redactSensitiveValues\('key=AKIAIOSFODNN7EXAMPLE'\)/,
    reason: 'AWS 官方文档示例 key（AKIAIOSFODNN7EXAMPLE，公开样例）——假值非真实 Access Key'
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /≥40 Bearer token 由 Bearer 规则命中/,
    reason: 'it 标题散文（顺序回归描述）——已人工核对无真实秘密'
  },
  // ── 文档（设计/决策/历史记录中的散文与内嵌样例） ──
  {
    path: 'docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md', anchor: /GET \+ Bearer \+ `safeParse`/,
    reason: '阶段 6 批次 C 实现注记散文（GET + Bearer + safeParse 描述）——已人工核对无真实秘密'
  },
  {
    path: 'docs/review/2026-08-29-doc16实施进度历史归档.md', anchor: /静态 Bearer \+ `AGENT_ACCESS_TOKEN`/,
    reason: 'B-02 条目散文（契约描述「静态 Bearer + AGENT_ACCESS_TOKEN」）——无赋值形态，无秘密实例'
  },
  {
    path: 'docs/review/2026-08-29-doc16实施进度历史归档.md', anchor: /激活 \+ Bearer \+ 错误映射/,
    reason: '阶段 2 块 B 落地记录散文（REST 方法清单）——已人工核对无真实秘密'
  },
  {
    path: 'docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md', anchor: /Bearer \+ `server_info` 版本/,
    reason: '状态注记散文（握手 header 描述「electron/Bearer +」）——已人工核对无真实秘密'
  },
  {
    path: 'docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md', anchor: /都发送同一 Bearer token/,
    reason: '契约描述散文（WS/REST 同 header 说明）——已人工核对无真实秘密'
  },
  {
    path: 'docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md', anchor: /实现 Bearer \+ 两个 v2 header/,
    reason: '工作项描述散文（实现说明）——已人工核对无真实秘密'
  },
  {
    path: 'docs/review/2026-08-20-阶段6批次C-决策记录.md', anchor: /GET \+ Bearer \+ 断连/,
    reason: 'D6C-11 决策表散文（real 实现描述）——已人工核对无真实秘密'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /Bearer token → Bearer \[REDACTED\]/,
    reason: '内嵌 redact 单测首行（计划文档的代码样例）——假值/散文'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /auth: Bearer abc\.def-ghi_123XYZ/,
    reason: '内嵌 redact 单测样例（与 redact.spec.ts:7 同一假值）——假 token'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /key=sk-abc123DEF456ghi789/,
    reason: '内嵌 redact 单测样例——假串，非 SK-API 凭据'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /key=AKIAIOSFODNN7EXAMPLE/,
    reason: 'AWS 官方文档示例 key（公开样例）——假值非真实 Access Key'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /Bearer token 先被长串规则命中/,
    reason: '内嵌 redact.ts 注释（与 redact.ts:3 同源散文）——无真实秘密'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /token: 'Bearer abc\.def-ghi_123XYZ'/,
    reason: '内嵌 logger.spec 样例（与 logger.spec.ts:55 同源假值）——假 token'
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /with Bearer abc\.def-ghi_123XYZ/,
    reason: '内嵌 audit.spec 样例（与 audit.spec.ts:29 同源假值）——假 token'
  },
  {
    path: 'docs/archive/plans/2026-08-11-phase2-real-backend.md', anchor: /\.toBe\('Bearer sk-test'\)/,
    reason: '内嵌 real-backend.spec 样例（与 spec.ts:87 同源假值）——假 token'
  },
  {
    path: 'docs/archive/plans/2026-08-11-phase2-real-backend.md', anchor: /透传 limit\/cursor \+ Bearer \+ 映射/,
    reason: '内嵌 it 标题散文——已人工核对无真实秘密'
  },
  {
    path: 'docs/archive/plans/2026-08-11-phase2-real-backend.md', anchor: /\.toBe\('Bearer sk-token'\)/,
    reason: '内嵌 real-backend.spec 样例——假 token'
  },
  {
    path: 'docs/archive/plans/2026-08-11-phase2-real-backend.md', anchor: /激活 \+ Bearer \+ 错误映射/,
    reason: '内嵌 git commit -m 文案（提交信息描述）——已人工核对无真实秘密'
  },
  {
    path: 'docs/superpowers/plans/2026-08-20-phase6-tools-batchc-scoped-grants-admin.md', anchor: /authorization: 'Bearer tok'/,
    reason: '内嵌 real-backend-tools.spec 样例（与 spec.ts:45 同源假值）——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-22-phase7-batcha-security-convergence.md', anchor: /行含 Bearer xxx\/sk-abc/,
    reason: 'spec 5.2 测试要点散文（「行含 Bearer xxx/sk-abc」占位描述）——已人工核对无真实秘密'
  },
  {
    path: 'docs/superpowers/specs/2026-08-20-phase6-tools-batchc-scoped-grants-admin-design.md', anchor: /\+ Bearer \+ `DesktopCallStatusSchema/,
    reason: '设计散文（real 实现描述「复用 restFetch + Bearer +」）——已人工核对无真实秘密'
  },
  {
    path: 'docs/superpowers/specs/2026-08-22-phase7-batcha-security-convergence-design.md', anchor: /`AGENT_ACCESS_TOKEN=`\/`ACCOUNT_TOKEN=`/,
    reason: 'D7A-14 决策表行（黑名单规则自引用——含正则字面量文本，整行两规则命中由本条目放行）——无秘密实例'
  },
  // ── 应用代码与测试夹具 ──
  {
    path: 'apps/desktop/src/main/tools/env-bridge.ts', anchor: /[A-Za-z0-9+/]{40,}/,
    reason: 'base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）', rules: ['base64-long-string']
  },
  {
    path: 'apps/desktop/tests/unit/redact.spec.ts', anchor: /[A-Za-z0-9+/]{40,}/,
    reason: 'base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）', rules: ['base64-long-string']
  },
  // ── 文档（设计/决策/历史记录中的散文与内嵌样例） ──
  {
    path: 'docs/review/2026-08-29-doc17环境记录历史归档.md', anchor: /对散文「Bearer \+ 词」天然高误报/,
    reason: 'bearer-token 命中 1 行——黑名单规则自引用说明散文（「Bearer + 词」误报说明——规则本体引用，非真实 secrets）（Task 8 门禁收口核对 2026-08-22）', rules: ['bearer-token']
  },
  {
    path: 'docs/review/2026-08-22-阶段7批次A-决策记录.md', anchor: /D7A-14 \| 敏感扫描黑名单 \|/,
    reason: 'agent/account-token-assign 命中 1 行（2 规则）——决策表 D7A-14 行内嵌黑名单正则字面量（AGENT_ACCESS_TOKEN/ACCOUNT_TOKEN 规则自引用——属「已人工核对无真实秘密」说明性示例，非真实 secrets）（Task 8 门禁收口核对 2026-08-22）', rules: ['agent-access-token-assign', 'account-token-assign']
  },
  {
    path: 'docs/review/2026-08-29-doc17环境记录历史归档.md', anchor: /黑名单 8 规则：Bearer token/,
    reason: '黑名单规则列示行（规则名/赋值形态字面量自引用——「已人工核对无真实秘密」说明性示例，非真实 secrets）（Task 8 门禁收口核对 2026-08-22）', rules: ['bearer-token', 'agent-access-token-assign', 'account-token-assign']
  },
  {
    path: 'docs/archive/plans/2026-08-09-phase1-trusted-services.md', anchor: /[A-Za-z0-9+/]{40,}/,
    reason: 'base64-long-string 命中本文件 11 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）', rules: ['base64-long-string']
  },
  {
    path: 'docs/superpowers/plans/2026-08-20-phase6-tools-batchb-main-exec-ui.md', anchor: /[A-Za-z0-9+/]{40,}/,
    reason: 'base64-long-string 命中本文件 22 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）', rules: ['base64-long-string']
  },
  // ── 应用代码与测试夹具 ──
  {
    path: 'apps/desktop/tests/unit/real-backend-character.spec.ts', anchor: /=== 'Bearer token-1'/,
    reason: 'real-backend-character 断言假值 token-1（角色 REST 会话方法 authorization 透传）——已人工核对为假 token'
  },
]
let failed = false
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => { console.error(`✗ ${m}`); failed = true }

const scriptDir = dirname(fileURLToPath(import.meta.url))
const includeUntracked = process.argv.includes('--include-untracked')
let repoRoot
let trackedFiles
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: scriptDir, encoding: 'utf8' }).trim()
  // -z：NUL 分隔原始字节路径（core.quotepath=false 双保险——默认下 CJK 路径被 C 转义加引号）
  const lsFilesArgs = ['-c', 'core.quotepath=false', 'ls-files', '-z']
  if (includeUntracked) lsFilesArgs.push('--cached', '--others', '--exclude-standard')
  trackedFiles = execFileSync('git', lsFilesArgs, {
    cwd: repoRoot, encoding: 'utf8'
  }).split('\0').filter(Boolean)
} catch (e) {
  console.error(`✗ git 不可用或脚本不在仓库内：${e.message}`)
  process.exit(1)
}

// 1. allowlist 配置自检（路径漂移/排除段覆盖 → fail-loud）
const allowlistByPath = new Map()
const trackedSet = new Set(trackedFiles)
for (const entry of ALLOWLIST) {
  if (!(entry.anchor instanceof RegExp) || typeof entry.reason !== 'string' || entry.reason.length === 0) {
    fail(`allowlist 条目缺 anchor/reason：${JSON.stringify(entry)}`)
    continue
  }
  // R2-1：rules 域——undefined/空 = 全规则豁免（精确条目）；数组 = 仅豁免列出的规则名（类别级条目）。
  // 数组必须非空且全部为已知黑名单规则名（防静默失效——类别级条目若不限定规则域，覆盖文件内
  // 「同时含 40+ run」的新增 Bearer/JWT/sk- 行会被静默放行，见 core allowlistEntryMatches 注记）。
  if (entry.rules !== undefined && entry.rules !== null) {
    if (!Array.isArray(entry.rules) || entry.rules.length === 0 ||
        !entry.rules.every((r) => SECRET_BLACKLIST.some((b) => b.name === r))) {
      fail(`allowlist 条目 rules 域非法（须为空、非空数组或已知规则名数组）：${JSON.stringify(entry)}`)
      continue
    }
  }
  if (isExcludedPath(entry.path)) {
    fail(`allowlist 条目路径落在排除段（应走排除而非 allowlist）：${entry.path}`)
    continue
  }
  if (!trackedSet.has(entry.path)) {
    fail(`allowlist 条目路径不在 git 跟踪清单（文件已删除/改名？）：${entry.path}`)
    continue
  }
  const list = allowlistByPath.get(entry.path) ?? []
  list.push(entry)
  allowlistByPath.set(entry.path, list)
}

// 2. 逐文件扫描（排除段跳过；黑名单命中 → allowlist 锚定兜底；锚定未命中 → 违规）
const firedAllowlist = new Set()
const violations = []
let scannedCount = 0
let excludedCount = 0
let allowedCount = 0
let skippedByRule = 0
for (const rel of trackedFiles) {
  // 排除 = 目录级 vendor（third_party/ + vendored live2d 两树）+ 扫描器自身三文件（HIGH-1：黑名单字面量/
  // 触发器必然命中自身且非秘密——被检面是本仓源码/文档/配置，不含扫描器本体）
  if (isExcludedPath(rel) || isSelfExcludedFile(rel)) { excludedCount++; continue }
  let content
  try {
    content = readFileSync(join(repoRoot, rel), 'utf8')
  } catch (e) {
    // 跟踪清单与工作树不一致（转换中文件）——视为流程故障，fail-closed
    fail(`读取失败：${rel} — ${e.message}`)
    continue
  }
  scannedCount++
  // 按规则排除（2026-09-10）：文件仍参与其余规则扫描，只是不套用某条通用启发式规则——
  // pnpm-lock.yaml 的 integrity sha512 天然是「40+ 高熵 base64」，见 core RULE_FILE_EXCLUSIONS。
  const allHits = scanSecretsInText(content, SECRET_BLACKLIST)
  const hits = allHits.filter((h) => !isRuleExcludedForPath(h.name, rel))
  skippedByRule += allHits.length - hits.length
  if (hits.length === 0) continue
  const entries = allowlistByPath.get(rel) ?? []
  for (const hit of hits) {
    const entry = allowlistEntryFor(entries, hit.text, hit.name)
    if (entry) {
      firedAllowlist.add(entry)
      // 同一条目可遮蔽同文件同行的另一条目（首匹配语义）——fired 追踪须覆盖「锚+规则域匹配该行」的
      // 全部条目，否则精确条目先命中时类别级条目永不触发 → fail-loud 误报（review 压坑实录）
      for (const e of entries) {
        if (e !== entry && allowlistEntryMatches(e, hit.text, hit.name)) firedAllowlist.add(e)
      }
      allowedCount++
    } else {
      violations.push({ path: rel, name: hit.name, line: hit.line, text: hit.text })
    }
  }
}

// 3. fail-loud：allowlist 锚定段本轮未命中任何行 → 内容漂移，报错要求人工复核
for (const entry of ALLOWLIST) {
  if (!firedAllowlist.has(entry)) {
    fail(`allowlist 锚定段未命中任何行（内容漂移/行删除？需人工复核）：${entry.path} ^/${entry.anchor.source}/（${entry.reason}）`)
  }
}

// 4. 输出与退出
if (violations.length > 0) {
  for (const v of violations) {
    console.error(`✗ ${v.path}:${v.line} ${v.name} → ${v.text.trim().slice(0, 80)}`)
  }
  failed = true
}
if (failed) {
  console.error('verify:sensitive 失败')
  process.exit(1)
}
ok(`扫描 ${scannedCount} 文件（排除 ${excludedCount} 个：third_party/ + vendored live2d 两树 + 扫描器自身）、按规则豁免 ${skippedByRule} 行（${Object.entries(RULE_FILE_EXCLUSIONS).map(([r, ps]) => `${r}@${ps.join(',')}`).join('; ')}）、allowlist 放行 ${allowedCount} 行、黑名单 ${SECRET_BLACKLIST.length} 规则`)
process.exit(0)
