import { randomUUID } from 'node:crypto'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STAGE_H_SCENARIOS = ['preflight', 'preview-validation'] as const
export type StageHScenario = (typeof STAGE_H_SCENARIOS)[number]

/** These adapters are deliberately named before they are implemented in a later stage. */
export const STAGE_H_DEFERRED_SCENARIOS = ['pinned-follow', 'archive-default', 'tail-isolation'] as const

export interface StageHConfig {
  scenario: StageHScenario
  backendUrl: string
  appData: string
  outputDir: string
  evidenceFile: string
  desktopRoot: string
  characterId?: string
  conversationId?: string
  characterInstanceId?: string
  marker: string
  frontendCommit: string
  expectedBackendCommit?: string
  launchTimeoutMs: number
  operationTimeoutMs: number
}

export interface StageHHelp {
  kind: 'help'
  text: string
}

export interface StageHParsedConfig {
  kind: 'config'
  config: StageHConfig
}

export type StageHParseResult = StageHHelp | StageHParsedConfig

export class StageHConfigError extends Error {
  readonly code = 'STAGE_H_CONFIG'
}

const here = resolve(fileURLToPath(import.meta.url), '..')
export const STAGE_H_DESKTOP_ROOT = resolve(here, '../../../..')
export const STAGE_H_REPOSITORY_ROOT = resolve(STAGE_H_DESKTOP_ROOT, '../..')

const USAGE = `用法：
  pnpm --filter @cyrene/desktop integration:stage-h --
    --scenario <preflight|preview-validation>
    --backend-url <url> --app-data <isolated-app-data> --output-dir <evidence-dir>

必填参数也可用环境变量：
  STAGE_H_BACKEND_URL  STAGE_H_APP_DATA  STAGE_H_OUTPUT_DIR

可选参数：
  --evidence-file <name.json>       输出文件名（只允许当前目录文件名）
  --desktop-root <path>             apps/desktop 根目录，默认使用当前仓库
  --character-id <id>               preview-validation 的角色 ID
  --conversation-id <id>            为后续场景预留的会话 ID
  --character-instance-id <id>      为后续场景预留的角色实例 ID
  --marker <opaque-id>              场景唯一标记（ASCII 不透明 ID），默认自动生成
  --frontend-commit <sha>           证据中的前端 commit，默认读取环境变量或 git
  --backend-commit <sha>            期望握手解析出的后端 build SHA（不匹配即失败）
  --launch-timeout-ms <ms>          Electron 启动超时，默认 30000
  --operation-timeout-ms <ms>       场景操作超时，默认 180000
  --help                            显示帮助
  --list-scenarios                  显示当前可运行与后续预留场景

安全约束：runner 只连接操作者已启动的后端，不读取或传递 token 参数，也不启停正式后端。
`

function readValue(argv: readonly string[], index: number, option: string): { value: string; next: number } {
  const raw = argv[index]
  const equals = raw.indexOf('=')
  if (equals >= 0) {
    const value = raw.slice(equals + 1)
    if (!value) throw new StageHConfigError(`${option} 需要非空值`)
    return { value, next: index }
  }
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new StageHConfigError(`${option} 需要非空值`)
  return { value, next: index + 1 }
}

function ensureSingleLine(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new StageHConfigError(`${label} 不能为空或包含控制字符`)
  return trimmed
}

function normalizeBackendUrl(raw: string): string {
  const value = ensureSingleLine(raw, 'backend URL')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new StageHConfigError('backend URL 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StageHConfigError('backend URL 只支持 http 或 https')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new StageHConfigError('backend URL 不得包含 userinfo、query 或 fragment（避免把凭据写入日志）')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function normalizeAbsolutePath(raw: string, label: string): string {
  const value = ensureSingleLine(raw, label)
  if (!isAbsolute(value)) throw new StageHConfigError(`${label} 必须是绝对路径`)
  const path = resolve(value)
  if (path === parse(path).root) throw new StageHConfigError(`${label} 不能是文件系统根目录`)
  return path
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function validateSafeOutputDir(outputDir: string): void {
  const forbidden = resolve(STAGE_H_REPOSITORY_ROOT, 'output', 'playwright')
  if (isInside(outputDir, forbidden)) {
    throw new StageHConfigError('output-dir 不得指向现场 output/playwright 或其子目录')
  }
}

function parsePositiveInt(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StageHConfigError(`${label} 必须是 ${min}..${max} 范围内的整数`)
  }
  return value
}

function parseScenario(raw: string): StageHScenario {
  if ((STAGE_H_SCENARIOS as readonly string[]).includes(raw)) return raw as StageHScenario
  if ((STAGE_H_DEFERRED_SCENARIOS as readonly string[]).includes(raw)) {
    throw new StageHConfigError(`场景 ${raw} 已预留给后续阶段，当前 runner 不会假装执行它`)
  }
  throw new StageHConfigError(`未知场景 ${raw}；可用场景：${STAGE_H_SCENARIOS.join(', ')}`)
}

function normalizeEvidenceFile(raw: string | undefined, scenario: StageHScenario): string {
  const value = raw?.trim() || `stage-h-${scenario}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}.json`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(value)) {
    throw new StageHConfigError('evidence-file 必须是当前输出目录下的 .json 文件名，不得包含路径')
  }
  return value
}

function normalizeMarker(raw: string | undefined): string {
  const value = raw === undefined ? `stage-h-${randomUUID()}` : ensureSingleLine(raw, 'marker')
  // marker 会进入真实请求/回复上下文，只接受不透明、单行、ASCII 标识符；
  // 明确拒绝常见凭据前缀，避免把秘密伪装成测试标记带入证据。
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new StageHConfigError('marker 只能是 1..128 位 ASCII 不透明标识符（字母/数字/._:-）')
  }
  if (/^(?:bearer|basic|sk-|rk-|sess-|eyJ|akia)/iu.test(value)) {
    throw new StageHConfigError('marker 不得使用凭据或授权值的常见前缀')
  }
  return value
}

function parseOpaqueId(raw: string | undefined, label: string): string | undefined {
  if (raw === undefined) return undefined
  const value = ensureSingleLine(raw, label)
  if (value.length > 256 || /[\\/]/u.test(value)) throw new StageHConfigError(`${label} 不是合法的不透明 ID`)
  return value
}

export function usage(): string {
  return USAGE
}

export function listScenarios(): string {
  return [
    `当前可运行：${STAGE_H_SCENARIOS.join(', ')}`,
    `后续预留：${STAGE_H_DEFERRED_SCENARIOS.join(', ')}`,
    '后续 fixture 场景必须由后端提供正式 seed/cleanup 后再接入。'
  ].join('\n')
}

export function parseStageHArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
): StageHParseResult {
  let scenarioRaw: string | undefined
  let backendUrlRaw: string | undefined
  let appDataRaw: string | undefined
  let outputDirRaw: string | undefined
  let evidenceFileRaw: string | undefined
  let desktopRootRaw: string | undefined
  let characterId: string | undefined
  let conversationId: string | undefined
  let characterInstanceId: string | undefined
  let marker: string | undefined
  let frontendCommit: string | undefined
  let expectedBackendCommit: string | undefined
  let launchTimeoutMs = 30_000
  let operationTimeoutMs = 180_000

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { kind: 'help', text: USAGE }
    if (arg === '--list-scenarios') return { kind: 'help', text: listScenarios() }
    if (!arg.startsWith('--')) throw new StageHConfigError(`无法识别的位置参数：${arg}`)

    const option = arg.split('=', 1)[0]
    const parsed = readValue(argv, index, option)
    index = parsed.next
    switch (option) {
      case '--scenario': scenarioRaw = parsed.value; break
      case '--backend-url': backendUrlRaw = parsed.value; break
      case '--app-data': appDataRaw = parsed.value; break
      case '--output-dir': outputDirRaw = parsed.value; break
      case '--evidence-file': evidenceFileRaw = parsed.value; break
      case '--desktop-root': desktopRootRaw = parsed.value; break
      case '--character-id': characterId = parsed.value; break
      case '--conversation-id': conversationId = parsed.value; break
      case '--character-instance-id': characterInstanceId = parsed.value; break
      case '--marker': marker = parsed.value; break
      case '--frontend-commit': frontendCommit = parsed.value; break
      case '--backend-commit': expectedBackendCommit = parsed.value; break
      case '--launch-timeout-ms': launchTimeoutMs = parsePositiveInt(parsed.value, option, 5_000, 180_000); break
      case '--operation-timeout-ms': operationTimeoutMs = parsePositiveInt(parsed.value, option, 5_000, 900_000); break
      default: throw new StageHConfigError(`未知选项：${option}`)
    }
  }

  const scenario = parseScenario(ensureSingleLine(scenarioRaw ?? '', '--scenario'))
  const backendUrl = normalizeBackendUrl(backendUrlRaw ?? env.STAGE_H_BACKEND_URL ?? '')
  const appData = normalizeAbsolutePath(appDataRaw ?? env.STAGE_H_APP_DATA ?? '', 'app-data')
  const outputDir = normalizeAbsolutePath(outputDirRaw ?? env.STAGE_H_OUTPUT_DIR ?? '', 'output-dir')
  validateSafeOutputDir(outputDir)
  if (isInside(outputDir, appData) || isInside(appData, outputDir)) {
    throw new StageHConfigError('app-data 与 output-dir 必须是互不包含的目录')
  }

  const desktopRoot = desktopRootRaw
    ? normalizeAbsolutePath(desktopRootRaw, 'desktop-root')
    : STAGE_H_DESKTOP_ROOT
  const safeMarker = normalizeMarker(marker)

  return {
    kind: 'config',
    config: {
      scenario,
      backendUrl,
      appData,
      outputDir,
      evidenceFile: normalizeEvidenceFile(evidenceFileRaw, scenario),
      desktopRoot,
      characterId: parseOpaqueId(characterId, 'character-id'),
      conversationId: parseOpaqueId(conversationId, 'conversation-id'),
      characterInstanceId: parseOpaqueId(characterInstanceId, 'character-instance-id'),
      marker: safeMarker,
      frontendCommit: ensureSingleLine(frontendCommit ?? env.STAGE_H_FRONTEND_COMMIT ?? 'unknown', 'frontend-commit'),
      expectedBackendCommit: expectedBackendCommit === undefined && env.STAGE_H_BACKEND_COMMIT
        ? ensureSingleLine(env.STAGE_H_BACKEND_COMMIT, 'backend-commit')
        : expectedBackendCommit === undefined ? undefined : ensureSingleLine(expectedBackendCommit, 'backend-commit'),
      launchTimeoutMs,
      operationTimeoutMs
    }
  }
}

export function evidencePath(config: StageHConfig): string {
  return join(config.outputDir, config.evidenceFile)
}
