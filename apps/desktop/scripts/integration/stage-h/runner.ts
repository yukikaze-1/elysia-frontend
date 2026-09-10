import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { assertChecks, backendBuildShaMatches, buildEvidence, CleanupStack, writeEvidence } from './lib/evidence.ts'
import { closeStageHElectron, launchStageHElectron } from './lib/electron.ts'
import { evidencePath, parseStageHArgs, STAGE_H_REPOSITORY_ROOT, StageHConfigError, usage } from './lib/config.ts'
import { safeError } from './lib/redact.ts'
import { scenarioRunners } from './scenarios/index.ts'
import type { StageHEvidenceInput } from './lib/evidence.ts'

function detectFrontendCommit(configValue: string): string {
  if (configValue !== 'unknown') return configValue
  try {
    const value = execFileSync('git', ['-C', STAGE_H_REPOSITORY_ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return value || 'unknown'
  } catch {
    return 'unknown'
  }
}

function parseBuildSha(serverVersion: unknown): string | undefined {
  if (typeof serverVersion !== 'string') return undefined
  const plus = serverVersion.lastIndexOf('+')
  return plus >= 0 && plus < serverVersion.length - 1 ? serverVersion.slice(plus + 1) : undefined
}

async function readBackendMetadata(page: Page): Promise<StageHEvidenceInput['backend']> {
  try {
    const connection = await page.evaluate(async () => window.desktopApi.getConnectionState()) as Record<string, unknown>
    return {
      url: typeof connection.serverUrl === 'string' ? connection.serverUrl : undefined,
      protocolVersion: typeof connection.protocolVersion === 'string' ? connection.protocolVersion : undefined,
      serverVersion: typeof connection.serverVersion === 'string' ? connection.serverVersion : undefined,
      buildSha: parseBuildSha(connection.serverVersion)
    }
  } catch {
    return {}
  }
}

function mergeBackendMetadata(
  current: StageHEvidenceInput['backend'],
  observed: Partial<StageHEvidenceInput['backend']> | undefined
): StageHEvidenceInput['backend'] {
  if (!observed) return current
  // Undefined fields from a scenario must not erase metadata obtained during
  // the handshake.  In particular, an expectation is never an observation.
  const defined = Object.fromEntries(Object.entries(observed).filter(([, value]) => value !== undefined))
  return { ...current, ...defined }
}

export async function runStageH(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let parsed
  try {
    parsed = parseStageHArgs(argv)
  } catch (cause) {
    const message = cause instanceof StageHConfigError ? cause.message : String(cause)
    process.stderr.write(`Stage H 参数错误：${message}\n\n${usage()}`)
    return 2
  }
  if (parsed.kind === 'help') {
    process.stdout.write(`${parsed.text}\n`)
    return 0
  }

  const config = parsed.config
  const startedAt = new Date().toISOString()
  const cleanup = new CleanupStack()
  let session
  let result
  let executionError: unknown
  let cleanupErrors: unknown[] = []
  let backend: StageHEvidenceInput['backend'] = config.expectedBackendCommit === undefined
    ? {}
    : { expectedBuildSha: config.expectedBackendCommit }

  try {
    session = await launchStageHElectron(config)
    cleanup.add('Electron application', () => closeStageHElectron(session))
    backend = mergeBackendMetadata(backend, await readBackendMetadata(session.page))
    const scenario = scenarioRunners[config.scenario]
    if (!scenario) throw new Error(`场景 ${config.scenario} 没有 runner 实现`)
    result = await scenario({ config, page: session.page })
    backend = mergeBackendMetadata(backend, result.backend)
    if (config.expectedBackendCommit !== undefined) {
      result = {
        ...result,
        checks: {
          ...result.checks,
          backendBuildShaMatches: backendBuildShaMatches(backend.buildSha, config.expectedBackendCommit)
        }
      }
    }
    assertChecks(result.checks)
  } catch (cause) {
    executionError = cause
  } finally {
    try {
      await cleanup.dispose()
    } catch (cause) {
      cleanupErrors = [cause]
    }
  }

  const endedAt = new Date().toISOString()
  const checks = {
    ...(result?.checks ?? { runnerCompleted: false }),
    ...(config.expectedBackendCommit === undefined || result !== undefined
      ? {}
      : { backendBuildShaMatches: backendBuildShaMatches(backend.buildSha, config.expectedBackendCommit) })
  }
  const evidence = buildEvidence({
    scenario: config.scenario,
    startedAt,
    endedAt,
    frontendCommit: detectFrontendCommit(config.frontendCommit),
    backend,
    checks,
    details: result?.details,
    error: executionError,
    cleanupErrors
  }, [config.appData, config.outputDir, config.desktopRoot], [config.marker])

  try {
    await writeEvidence(evidencePath(config), evidence)
  } catch (cause) {
    process.stderr.write(`Stage H 证据写入失败：${safeError(cause, [config.appData, config.outputDir, config.desktopRoot], [config.marker]).message}\n`)
    return 1
  }

  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  return evidence.passed ? 0 : 1
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStageH()
}
