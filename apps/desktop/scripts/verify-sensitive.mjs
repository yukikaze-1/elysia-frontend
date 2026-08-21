#!/usr/bin/env node
// apps/desktop/scripts/verify-sensitive.mjs
// 敏感信息泄漏扫描门禁（spec §5.1，D7A-14）：`git ls-files` 全量跟踪文件 → 黑名单 → 行级 allowlist。
//  - 排除：third_party/（vendor，见 core 注释）；out//dist/ 未跟踪天然不扫；.playwright-mcp/ 未跟踪同不扫。
//  - allowlist 为行级锚定（path 精确 + anchor 正则 + 人核理由）；fail-loud——锚定不命中任何行即报错。
//  - 任一违规或 fail-loud 错误 → exit 1；全绿 → exit 0 + 摘要。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECRET_BLACKLIST,
  isExcludedPath,
  isSelfExcludedFile,
  scanSecretsInText,
  allowlistEntryFor
} from './verify-sensitive-core.mjs'

// ── 行级 allowlist：{ path: 仓库相对路径（精确）; anchor: RegExp（锚定段）; reason: 人工核对理由 } ──
// 纪律：每条必须注明「已人工核对无真实秘密」的依据（来源与形态）；锚定段取命中行内最能定位该行
// 的片段（防行号漂移 + 防别的正则变体静默换锚）。锚定段与 2026-08-22 首跑逐行核对记录一致
// （task-7-report.md 附完整核对清单）。
const ALLOWLIST = [
  // ── src/main：注释散文（描述协议/RULES 行为，无秘密实例） ──
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

  // ── tests/unit：纯测试夹具与断言（全部为示例假值，无真实凭据） ──
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

  // ── docs：设计/计划/决策记录散文与内嵌代码样例（无秘密实例） ──
  {
    path: 'docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md', anchor: /GET \+ Bearer \+ `safeParse`/,
    reason: '阶段 6 批次 C 实现注记散文（GET + Bearer + safeParse 描述）——已人工核对无真实秘密'
  },
  {
    path: 'docs/16-Cyrene-前端实施任务清单与进度跟踪.md', anchor: /静态 Bearer \+ `AGENT_ACCESS_TOKEN`/,
    reason: 'B-02 条目散文（契约描述「静态 Bearer + AGENT_ACCESS_TOKEN」）——无赋值形态，无秘密实例'
  },
  {
    path: 'docs/16-Cyrene-前端实施任务清单与进度跟踪.md', anchor: /激活 \+ Bearer \+ 错误映射/,
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
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /Bearer token → Bearer \[REDACTED\]/,
    reason: '内嵌 redact 单测首行（计划文档的代码样例）——假值/散文'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /auth: Bearer abc\.def-ghi_123XYZ/,
    reason: '内嵌 redact 单测样例（与 redact.spec.ts:7 同一假值）——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /key=sk-abc123DEF456ghi789/,
    reason: '内嵌 redact 单测样例——假串，非 SK-API 凭据'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /key=AKIAIOSFODNN7EXAMPLE/,
    reason: 'AWS 官方文档示例 key（公开样例）——假值非真实 Access Key'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /Bearer token 先被长串规则命中/,
    reason: '内嵌 redact.ts 注释（与 redact.ts:3 同源散文）——无真实秘密'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /token: 'Bearer abc\.def-ghi_123XYZ'/,
    reason: '内嵌 logger.spec 样例（与 logger.spec.ts:55 同源假值）——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-09-phase1-trusted-services.md', anchor: /with Bearer abc\.def-ghi_123XYZ/,
    reason: '内嵌 audit.spec 样例（与 audit.spec.ts:29 同源假值）——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-11-phase2-real-backend.md', anchor: /\.toBe\('Bearer sk-test'\)/,
    reason: '内嵌 real-backend.spec 样例（与 spec.ts:87 同源假值）——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-11-phase2-real-backend.md', anchor: /透传 limit\/cursor \+ Bearer \+ 映射/,
    reason: '内嵌 it 标题散文——已人工核对无真实秘密'
  },
  {
    path: 'docs/superpowers/plans/2026-08-11-phase2-real-backend.md', anchor: /\.toBe\('Bearer sk-token'\)/,
    reason: '内嵌 real-backend.spec 样例——假 token'
  },
  {
    path: 'docs/superpowers/plans/2026-08-11-phase2-real-backend.md', anchor: /激活 \+ Bearer \+ 错误映射/,
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
// ── 规则 base64-long-string（LOW① 补齐：redact 第 4 条 40+ 长串）类别级 allowlist ──
// 2026-08-22 全树核对：180 文件 1539 行命中全部为可公开类别（sha512 包哈希 1 文件 / 
// 夹具 schemaHash 14 文件 / 词表·路径长串 165 文件），无真实凭据。
// 注意：类别级锚行为「该文件全部命中行经人工核对的公开类别」——锚取类别特征（比裸长串锚更严，仍可捕获
// 同类文件内失败行列外的新增行）；新文件命中 base64-long-string 无条目 → 违规 fail。
  {
    path: "CLAUDE.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 7 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "README.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/scripts/check-backend-contract.mjs", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/connection/connection-config.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/diagnostics/export-payload.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/diagnostics/sanitize.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-cancelled.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-failed.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-no-delta-inner-voice.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-no-delta-public-reply.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-reconnect-replay.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-replay-nonempty.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-replay-tool.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/chat-tts-public-completed-only.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/handshake.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/legacy-output-compat.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/rejected-ack-empty-messageid.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/rejected-ack-storage-unavailable.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/server-info-full.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/fixtures/wire-v2/state-typing.manifest.json", anchor: /"schemaHash":"[0-9a-f]{40,}"/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为wire-v2 夹具 schemaHash/backendCommit（公开测试数据完整性值，确定性非秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/tools/env-bridge.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/tools/tool-service.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/transport/real-backend.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/windows/README.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/main/windows/navigation.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CyDiagnosticsPane.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CyLive2DPane.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CyLiveToolCards.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CySecurityPane.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CyToolApproval.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/components/CyVoicePane.vue", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/THIRD_PARTY_NOTICES.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/adapter.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/controller.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/gl/fake.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/gl/types.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/gl/webgl.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/mouth-level.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/param-anim.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/perf.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/state-machine.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/state-source.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/live2d/tts-mouth-source.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/stores/live2d.store.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/stores/tool.store.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/renderer/src/stores/voice.store.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/src/shared/schemas/ipc-response.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/integration/ipc-security.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/attachment-media.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/attachment-state.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/attachments-contracts.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/audit.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/chat-service.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/cy-chat-input.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/cy-diagnostics-pane.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/cy-security-pane.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/cy-tool-approval.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/cy-voice-pane.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/desktop-api-chat.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/diagnostics-handlers.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/frame-mapper.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/grant-store.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/history-contracts.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/live2d-adapter2.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/live2d-pane.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/live2d-panel.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/live2d-registry.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/live2d.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/markdown-sanitize.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/param-hash.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/protocol-live2d.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/public-error.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/raw-schemas.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/redact.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/renderer-bootstrap.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/schemas.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/tool-audit.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/tool-public-events.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/tool.store.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/voice-capture.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/voice-contracts.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/voice-handlers.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "apps/desktop/tests/unit/wire-fixtures.spec.ts", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/04-Cyrene-Desktop工具与权限交互设计-v0.2.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/05-Cyrene-Live2D前端接入设计-v0.2.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/11-Cyrene-前端设置中心详细设计.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/14-Cyrene-后端配合改造任务清单-v0.1.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/15-Cyrene-后端改造执行上下文与Prompt-v0.1.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/16-Cyrene-前端实施任务清单与进度跟踪.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 9 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/18-Cyrene-Electron-真实后端契约差异与前端修复清单-2026-08-09.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 24 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-09-阶段1A-loading-env-code-review.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-11-阶段2真实联调前端整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-13-Windows-Electron-二次真实联调前端整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-13-Windows-Electron-首次真实联调前端问题清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-13-首次联调封口问题修复报告.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-14-Windows-Electron-第三次真实联调前端阻断.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段3-联调前整改-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段3真实联调前端复验问题清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 7 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段3真实联调前端整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段3真实联调第二轮前端复验问题清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段3真实联调通过-验收记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-15-阶段4批次A-验收记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-16-阶段4真实联调前端整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-17-阶段4修复后真实联调验收.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-18-阶段5-Live2D前端联调前整改清单.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-18-阶段5批次B-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-18-阶段5批次C-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-19-阶段6-工具双轨统筹决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 14 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-20-阶段6批次A-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-20-阶段6批次B-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-20-阶段6批次C-决策记录.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/review/2026-08-21-阶段6-真实联调验收.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/2026-08-12-phase01-recheck-batchA-final-report.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/2026-08-12-phase2-realconn-batchC-final-report.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-08-phase1-foundation.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-09-phase1-ipc-security-integration.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-09-phase1-loading-env.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-09-phase1-trusted-services.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 11 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-10-phase2-contract-raw-wire.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-11-phase2-real-backend.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-11-phase2-realconn-preparation.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 24 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-11-phase2-store-ui.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-12-phase01-recheck-batchA.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-12-phase01-recheck-batchB.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-12-phase01-recheck-batchD.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-12-phase2-realconn-batchB.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 16 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-12-phase2-realconn-batchC.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-13-realint-fix.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-13-realint2-fix.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 11 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-14-phase3-attachments-media.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 82 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-14-phase3-history-drafts.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 74 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-14-phase3-historyviewer-emoji-a11y.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 71 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-14-phase3-layout-responsive.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 41 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-15-phase3-integration-fixes.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 7 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-15-phase3-rerun2-layout.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-15-phase3-reverify-fixes.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 19 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-15-phase4a-model-services-settings.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-16-phase4-voice-cleanup-fixes.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 10 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-16-phase4b-voice-settings.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 14 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-17-phase5-live2d-batcha-foundation.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 30 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-18-phase5-live2d-batchb-expression.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 27 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-18-phase5-live2d-batchc-closure.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 27 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-20-phase6-tools-batcha-contract-domain.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 18 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-20-phase6-tools-batchb-main-exec-ui.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 22 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-20-phase6-tools-batchc-scoped-grants-admin.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 25 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/plans/2026-08-22-phase7-batcha-security-convergence.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 17 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-08-phase1-foundation-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-09-phase1-trusted-services-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-10-phase2-contract-raw-wire-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-11-phase2-real-backend-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-11-phase2-realconn-preparation-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-12-phase01-recheck-batchA-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-12-phase01-recheck-batchD-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-12-phase2-realconn-batchB-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 4 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-12-phase2-realconn-batchC-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-13-realint-fix-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 1 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-13-realint2-fix-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-14-phase3-attachments-media-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-14-phase3-history-drafts-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-14-phase3-historyviewer-emoji-a11y-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 8 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-14-phase3-layout-responsive-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 2 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-15-phase3-integration-fixes-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 10 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-15-phase3-rerun2-layout-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 6 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-15-phase3-reverify-fixes-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 15 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-15-phase4a-model-services-settings-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 5 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-16-phase4-voice-cleanup-fixes-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 16 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-16-phase4b-voice-settings-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 8 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-17-phase5-live2d-batcha-foundation-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 8 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-18-phase5-live2d-batchb-expression-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-18-phase5-live2d-batchc-closure-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-20-phase6-tools-batcha-contract-domain-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 11 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-20-phase6-tools-batchb-main-exec-ui-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 9 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-20-phase6-tools-batchc-scoped-grants-admin-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 6 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "docs/superpowers/specs/2026-08-22-phase7-batcha-security-convergence-design.md", anchor: /[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 3 行——已人工核对全部为可读词表/路径/标识符长串（英文单词或标识符+斜杠连接的阅读性序列，非高熵秘密）（逐文件核对 2026-08-22）`
  },
  {
    path: "pnpm-lock.yaml", anchor: /sha512-[A-Za-z0-9+/]{40,}/,
    reason: `base64-long-string 命中本文件 557 行——已人工核对全部为npm 包完整性哈希（registry sha512 公开字段，确定性非秘密）（逐文件核对 2026-08-22）`
  },
]

let failed = false
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => { console.error(`✗ ${m}`); failed = true }

const scriptDir = dirname(fileURLToPath(import.meta.url))
let repoRoot
let trackedFiles
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: scriptDir, encoding: 'utf8' }).trim()
  // -z：NUL 分隔原始字节路径（core.quotepath=false 双保险——默认下 CJK 路径被 C 转义加引号）
  trackedFiles = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
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
  const hits = scanSecretsInText(content, SECRET_BLACKLIST)
  if (hits.length === 0) continue
  const entries = allowlistByPath.get(rel) ?? []
  for (const hit of hits) {
    const entry = allowlistEntryFor(entries, hit.text)
    if (entry) {
      firedAllowlist.add(entry)
      // 同一条目可遮蔽同文件同行的另一条目（首匹配语义）——fired 追踪须覆盖「锚匹配该行」的全部条目，
      // 否则精确条目先命中时类别级条目永不触发 → fail-loud 误报（review LOW① 落地实测压坑）
      for (const e of entries) {
        if (e !== entry && e.anchor.test(hit.text)) firedAllowlist.add(e)
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
ok(`扫描 ${scannedCount} 文件（排除 ${excludedCount} 个：third_party/ + vendored live2d 两树 + 扫描器自身）、allowlist 放行 ${allowedCount} 行、黑名单 ${SECRET_BLACKLIST.length} 规则`)
process.exit(0)
