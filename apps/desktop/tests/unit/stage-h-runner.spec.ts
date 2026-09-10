import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeStageHAppData, isTestModeBuild } from '../../scripts/integration/stage-h/lib/electron'
import { assertChecks, backendBuildShaMatches, buildEvidence, CleanupStack } from '../../scripts/integration/stage-h/lib/evidence'
import { generationConversationId, generationTerminalFor } from '../../scripts/integration/stage-h/lib/generation'
import { parseStageHArgs, STAGE_H_DESKTOP_ROOT, STAGE_H_REPOSITORY_ROOT } from '../../scripts/integration/stage-h/lib/config'
import { redactForEvidence, redactText } from '../../scripts/integration/stage-h/lib/redact'

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url))
// Deliberately derive these paths from the test file, independently of the
// runner constants.  This prevents a broken repository-root constant from
// making the output/playwright protection test pass for the wrong directory.
const REAL_REPOSITORY_ROOT = resolve(TEST_FILE_DIR, '../../../..')
const REAL_DESKTOP_ROOT = resolve(REAL_REPOSITORY_ROOT, 'apps', 'desktop')
const TEST_APP_DATA = resolve(tmpdir(), 'cyrene-stage-h-ud')
const TEST_OUTPUT_DIR = resolve(tmpdir(), 'cyrene-stage-h-evidence')

const args = [
  '--scenario', 'preflight',
  '--backend-url', 'http://127.0.0.1:8765',
  '--app-data', TEST_APP_DATA,
  '--output-dir', TEST_OUTPUT_DIR,
  '--marker', 'stage-h-unit-marker'
]

describe('Stage H real runner foundation', () => {
  it('requires explicit scenario, backend URL, isolated appData and output directory', () => {
    const parsed = parseStageHArgs(args, {})
    expect(parsed.kind).toBe('config')
    if (parsed.kind === 'config') {
      expect(parsed.config.scenario).toBe('preflight')
      expect(parsed.config.backendUrl).toBe('http://127.0.0.1:8765')
      expect(parsed.config.appData).toBe(TEST_APP_DATA)
      expect(parsed.config.outputDir).toBe(TEST_OUTPUT_DIR)
    }
    const withExpected = parseStageHArgs([...args, '--backend-commit', 'expected-sha'], {})
    expect(withExpected.kind).toBe('config')
    if (withExpected.kind === 'config') expect(withExpected.config.expectedBackendCommit).toBe('expected-sha')
    expect(() => parseStageHArgs(args.filter((arg) => arg !== '--output-dir' && arg !== TEST_OUTPUT_DIR), {})).toThrow(/output-dir/u)
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'https://example.test/?token=leak',
      '--app-data', resolve(tmpdir(), 'ud'), '--output-dir', resolve(tmpdir(), 'evidence')
    ], {})).toThrow(/query/u)
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'http://127.0.0.1:8765',
      '--app-data', TEST_APP_DATA, '--output-dir', TEST_OUTPUT_DIR, '--marker', 'free text'
    ], {})).toThrow(/ASCII/u)
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'http://127.0.0.1:8765',
      '--app-data', TEST_APP_DATA, '--output-dir', TEST_OUTPUT_DIR, '--marker', 'sk-secret-marker'
    ], {})).toThrow(/凭据/u)
  })

  it('derives the repository root independently and protects the现场 output/playwright evidence directory', () => {
    expect(STAGE_H_DESKTOP_ROOT).toBe(REAL_DESKTOP_ROOT)
    expect(STAGE_H_REPOSITORY_ROOT).toBe(REAL_REPOSITORY_ROOT)
    const forbiddenOutput = join(REAL_REPOSITORY_ROOT, 'output', 'playwright', 'new')
    expect(() => parseStageHArgs([
      '--scenario', 'preflight', '--backend-url', 'http://127.0.0.1:8765',
      '--app-data', resolve(tmpdir(), 'ud'), '--output-dir', forbiddenOutput
    ], {})).toThrow(/output\/playwright/u)
  })

  it('requires a pre-existing real appData child of the system temp directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cyrene-stage-h-appdata-'))
    const valid = join(parent, 'isolated')
    mkdirSync(valid)
    try {
      expect(() => assertSafeStageHAppData(valid)).not.toThrow()
      expect(() => assertSafeStageHAppData(join(parent, 'missing'))).toThrow(/已预先创建/u)
      expect(() => assertSafeStageHAppData(tmpdir())).toThrow(/独立子目录/u)

      if (process.platform !== 'win32') {
        const link = join(parent, 'link')
        symlinkSync(valid, link, 'dir')
        expect(() => assertSafeStageHAppData(link)).toThrow(/非符号链接/u)
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('accepts only a test-mode Electron build for the real runner', () => {
    expect(isTestModeBuild('applyTestAppDataOverride("test");')).toBe(true)
    expect(isTestModeBuild('applyTestAppDataOverride("production");')).toBe(false)
    expect(isTestModeBuild('applyTestAppDataOverride("development");')).toBe(false)
  })

  it('redacts bearer tokens, paths and opaque IDs from evidence', () => {
    const fakeToken = ['sk', 'should-never-appear'].join('-')
    const fakeRoot = resolve(tmpdir(), 'stage-h-secret')
    const raw = `Bearer ${fakeToken} at ${join(fakeRoot, 'file.txt')}`
    expect(redactText(raw, [fakeRoot])).not.toContain('should-never-appear')
    const redacted = redactForEvidence({
      token: fakeToken,
      appData: join(fakeRoot, 'secret'),
      conversationId: 'conv-sensitive',
      marker: 'stage-h-sensitive'
    }, { roots: [fakeRoot] }) as Record<string, unknown>
    expect(JSON.stringify(redacted)).not.toContain('should-never-appear')
    expect(JSON.stringify(redacted)).not.toContain('conv-sensitive')
    expect(redacted.appData).toBe('<path>')
    expect(String(redacted.conversationId)).toMatch(/^id:/u)
  })

  it('redacts a marker even when a backend echoes it in details, errors, or cleanup failures', () => {
    const marker = 'stage-h-echo-marker'
    expect(redactText(`reply=${marker}`, [], [marker])).not.toContain(marker)
    const evidence = buildEvidence({
      scenario: 'preflight',
      startedAt: '2026-09-10T00:00:00.000Z',
      endedAt: '2026-09-10T00:00:01.000Z',
      frontendCommit: 'abc1234',
      backend: { serverVersion: '0.1.0+def5678' },
      checks: { runnerCompleted: false },
      details: { reply: `backend echoed ${marker}` },
      error: new Error(`request failed after echoing ${marker}`),
      cleanupErrors: [new Error(`cleanup saw ${marker}`)]
    }, [], [marker])
    expect(JSON.stringify(evidence)).not.toContain(marker)
  })

  it('treats --backend-commit as an expectation and preserves the observed SHA on mismatch', () => {
    const actual = 'runtime-sha'
    const expected = 'expected-sha'
    expect(backendBuildShaMatches(actual, expected)).toBe(false)
    expect(backendBuildShaMatches(actual, actual)).toBe(true)
    expect(backendBuildShaMatches(undefined, expected)).toBe(false)
    expect(backendBuildShaMatches(actual, undefined)).toBe(true)
    expect(() => assertChecks({ backendBuildShaMatches: backendBuildShaMatches(actual, expected) })).toThrow(/backendBuildShaMatches/u)

    const evidence = buildEvidence({
      scenario: 'preflight',
      startedAt: '2026-09-10T00:00:00.000Z',
      endedAt: '2026-09-10T00:00:01.000Z',
      frontendCommit: 'abc1234',
      backend: { buildSha: actual, expectedBuildSha: expected },
      checks: { backendBuildShaMatches: false }
    })
    expect(evidence.passed).toBe(false)
    expect(evidence.backend.buildSha).toBe(actual)
    expect(evidence.backend.expectedBuildSha).toBe(expected)
  })

  it('marks assertion failures as failures instead of allowing a green exit', () => {
    expect(() => assertChecks({ first: true, second: false })).toThrow(/second/u)
    expect(() => assertChecks({ first: true })).not.toThrow()
    const evidence = buildEvidence({
      scenario: 'preflight',
      startedAt: '2026-09-10T00:00:00.000Z',
      endedAt: '2026-09-10T00:00:01.000Z',
      frontendCommit: 'abc1234',
      backend: { serverVersion: '0.1.0+def5678' },
      checks: { first: true, second: false },
      error: new Error('check failed')
    })
    expect(evidence.passed).toBe(false)
  })

  it('runs every cleanup callback in reverse order and reports cleanup failures', async () => {
    const order: string[] = []
    const stack = new CleanupStack()
    stack.add('first', () => { order.push('first') })
    stack.add('second', () => { order.push('second') })
    await stack.dispose()
    expect(order).toEqual(['second', 'first'])

    const failing = new CleanupStack()
    failing.add('ok', () => { order.push('ok') })
    failing.add('bad', () => { throw new Error('close failed') })
    await expect(failing.dispose()).rejects.toThrow(/cleanup failed/u)
    expect(order.at(-1)).toBe('ok')
  })

  it('correlates a terminal event by generationId even when conversationId is absent', () => {
    const events = [
      { event: 'generation.started', generationId: 'gen-a', conversationId: 'conv-a' },
      { event: 'generation.started', generationId: 'gen-b', conversationId: 'conv-b' },
      { event: 'generation.completed', generationId: 'gen-a' },
      { event: 'generation.completed', generationId: 'gen-b' }
    ]
    expect(generationTerminalFor(events, 'gen-a')?.event).toBe('generation.completed')
    expect(generationConversationId(events, 'gen-a')).toBe('conv-a')
    expect(generationConversationId(events, 'gen-b')).toBe('conv-b')
  })
})
