// tests/unit/check-contract-gate.spec.ts
// 门禁判别力批次（P1-4 / L-02 + M-40）：**测门禁本身**——`pnpm check:contract` 的退出码语义。
//
// 为什么需要它：`check:contract` 是全仓唯一跨仓契约门禁，而它有两个历史缺陷：
//   ① 2026-09-10 之前"后端未挂载"直接 `exit 0`，「没检查」与「检查通过」在门禁语义上完全等价；
//   ② 即便修好①（改为 exit 2），仍有三条**部分验证**路径 exit 0——`rest.py` 缺失时静默跳过整个 REST 半段、
//      没有 `ws-v2-*.jsonl` 时字段级比对退化为两条合成探针、目录在但来源文件都缺时抛栈。
//   ② 就是本轮修的 L-02。修法（逐段记账：已核对进 verified / 未核对进 unverified，最终 unverified 非空即 exit 2）
//   必须由测试钉住，否则下次有人重排打印顺序就会把"未核对"重新读成"通过"。
//
// 本 spec 用**合成后端目录**驱动脚本，因此不需要真实后端即可在 CI 里跑——这正是 M-40
// （"CI 不跑 check:contract"）在无后端环境下的可执行解法：验的不是"后端一致"，而是
// "门禁不会把未核对说成通过，也不会把一致说成不一致"。
//
// 判别力双向都要有："永远红"与"永远绿"一样没有保护意义（本仓库已为此付出过代价：ipc-security
// 的暴露面白名单曾长期停在 91 键，唯一哨兵长期红灯 → 任何真实扩张都被同一个红灯掩盖）。
// 故下面既有"应 exit 2"的用例，也有**必须 exit 0**的最小完整夹具用例，以及"不一致必须 exit 1"的用例。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as restSchemas from '../../src/main/transport/protocol-v2/rest-schemas'

const execFileP = promisify(execFile)

const SCRIPT = fileURLToPath(new URL('../../scripts/check-backend-contract.mjs', import.meta.url))
const NODE_ARGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', SCRIPT]
const FIXTURES = fileURLToPath(new URL('../../src/main/fixtures/wire-v2', import.meta.url))

interface RunResult { code: number; stdout: string; stderr: string }

/** 按真实 `check:contract` 的入口跑脚本；两个目录环境变量一律显式设定，避免宿主环境污染判据 */
async function runContract(opts: { contractDir: string; tracesDir?: string }): Promise<RunResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env['CYRENE_FRONTEND_CONTRACT_DIR'] = opts.contractDir
  // 未显式给出 traces 时指向一个**不存在**的目录：否则会落到脚本内置的 Linux 默认路径，
  // 在开发机上恰好存在与否将改变判据（不可复现的测试比没有测试更糟）
  env['CYRENE_FRONTEND_CONTRACT_TRACES'] = opts.tracesDir ?? join(opts.contractDir, '__no_traces__')
  try {
    const { stdout, stderr } = await execFileP(process.execPath, NODE_ARGS, { env, timeout: 120_000 })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 最小判别联合：mapping 键即后端声明的帧 type（脚本取与 WS_V2 白名单交集最大的那个 union） */
function schemaJson(types: string[]): string {
  return JSON.stringify({
    models: {
      ServerMessage: {
        discriminator: {
          propertyName: 'type',
          mapping: Object.fromEntries(types.map((t) => [t, `#/models/${t.replace(/[.]/g, '_')}`]))
        },
        properties: {}
      },
      // ErrorMessage/RejectedUserAckMessage 的 properties 空 → 合成探针少走两条，但不影响本 spec 的判据
      ErrorMessage: { properties: {} },
      RejectedUserAckMessage: { properties: {} },
      AckError: { properties: {} }
    }
  }, null, 2)
}

/**
 * 从**前端自己的 zod schema** 生成一份"与前端完全一致"的最小 rest.py。
 * 每个后端模型只声明前端已知的字段且全部 Optional⇒必填性检查必然通过；Role 枚举取自前端 role 枚举。
 * 这样用例 ④ 证明的是「一致的输入确实得到 exit 0」，而不是在断言一组我手抄的字面量。
 */
function restPy(): string {
  const models: Array<[string, Record<string, unknown>]> = [
    ['SearchMessageItem', restSchemas.RestSearchMessageItemSchema.shape],
    ['SearchMessagesResponse', restSchemas.RestSearchMessagesResponseSchema.shape],
    ['MessageContextResponse', restSchemas.RestMessageContextResponseSchema.shape],
    ['AttachmentUploadResponse', restSchemas.RestAttachmentUploadResponseSchema.shape],
    ['AttachmentSignResponse', restSchemas.RestAttachmentSignResponseSchema.shape],
    ['StickerEntry', restSchemas.RestStickerItemSchema.shape],
    ['StickerListResponse', restSchemas.RestStickerListResponseSchema.shape],
    ['ProviderEntry', restSchemas.ProviderEntryWireSchema.shape],
    ['CustomProvider', restSchemas.CustomProviderWireSchema.shape],
    ['ProvidersResponse', restSchemas.ProvidersResponseWireSchema.shape],
    ['ProviderTestResult', restSchemas.ProviderTestResultWireSchema.shape],
    ['TtsVoiceEntry', restSchemas.TtsVoiceEntryWireSchema.shape],
    ['TtsVoicesResponse', restSchemas.TtsVoicesResponseWireSchema.shape],
    ['TtsPreviewResult', restSchemas.TtsPreviewResultWireSchema.shape],
    ['DesktopCallStatus', restSchemas.DesktopCallStatusSchema.shape]
  ]
  // AttachmentInfo 走 ['…','shape','attachments','element'] 下钻
  const attachments = (restSchemas.RestAttachmentUploadResponseSchema.shape as { attachments?: { element?: { shape?: Record<string, unknown> } } }).attachments
  models.splice(3, 0, ['AttachmentInfo', attachments?.element?.shape ?? {}])

  const blocks = models.map(([name, shape]) => {
    const fields = Object.keys(shape).map((k) => `    ${k}: Optional[str] = None`).join('\n')
    return `class ${name}(BaseModel):\n${fields || '    pass'}`
  })

  const roleInner = (restSchemas.RestSearchMessageItemSchema.shape as { role?: { _def?: { innerType?: { options?: string[] } } } }).role
  const roles = roleInner?._def?.innerType?.options ?? []
  const roleBlock = `class Role(StrEnum):\n${roles.map((r) => `    ${r} = "${r}"`).join('\n')}`

  return `from enum import StrEnum\nfrom typing import Optional\n\n${roleBlock}\n\n${blocks.join('\n\n')}\n`
}

/** 把仓库既有的、已通过 wire-fixtures 校验的真实后端帧改名成脚本认的 `ws-v2-*.jsonl` */
function seedTraces(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ws-v2-gate-min.jsonl'), '')
  for (const name of ['server-info-full.jsonl', 'state-typing.jsonl']) {
    appendFileSync(join(dir, 'ws-v2-gate-min.jsonl'), readFileSync(join(FIXTURES, name), 'utf8'))
  }
}

const GATE_TYPES = ['server_info', 'state', 'typing']

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'cy-contract-gate-')) })
afterAll(() => { if (root) { try { rmSync(root, { recursive: true, force: true }) } catch { /* 尽力 */ } } })

describe('check:contract 门禁语义（L-02 / M-40）', () => {
  it('① 后端目录不存在 → exit 2 且明写 NOT VERIFIED（不是 0）', async () => {
    const res = await runContract({ contractDir: join(root, 'absent-backend') })
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(2)
    expect(res.stderr).toContain('NOT VERIFIED')
  })

  it('② 目录在但两个来源文件都缺 → exit 2 且原因是可读的缺文件（不是崩溃栈）', async () => {
    const dir = join(root, 'empty-backend')
    mkdirSync(dir, { recursive: true })
    const res = await runContract({ contractDir: dir })
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(2)
    expect(res.stderr).toContain('NOT VERIFIED')
    // 可读性：必须点名缺的是哪两个文件，而不是抛出一段 ENOENT 栈（修复前正是后者）
    expect(res.stderr).toContain('contract.schema.json')
    expect(res.stderr).toContain('ws_message.py')
    expect(res.stderr).not.toContain('at Object.<anonymous>')
  })

  it('③ 只有 contract.schema.json → REST 段与字段级帧段**都被点名**为未核对（L-02 的两条修复点）', async () => {
    const dir = join(root, 'partial-backend')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'contract.schema.json'), schemaJson(GATE_TYPES))
    const res = await runContract({ contractDir: dir })
    // 修复前：这条路径 exit 0（REST 静默跳过 + 合成探针补够 checkedFrames）
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(2)
    expect(res.stderr).toContain('NOT VERIFIED')
    expect(res.stderr).toContain('REST 段')          // 未核对的第一个半段必须点名
    expect(res.stderr).toContain('ws-v2-*.jsonl')    // 未核对的字段级来源必须点名
    expect(res.stderr).toContain('已核对 1 段、未核对 2 段')
  })

  it('④ 最小完整夹具（schema + traces + rest.py）→ exit 0 且逐段列出已核对内容（门禁不是恒红）', async () => {
    const dir = join(root, 'complete-backend')
    const traces = join(root, 'complete-backend-traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'contract.schema.json'), schemaJson(GATE_TYPES))
    writeFileSync(join(dir, 'rest.py'), restPy())
    seedTraces(traces)
    const res = await runContract({ contractDir: dir, tracesDir: traces })
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(0)
    expect(res.stderr).not.toContain('NOT VERIFIED')
    // 三段的"通过了什么"必须可读，而不是只有一句 exit 0
    expect(res.stdout).toContain('核对结论')
    expect(res.stdout).toContain('WS v2 帧 type 覆盖')
    expect(res.stdout).toContain('字段级帧深度比对')
    expect(res.stdout).toContain('REST 段')
    expect(res.stdout).toMatch(/ws-v2-gate-min\.jsonl|条帧解析后与输入逐字段相等/)
  })

  it('⑤ 契约帧出现前端 schema 不认的字段（字段漂移）→ exit 1（不一致必须红灯，不能算未核对）', async () => {
    const dir = join(root, 'drift-backend')
    const traces = join(root, 'drift-backend-traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'contract.schema.json'), schemaJson(GATE_TYPES))
    writeFileSync(join(dir, 'rest.py'), restPy())
    seedTraces(traces)
    // 往真实帧里塞一个前端 raw schema 未声明的字段：无论 schema 是 strict 拒绝还是静默 strip，
    // 都与"解析结果与输入逐字段相等"冲突 → 必须 exit 1（而不是 exit 2 的"未核对"）
    const file = join(traces, 'ws-v2-gate-min.jsonl')
    const first = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]) as Record<string, unknown>
    first['__gate_drift_probe__'] = 'unknown-field'
    writeFileSync(file, JSON.stringify(first) + '\n' + readFileSync(file, 'utf8').split('\n').slice(1).join('\n'))
    const res = await runContract({ contractDir: dir, tracesDir: traces })
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(1)
    expect(res.stderr).toMatch(/字段漂移|拒绝/)
  })

  it('⑥ 脚本自身仍是"有后端就真比对"：后端模型多出前端不认识的字段 → exit 1', async () => {
    const dir = join(root, 'rest-unknown-field')
    const traces = join(root, 'rest-unknown-field-traces')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'contract.schema.json'), schemaJson(GATE_TYPES))
    seedTraces(traces)
    // REST 段的比对方向是「后端字段 ⊆ 前端 schema 键」——故要让后端多声明一个前端没有的字段才会失败。
    // 这条用例防的是"REST 段被写空"：若有人把比对循环删掉/改成恒真，前五条仍会全绿，只有这条会红。
    // 注意字段名**不能以下划线开头**：脚本的 parseModelFields 会跳过 `_` 前缀（Python 私有/内部约定），
    // 用 `__probe__` 之类的名字会被静默忽略而得到假绿（本轮第一版就是这么写的，实测 0 失败）。
    const py = restPy().replace(
      'class SearchMessageItem(BaseModel):\n',
      'class SearchMessageItem(BaseModel):\n    gateUnknownField: Optional[str] = None\n'
    )
    writeFileSync(join(dir, 'rest.py'), py)
    const res = await runContract({ contractDir: dir, tracesDir: traces })
    expect(res.code, `stdout=${res.stdout}\nstderr=${res.stderr}`).toBe(1)
    expect(res.stderr).toContain('SearchMessageItem')
    expect(res.stderr).toContain('gateUnknownField')
  })
})
